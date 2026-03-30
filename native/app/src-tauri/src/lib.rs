use mindrelay_core::{Database, Transcript};
use tauri::{Emitter, Manager};

// ─── Extension IDs allowed to use the native host ────────────────────────────
// Add the Chrome Web Store ID here once the extension is published.
const EXTENSION_IDS: &[&str] = &[
    "mgeflnillehbijonabanklcaikdijbfj", // unpacked from build/chrome-mv3-dev
    "eenchomclmclkgdkehjeokfagpmibioe", // unpacked from build/chrome-mv3-prod
];

// ─── Auto-setup: register native messaging host on first launch ──────────────

fn setup_native_host(app: &tauri::App) {
    if let Err(e) = try_setup_native_host(app) {
        eprintln!("[MindRelay] native host setup failed: {e}");
    }
}

fn try_setup_native_host(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = mindrelay_core::default_db_path()
        .parent()
        .ok_or("no data dir")?
        .to_path_buf();
    std::fs::create_dir_all(&data_dir)?;

    #[cfg(windows)]
    let host_filename = "mindrelay-host.exe";
    #[cfg(not(windows))]
    let host_filename = "mindrelay-host";

    let host_dst = data_dir.join(host_filename);
    let manifest_path = chrome_manifest_path()?;

    // Copy host binary out of app resources (skip if already up-to-date)
    // Always re-write the manifest so the allowed_origins list stays current.
    let resource_dir = app.path().resource_dir()?;
    let host_src = resource_dir.join(host_filename);
    if host_src.exists() {
        std::fs::copy(&host_src, &host_dst)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&host_dst, std::fs::Permissions::from_mode(0o755))?;
        }
        // Ad-hoc sign so macOS allows the binary to run as a standalone process
        // outside the app bundle (required on Apple Silicon with SIP enabled).
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("codesign")
                .args(["--force", "--sign", "-", host_dst.to_str().unwrap_or("")])
                .output();
        }
    }

    // Write the Chrome native messaging manifest JSON
    let allowed_origins: Vec<String> = EXTENSION_IDS
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect();

    let manifest = serde_json::json!({
        "name": "com.mindrelay.host",
        "description": "MindRelay native messaging host",
        "path": host_dst,
        "type": "stdio",
        "allowed_origins": allowed_origins
    });

    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&manifest)?)?;

    // Windows also needs a registry entry pointing at the manifest file
    #[cfg(windows)]
    register_windows_registry(&manifest_path)?;

    // Also register for Edge on all platforms
    register_edge(&host_dst, &allowed_origins)?;

    eprintln!("[MindRelay] native host registered at {}", host_dst.display());
    Ok(())
}

/// Chrome native messaging manifest location per platform.
#[cfg(target_os = "macos")]
fn chrome_manifest_path() -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    Ok(std::path::PathBuf::from(home)
        .join("Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mindrelay.host.json"))
}

#[cfg(windows)]
fn chrome_manifest_path() -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let appdata = std::env::var("APPDATA")?;
    Ok(std::path::PathBuf::from(appdata)
        .join("MindRelay/com.mindrelay.host.json"))
}

#[cfg(target_os = "linux")]
fn chrome_manifest_path() -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let home = std::env::var("HOME")?;
    Ok(std::path::PathBuf::from(home)
        .join(".config/google-chrome/NativeMessagingHosts/com.mindrelay.host.json"))
}

/// Register for Microsoft Edge (same manifest, different directory/registry key).
fn register_edge(
    host_dst: &std::path::Path,
    allowed_origins: &[String],
) -> Result<(), Box<dyn std::error::Error>> {
    let manifest = serde_json::json!({
        "name": "com.mindrelay.host",
        "description": "MindRelay native messaging host",
        "path": host_dst,
        "type": "stdio",
        "allowed_origins": allowed_origins
    });

    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME")?;
        let edge_path = std::path::PathBuf::from(home)
            .join("Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.mindrelay.host.json");
        if let Some(p) = edge_path.parent() { std::fs::create_dir_all(p)?; }
        std::fs::write(&edge_path, serde_json::to_string_pretty(&manifest)?)?;
    }

    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA")?;
        let edge_manifest = std::path::PathBuf::from(appdata)
            .join("MindRelay/com.mindrelay.host.edge.json");
        if let Some(p) = edge_manifest.parent() { std::fs::create_dir_all(p)?; }
        std::fs::write(&edge_manifest, serde_json::to_string_pretty(&manifest)?)?;
        use winreg::enums::*;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(
            "Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.mindrelay.host",
        )?;
        key.set_value("", &edge_manifest.to_string_lossy().to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME")?;
        let edge_path = std::path::PathBuf::from(home)
            .join(".config/microsoft-edge/NativeMessagingHosts/com.mindrelay.host.json");
        if let Some(p) = edge_path.parent() { std::fs::create_dir_all(p)?; }
        std::fs::write(&edge_path, serde_json::to_string_pretty(&manifest)?)?;
    }

    Ok(())
}

/// Write Chrome registry entry on Windows.
#[cfg(windows)]
fn register_windows_registry(
    manifest_path: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error>> {
    use winreg::enums::*;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(
        "Software\\Google\\Chrome\\NativeMessagingHosts\\com.mindrelay.host",
    )?;
    key.set_value("", &manifest_path.to_string_lossy().to_string())?;
    Ok(())
}

// ─── Vaults registry ─────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct VaultEntry {
    name: String,
    path: String,
}

fn vaults_registry_path() -> std::path::PathBuf {
    mindrelay_core::vault_pointer_path()
        .with_file_name("vaults.json")
}

fn read_vaults() -> Vec<VaultEntry> {
    let bytes = match std::fs::read(vaults_registry_path()) {
        Ok(b) => b,
        Err(_) => return Vec::new(),
    };
    serde_json::from_slice::<Vec<VaultEntry>>(&bytes).unwrap_or_default()
}

fn write_vaults(vaults: &[VaultEntry]) {
    let path = vaults_registry_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    if let Ok(json) = serde_json::to_string_pretty(vaults) {
        std::fs::write(path, json).ok();
    }
}

fn ensure_in_registry(path: &str) {
    let mut vaults = read_vaults();
    if !vaults.iter().any(|v| v.path == path) {
        let name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path)
            .to_string();
        vaults.push(VaultEntry { name, path: path.to_string() });
        write_vaults(&vaults);
    }
}

#[tauri::command]
fn get_vaults() -> Vec<VaultEntry> {
    let active = mindrelay_core::default_vault_path()
        .to_string_lossy()
        .into_owned();
    // Always ensure active vault is in registry
    ensure_in_registry(&active);
    read_vaults()
}

#[tauri::command]
fn add_vault(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("path must be absolute".into());
    }
    mindrelay_core::Vault::open(p.clone()).map_err(|e| e.to_string())?;
    mindrelay_core::write_vault_location(&p).map_err(|e| e.to_string())?;
    ensure_in_registry(&path);
    app.emit("vault-switched", &path).ok();
    Ok(path)
}

#[tauri::command]
fn create_vault(name: String, app: tauri::AppHandle) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() { return Err("name cannot be empty".into()); }
    let safe_name: String = name.chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect::<String>()
        .trim()
        .to_string();
    if safe_name.is_empty() { return Err("invalid vault name".into()); }

    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let parent = std::path::PathBuf::from(home).join("Documents").join("Mindrelay");
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;

    let vault_path = parent.join(&safe_name);
    mindrelay_core::Vault::open(vault_path.clone()).map_err(|e| e.to_string())?;
    mindrelay_core::write_vault_location(&vault_path).map_err(|e| e.to_string())?;
    let path_str = vault_path.to_string_lossy().into_owned();
    ensure_in_registry(&path_str);
    app.emit("vault-switched", &path_str).ok();
    Ok(path_str)
}

#[tauri::command]
fn switch_vault(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    mindrelay_core::Vault::open(p.clone()).map_err(|e| e.to_string())?;
    mindrelay_core::write_vault_location(&p).map_err(|e| e.to_string())?;
    ensure_in_registry(&path);
    app.emit("vault-switched", &path).ok();
    Ok(path)
}

#[tauri::command]
fn remove_vault(path: String) -> Result<(), String> {
    let mut vaults = read_vaults();
    vaults.retain(|v| v.path != path);
    write_vaults(&vaults);
    Ok(())
}

#[tauri::command]
fn rename_vault(path: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() { return Err("name cannot be empty".into()); }
    let mut vaults = read_vaults();
    if let Some(v) = vaults.iter_mut().find(|v| v.path == path) {
        v.name = name;
        write_vaults(&vaults);
        Ok(())
    } else {
        Err("vault not found".into())
    }
}

// ─── Vault folder commands ───────────────────────────────────────────────────

/// Open the current vault directory in the OS file manager (Finder on macOS).
/// Creates the directory first if it does not yet exist.
#[tauri::command]
fn open_vault_folder() -> Result<(), String> {
    let path = mindrelay_core::default_vault_path();
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ─── First-run detection ─────────────────────────────────────────────────────

/// Returns true when the user has never explicitly chosen a vault location.
/// Used by the frontend to show the first-run setup modal.
#[tauri::command]
fn is_first_run() -> bool {
    !mindrelay_core::vault_pointer_path().exists()
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

fn db() -> Result<Database, String> {
    Database::open_default().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_all_transcripts() -> Result<Vec<Transcript>, String> {
    db()?.get_all().map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_transcript(id: String) -> Result<(), String> {
    db()?.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_by_source(source: String) -> Result<(), String> {
    db()?.delete_by_source(&source).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_all() -> Result<(), String> {
    db()?.clear().map_err(|e| e.to_string())
}

#[tauri::command]
fn put_transcript(transcript: Transcript) -> Result<(), String> {
    db()?.put(&transcript).map_err(|e| e.to_string())
}

// ─── Vault commands ───────────────────────────────────────────────────────────

/// Return the currently active vault path as a string.
#[tauri::command]
fn get_vault_path() -> String {
    mindrelay_core::default_vault_path()
        .to_string_lossy()
        .into_owned()
}

/// Persist a new vault path and create its directory structure.
/// Returns the resolved path on success.
#[tauri::command]
fn set_vault_path(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("vault path must be absolute".into());
    }
    mindrelay_core::write_vault_location(&p).map_err(|e| e.to_string())?;
    // Initialise directory structure at the new location
    mindrelay_core::Vault::open(p).map_err(|e| e.to_string())?;
    Ok(path)
}

// ─── Vault sync command ───────────────────────────────────────────────────────

/// Copy every transcript that is in SQLite but missing from vault/records/.
/// Safe to call repeatedly — skips files that already exist.
/// Returns the number of newly written vault files.
#[tauri::command]
fn sync_to_vault() -> Result<usize, String> {
    let transcripts = db()?.get_all().map_err(|e| e.to_string())?;
    let vault = mindrelay_core::Vault::open(mindrelay_core::default_vault_path())
        .map_err(|e| e.to_string())?;
    vault.sync_missing(&transcripts).map_err(|e| e.to_string())
}

// ─── Backup command ───────────────────────────────────────────────────────────

/// Create a timestamped copy of the entire vault directory tree adjacent to
/// the vault root.  Returns the absolute path of the backup on success.
#[tauri::command]
fn backup_vault() -> Result<String, String> {
    let vault_path = mindrelay_core::default_vault_path();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let folder_name = vault_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("MindRelayVault");
    let dest = vault_path
        .parent()
        .unwrap_or(&vault_path)
        .join(format!("{folder_name}_backup_{ts}"));
    let vault = mindrelay_core::Vault::open(vault_path).map_err(|e| e.to_string())?;
    vault.backup(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

// ─── App entry point ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_all_transcripts,
            delete_transcript,
            delete_by_source,
            clear_all,
            put_transcript,
            get_vault_path,
            set_vault_path,
            sync_to_vault,
            backup_vault,
            is_first_run,
            open_vault_folder,
            get_vaults,
            add_vault,
            create_vault,
            switch_vault,
            remove_vault,
            rename_vault,
        ])
        .setup(|app| {
            setup_native_host(app);
            // Silently backfill any transcripts that are in SQLite but missing
            // from vault/records/ — covers data written before dual-write existed.
            if let Err(e) = sync_to_vault() {
                eprintln!("[MindRelay] vault backfill warning: {e}");
            }
            #[cfg(debug_assertions)]
            app.get_webview_window("main").unwrap().open_devtools();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
