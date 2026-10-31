// macOS wrapper for the LNP Lab web app. The web files are served from the bundled `dist` folder. The records
// live in a SQLite file, lnp-lab.db in the app's data folder (~/Library/Application Support/org.lnplab.app/),
// through tauri-plugin-sql (app/store.js sqliteBackend); the window's IndexedDB is the fallback if it will not open,
// and records an earlier version kept there are moved into the file on the first start. The page reaches the plugins below through window.__TAURI__
// (withGlobalTauri in tauri.conf.json): dialog and fs save every export, since WKWebView does nothing with a
// browser download, and notification sends the calendar's reminders (app/ui/kit.js, app/ui/calendar.js).
//
// While the app runs it keeps a lock file beside the database, lnp-lab.app.lock, holding its process id. The
// optional import tool (mcp/, spec 6.2) reads it and writes the database only when that process is gone: the
// window holds every collection in memory and stores them whole, so a record written under it would be lost with
// its next save. A crash leaves the file behind, but its process id is then dead, which the tool checks. Only the
// standard library, so no new dependency.
use std::path::PathBuf;
use tauri::Manager;

const LOCK_FILE: &str = "lnp-lab.app.lock";

/// The folder tauri-plugin-sql resolves "sqlite:lnp-lab.db" against.
fn data_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    app.path().app_config_dir().ok()
}

fn write_lock(dir: &PathBuf) {
    let _ = std::fs::create_dir_all(dir);
    let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let body = format!("{{\"pid\":{},\"startedAt\":{},\"app\":\"LNP Lab\"}}", std::process::id(), started);
    let _ = std::fs::write(dir.join(LOCK_FILE), body);
}

fn remove_lock(dir: &PathBuf) {
    // Only our own: a second copy of the app started later may have written its process id since.
    let path = dir.join(LOCK_FILE);
    if let Ok(text) = std::fs::read_to_string(&path) {
        if text.contains(&format!("\"pid\":{},", std::process::id())) {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .setup(|app| {
            if let Some(dir) = data_dir(app.handle()) {
                write_lock(&dir);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building LNP Lab");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(dir) = data_dir(handle) {
                remove_lock(&dir);
            }
        }
    });
}
