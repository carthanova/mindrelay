use mindrelay_core::{Database, Transcript};
use tauri::Manager;

// ─── Extension IDs allowed to use the native host ────────────────────────────
// Add the Chrome Web Store ID here once the extension is published.
const EXTENSION_IDS: &[&str] = &[
    "mgeflnillehbijonabanklcaikdijbfj", // dev (unpacked)
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

    // Already registered — nothing to do
    if host_dst.exists() && manifest_path.exists() {
        return Ok(());
    }

    // Copy host binary out of app resources
    let resource_dir = app.path().resource_dir()?;
    let host_src = resource_dir.join(host_filename);
    if host_src.exists() {
        std::fs::copy(&host_src, &host_dst)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&host_dst, std::fs::Permissions::from_mode(0o755))?;
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
        .plugin(tauri_plugin_shell::init())
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
