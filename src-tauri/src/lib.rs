// macOS wrapper for the LNP Lab web app. The web files are served from the bundled `dist` folder. The records
// live in a SQLite file, lnp-lab.db in the app's data folder (~/Library/Application Support/org.lnplab.app/),
// through tauri-plugin-sql (app/store.js sqliteBackend); the window's IndexedDB is the fallback if it will not open,
// and records an earlier version kept there are moved into the file on the first start. The page reaches the plugins below through window.__TAURI__
// (withGlobalTauri in tauri.conf.json): dialog and fs save every export, since WKWebView does nothing with a
// browser download, and notification sends the calendar's reminders (app/ui/kit.js, app/ui/calendar.js).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running LNP Lab");
}
