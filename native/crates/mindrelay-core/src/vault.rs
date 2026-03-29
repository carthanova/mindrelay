use std::fs;
use std::path::{Path, PathBuf};

use directories::{ProjectDirs, UserDirs};
use serde::{Deserialize, Serialize};

use crate::models::Transcript;

const VAULT_VERSION: u32 = 1;

// ─── Error type ───────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct VaultError(pub String);

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "vault error: {}", self.0)
    }
}

impl std::error::Error for VaultError {}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError(e.to_string())
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(e: serde_json::Error) -> Self {
        VaultError(e.to_string())
    }
}

// ─── Metadata structs ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct VaultConfig {
    version: u32,
    created_at_ms: i64,
}

#[derive(Serialize, Deserialize)]
struct VaultState {
    version: u32,
    record_count: usize,
    last_updated_ms: i64,
}

/// User-facing settings stored at `<vault_root>/settings.json`.
/// Distinct from the internal `.mindrelay/config.json` which tracks version
/// metadata and is not meant to be edited by the user.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultSettings {
    pub version: u32,
    /// Display name shown in the app header. Defaults to the folder name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_name: Option<String>,
}

impl Default for VaultSettings {
    fn default() -> Self {
        Self { version: 1, vault_name: None }
    }
}

// ─── Vault ────────────────────────────────────────────────────────────────────

pub struct Vault {
    pub records_dir: PathBuf,
    /// `<vault_root>/settings.json` — user-editable configuration.
    pub settings_path: PathBuf,
    state_path: PathBuf,
    config_path: PathBuf,
}

impl Vault {
    /// Open the vault at `~/Documents/MindRelayVault/`.
    pub fn open_default() -> Result<Self, VaultError> {
        Self::open(default_vault_path())
    }

    /// Open (or create) a vault at `base`.
    ///
    /// Creates on first call (idempotent thereafter):
    ///   `base/records/`            — transcript JSON files
    ///   `base/data/events/`        — raw timestamped captures / metrics
    ///   `base/data/alerts/`        — enriched alerts with context
    ///   `base/memorymesh/`         — graph nodes/edges (nodes.json, edges.json)
    ///   `base/history/`            — daily snapshots / summaries
    ///   `base/.mindrelay/logs/`    — internal logs
    ///   `base/.mindrelay/config.json`  — internal version metadata (first run only)
    ///   `base/settings.json`       — user-editable config (first run only)
    pub fn open(base: PathBuf) -> Result<Self, VaultError> {
        let records_dir = base.join("records");
        let meta_dir = base.join(".mindrelay");

        // Core directories (existing)
        fs::create_dir_all(&records_dir)?;
        fs::create_dir_all(meta_dir.join("logs"))?;

        // Vault structure directories (new)
        fs::create_dir_all(base.join("data").join("events"))?;
        fs::create_dir_all(base.join("data").join("alerts"))?;
        fs::create_dir_all(base.join("memorymesh"))?;
        fs::create_dir_all(base.join("history"))?;

        let state_path = meta_dir.join("state.json");
        let config_path = meta_dir.join("config.json");
        let settings_path = base.join("settings.json");

        let vault = Self { records_dir, settings_path, state_path, config_path };
        vault.ensure_config()?;
        vault.ensure_settings()?;
        Ok(vault)
    }

    // ─── Mutations ────────────────────────────────────────────────────────────

    /// Write a transcript atomically. Overwrites if the ID already exists.
    pub fn put(&self, t: &Transcript) -> Result<(), VaultError> {
        let path = self.record_path(&t.id);
        atomic_write(&path, &serde_json::to_vec_pretty(t)?)?;
        self.sync_state()
    }

    /// Write every transcript that does not already have a vault file.
    ///
    /// Skips transcripts whose `records/<safe_id>.json` already exists so this
    /// is safe to call on every startup. Returns the number of files written.
    pub fn sync_missing(&self, transcripts: &[Transcript]) -> Result<usize, VaultError> {
        let mut written = 0usize;
        for t in transcripts {
            let path = self.record_path(&t.id);
            if !path.exists() {
                self.put(t)?;
                written += 1;
            }
        }
        Ok(written)
    }

    /// Delete a transcript by ID. No-op if the file does not exist.
    pub fn delete(&self, id: &str) -> Result<(), VaultError> {
        let path = self.record_path(id);
        if path.exists() {
            fs::remove_file(&path)?;
        }
        self.sync_state()
    }

    /// Delete all records whose `source` field matches. Skips unreadable files.
    pub fn delete_by_source(&self, source: &str) -> Result<(), VaultError> {
        for entry in fs::read_dir(&self.records_dir)? {
            let path = entry?.path();
            if !is_json(&path) {
                continue;
            }
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(t) = serde_json::from_slice::<Transcript>(&bytes) {
                    if t.source == source {
                        fs::remove_file(&path)?;
                    }
                }
            }
        }
        self.sync_state()
    }

    /// Copy the entire vault directory tree to `dest`.
    ///
    /// `dest` must not already exist. On success the caller receives a full
    /// copy of `records/`, `data/`, `memorymesh/`, `history/`, `.mindrelay/`,
    /// and `settings.json` — everything needed to restore from backup.
    ///
    /// Returns `Err` if `dest` already exists, to prevent silently merging
    /// data into an existing backup.
    pub fn backup(&self, dest: &std::path::Path) -> Result<(), VaultError> {
        if dest.exists() {
            return Err(VaultError(format!(
                "backup destination already exists: {}",
                dest.display()
            )));
        }
        let base = self
            .records_dir
            .parent()
            .ok_or_else(|| VaultError("cannot determine vault root from records_dir".into()))?;
        // Prevent infinite recursion if dest is inside the vault tree being copied.
        if dest.starts_with(base) {
            return Err(VaultError(format!(
                "backup destination {} must not be inside the vault {}",
                dest.display(),
                base.display()
            )));
        }
        copy_dir_all(base, dest)
    }

    /// Delete every record file. Leaves config/state/logs intact.
    pub fn clear(&self) -> Result<(), VaultError> {
        for entry in fs::read_dir(&self.records_dir)? {
            let path = entry?.path();
            if is_json(&path) {
                fs::remove_file(&path)?;
            }
        }
        self.sync_state()
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    /// Path for a transcript file, with ID sanitized to be filesystem-safe.
    fn record_path(&self, id: &str) -> PathBuf {
        let safe: String = id
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        self.records_dir.join(format!("{}.json", safe))
    }

    // ─── User settings ────────────────────────────────────────────────────────

    /// Read `settings.json`. Returns defaults if the file is missing or unreadable.
    pub fn read_settings(&self) -> Result<VaultSettings, VaultError> {
        if !self.settings_path.exists() {
            return Ok(VaultSettings::default());
        }
        let bytes = fs::read(&self.settings_path)?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    /// Write `settings.json` atomically.
    pub fn write_settings(&self, settings: &VaultSettings) -> Result<(), VaultError> {
        atomic_write(&self.settings_path, &serde_json::to_vec_pretty(settings)?)
    }

    /// Create `settings.json` on first open only.
    fn ensure_settings(&self) -> Result<(), VaultError> {
        if !self.settings_path.exists() {
            self.write_settings(&VaultSettings::default())?;
        }
        Ok(())
    }

    /// Write `config.json` on first open only.
    fn ensure_config(&self) -> Result<(), VaultError> {
        if !self.config_path.exists() {
            let cfg = VaultConfig {
                version: VAULT_VERSION,
                created_at_ms: now_ms(),
            };
            atomic_write(&self.config_path, &serde_json::to_vec_pretty(&cfg)?)?;
        }
        Ok(())
    }

    /// Recount records and overwrite `state.json` atomically.
    fn sync_state(&self) -> Result<(), VaultError> {
        let count = fs::read_dir(&self.records_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| is_json(&e.path()))
            .count();
        let state = VaultState {
            version: VAULT_VERSION,
            record_count: count,
            last_updated_ms: now_ms(),
        };
        atomic_write(&self.state_path, &serde_json::to_vec_pretty(&state)?)
    }
}

// ─── Free functions ───────────────────────────────────────────────────────────

/// Write `data` to `path` atomically: write to `<path>.tmp` then rename.
///
/// A crash mid-write leaves a `.tmp` file behind, not a corrupt final file.
/// The rename is atomic on POSIX (same filesystem); on Windows it is not
/// guaranteed but is the best available option without a third-party crate.
fn atomic_write(path: &Path, data: &[u8]) -> Result<(), VaultError> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path).map_err(VaultError::from)
}

/// Recursively copy `src` directory tree into `dst` (creates `dst`).
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), VaultError> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if ty.is_file() {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

fn is_json(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("json")
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Resolve the active vault path.
///
/// Order of preference:
/// 1. Custom path stored in the vault-location pointer file (user has changed it)
/// 2. `~/Documents/MindRelayVault/` (factory default)
pub fn default_vault_path() -> PathBuf {
    if let Some(custom) = read_vault_location() {
        return custom;
    }
    UserDirs::new()
        .and_then(|u| u.document_dir().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
        .join("MindRelayVault")
}

// ─── Vault location pointer ───────────────────────────────────────────────────
// The pointer file lives in the OS-level app config dir (outside any vault) so
// it survives the user moving or changing their vault folder.
//
//   macOS:   ~/Library/Application Support/com.mindrelay.app/vault_location.json
//   Windows: %APPDATA%\com.mindrelay.app\vault_location.json
//   Linux:   ~/.config/com.mindrelay.app/vault_location.json

/// Fixed path to the vault-location pointer file (outside any vault).
pub fn vault_pointer_path() -> PathBuf {
    ProjectDirs::from("com", "MindRelay", "mindrelay")
        .map(|dirs| dirs.config_dir().join("vault_location.json"))
        .unwrap_or_else(|| PathBuf::from(".mindrelay_vault_location.json"))
}

/// Read the user's custom vault path from the pointer file.
/// Returns `None` if the pointer does not exist or is invalid.
pub fn read_vault_location() -> Option<PathBuf> {
    let bytes = fs::read(vault_pointer_path()).ok()?;
    let val: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let raw = val.get("vault_path")?.as_str()?;
    let p = PathBuf::from(raw);
    if p.is_absolute() { Some(p) } else { None }
}

/// Persist a custom vault path in the pointer file.
/// Creates the pointer file's parent directory if needed.
pub fn write_vault_location(vault_path: &Path) -> Result<(), VaultError> {
    let pointer = vault_pointer_path();
    if let Some(parent) = pointer.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(&serde_json::json!({
        "vault_path": vault_path.to_string_lossy()
    }))?;
    atomic_write(&pointer, &data)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Message;
    use tempfile::TempDir;

    fn make(id: &str, source: &str) -> Transcript {
        Transcript {
            id: id.into(),
            source: source.into(),
            title: format!("Test — {}", id),
            url: "https://claude.ai/chat/test".into(),
            timestamp: 1_700_000_000,
            messages: vec![
                Message { role: "user".into(), content: "Hello".into() },
                Message { role: "assistant".into(), content: "Hi".into() },
            ],
            markdown: String::new(),
        }
    }

    fn temp_vault() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open(dir.path().to_path_buf()).unwrap();
        (dir, vault)
    }

    // ── Folder structure ──────────────────────────────────────────────────────

    #[test]
    fn creates_records_dir_on_open() {
        let dir = TempDir::new().unwrap();
        Vault::open(dir.path().to_path_buf()).unwrap();
        assert!(dir.path().join("records").is_dir());
    }

    #[test]
    fn creates_meta_dir_and_logs_on_open() {
        let dir = TempDir::new().unwrap();
        Vault::open(dir.path().to_path_buf()).unwrap();
        assert!(dir.path().join(".mindrelay").is_dir());
        assert!(dir.path().join(".mindrelay/logs").is_dir());
    }

    #[test]
    fn creates_config_json_on_first_open() {
        let dir = TempDir::new().unwrap();
        Vault::open(dir.path().to_path_buf()).unwrap();
        assert!(dir.path().join(".mindrelay/config.json").exists());
    }

    #[test]
    fn config_json_not_overwritten_on_reopen() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().to_path_buf();
        Vault::open(base.clone()).unwrap();
        let first = fs::read(base.join(".mindrelay/config.json")).unwrap();
        Vault::open(base.clone()).unwrap();
        let second = fs::read(base.join(".mindrelay/config.json")).unwrap();
        assert_eq!(first, second);
    }

    // ── put ───────────────────────────────────────────────────────────────────

    #[test]
    fn put_creates_json_file() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("abc", "claude")).unwrap();
        assert!(vault.record_path("abc").exists());
    }

    #[test]
    fn put_file_roundtrips_correctly() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("r1", "chatgpt")).unwrap();
        let bytes = fs::read(vault.record_path("r1")).unwrap();
        let decoded: Transcript = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.id, "r1");
        assert_eq!(decoded.source, "chatgpt");
    }

    #[test]
    fn put_leaves_no_tmp_file_after_success() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("t1", "gemini")).unwrap();
        assert!(!vault.record_path("t1").with_extension("tmp").exists());
    }

    #[test]
    fn put_overwrites_existing_record() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("u1", "claude")).unwrap();
        let mut updated = make("u1", "claude");
        updated.title = "Updated title".into();
        vault.put(&updated).unwrap();
        let bytes = fs::read(vault.record_path("u1")).unwrap();
        let decoded: Transcript = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.title, "Updated title");
    }

    // ── delete ────────────────────────────────────────────────────────────────

    #[test]
    fn delete_removes_record_file() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("d1", "grok")).unwrap();
        vault.delete("d1").unwrap();
        assert!(!vault.record_path("d1").exists());
    }

    #[test]
    fn delete_nonexistent_id_is_noop() {
        let (_dir, vault) = temp_vault();
        assert!(vault.delete("ghost").is_ok());
    }

    // ── delete_by_source ──────────────────────────────────────────────────────

    #[test]
    fn delete_by_source_removes_matching_only() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("c1", "claude")).unwrap();
        vault.put(&make("c2", "claude")).unwrap();
        vault.put(&make("g1", "gemini")).unwrap();
        vault.delete_by_source("claude").unwrap();
        assert!(!vault.record_path("c1").exists());
        assert!(!vault.record_path("c2").exists());
        assert!(vault.record_path("g1").exists());
    }

    // ── clear ─────────────────────────────────────────────────────────────────

    #[test]
    fn clear_removes_all_json_records() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("a", "claude")).unwrap();
        vault.put(&make("b", "chatgpt")).unwrap();
        vault.clear().unwrap();
        let count = fs::read_dir(&vault.records_dir).unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_json(&e.path()))
            .count();
        assert_eq!(count, 0);
    }

    // ── state.json ────────────────────────────────────────────────────────────

    #[test]
    fn state_json_reflects_record_count() {
        let (dir, vault) = temp_vault();
        vault.put(&make("s1", "claude")).unwrap();
        vault.put(&make("s2", "grok")).unwrap();
        let bytes = fs::read(dir.path().join(".mindrelay/state.json")).unwrap();
        let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(state["record_count"], 2);
    }

    #[test]
    fn state_count_decrements_after_delete() {
        let (dir, vault) = temp_vault();
        vault.put(&make("s1", "claude")).unwrap();
        vault.put(&make("s2", "claude")).unwrap();
        vault.delete("s1").unwrap();
        let bytes = fs::read(dir.path().join(".mindrelay/state.json")).unwrap();
        let state: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(state["record_count"], 1);
    }

    // ── sync_missing ─────────────────────────────────────────────────────────

    #[test]
    fn sync_missing_writes_absent_records() {
        let (_dir, vault) = temp_vault();
        let transcripts = vec![make("sm1", "claude"), make("sm2", "chatgpt"), make("sm3", "gemini")];
        let written = vault.sync_missing(&transcripts).unwrap();
        assert_eq!(written, 3);
        assert!(vault.record_path("sm1").exists());
        assert!(vault.record_path("sm2").exists());
        assert!(vault.record_path("sm3").exists());
    }

    #[test]
    fn sync_missing_skips_existing_records() {
        let (_dir, vault) = temp_vault();
        vault.put(&make("pre", "claude")).unwrap();
        let transcripts = vec![make("pre", "claude"), make("new1", "grok")];
        let written = vault.sync_missing(&transcripts).unwrap();
        // Only the new one should be written
        assert_eq!(written, 1);
    }

    #[test]
    fn sync_missing_empty_slice_writes_nothing() {
        let (_dir, vault) = temp_vault();
        let written = vault.sync_missing(&[]).unwrap();
        assert_eq!(written, 0);
    }

    #[test]
    fn sync_missing_is_idempotent() {
        let (_dir, vault) = temp_vault();
        let transcripts = vec![make("idem", "obsidian")];
        let first = vault.sync_missing(&transcripts).unwrap();
        let second = vault.sync_missing(&transcripts).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0); // already exists, skip
    }

    // ── backup ────────────────────────────────────────────────────────────────

    // Helper: vault in <dir>/vault, so backup can live at <dir>/backup (sibling).
    fn temp_vault_nested() -> (TempDir, Vault) {
        let dir = TempDir::new().unwrap();
        let vault = Vault::open(dir.path().join("vault")).unwrap();
        (dir, vault)
    }

    #[test]
    fn backup_copies_records_and_structure() {
        let (dir, vault) = temp_vault_nested();
        vault.put(&make("b1", "claude")).unwrap();
        vault.put(&make("b2", "chatgpt")).unwrap();

        let backup_dir = dir.path().join("backup");
        vault.backup(&backup_dir).unwrap();

        // Core structure must exist
        assert!(backup_dir.join("records").is_dir());
        assert!(backup_dir.join("settings.json").exists());
        assert!(backup_dir.join(".mindrelay").is_dir());
        assert!(backup_dir.join("data").is_dir());
        assert!(backup_dir.join("memorymesh").is_dir());
        assert!(backup_dir.join("history").is_dir());

        // Both record files must be present
        let count = fs::read_dir(backup_dir.join("records"))
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| is_json(&e.path()))
            .count();
        assert_eq!(count, 2);
    }

    #[test]
    fn backup_records_are_valid_transcripts() {
        let (dir, vault) = temp_vault_nested();
        let original = make("v1", "grok");
        vault.put(&original).unwrap();

        let backup_dir = dir.path().join("backup");
        vault.backup(&backup_dir).unwrap();

        let path = backup_dir.join("records").join("v1.json");
        let bytes = fs::read(&path).unwrap();
        let decoded: Transcript = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(decoded.id, original.id);
        assert_eq!(decoded.source, original.source);
        assert_eq!(decoded.title, original.title);
    }

    #[test]
    fn backup_fails_if_dest_already_exists() {
        let (dir, vault) = temp_vault_nested();
        let backup_dir = dir.path().join("backup");
        fs::create_dir_all(&backup_dir).unwrap();
        assert!(vault.backup(&backup_dir).is_err());
    }

    #[test]
    fn backup_fails_if_dest_inside_vault() {
        let (_dir, vault) = temp_vault();
        // Any path inside the vault tree must be rejected
        let inside = vault.records_dir.join("my_backup");
        assert!(vault.backup(&inside).is_err());
    }

    #[test]
    fn backup_empty_vault_creates_structure() {
        let (dir, vault) = temp_vault_nested();
        let backup_dir = dir.path().join("backup");
        vault.backup(&backup_dir).unwrap();
        assert!(backup_dir.join("records").is_dir());
        assert!(backup_dir.join("settings.json").exists());
    }

    // ── ID sanitization ───────────────────────────────────────────────────────

    #[test]
    fn unsafe_chars_in_id_become_underscores() {
        let (_dir, vault) = temp_vault();
        let path = vault.record_path("hello/world?foo=bar&x=1");
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(!name.contains('/'));
        assert!(!name.contains('?'));
        assert!(!name.contains('='));
        assert!(!name.contains('&'));
        assert!(name.ends_with(".json"));
    }
}
