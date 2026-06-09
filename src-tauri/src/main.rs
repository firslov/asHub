#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const HUB_PORT: u16 = 7878;
const INJECT_JS: &str = include_str!("../inject.js");

struct HubProcess(Mutex<Option<Child>>);

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_path_buf()
}

/// Resolves (node binary, hub entry, web root). Prefers the bundled sidecar node
/// and packaged resources; falls back to PATH `node` + project tree for `cargo run`.
fn hub_command(app: &tauri::AppHandle) -> (PathBuf, PathBuf, PathBuf) {
    let node = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("node")))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("node"));

    if let Ok(res) = app.path().resource_dir() {
        let cli = res.join("dist/cli.js");
        if cli.exists() {
            return (node, cli, res.join("web"));
        }
    }

    let root = project_root();
    (node, root.join("dist/cli.js"), root.join("web"))
}

fn spawn_hub(app: &tauri::AppHandle) -> std::io::Result<Child> {
    let (node, cli, web) = hub_command(app);
    let cwd = std::env::var("HOME").unwrap_or_else(|_| "/".into());
    Command::new(node)
        .arg(&cli)
        .args(["--port", &HUB_PORT.to_string()])
        .arg("--web")
        .arg(&web)
        .current_dir(cwd)
        .spawn()
}

fn wait_for_hub(timeout: Duration) -> bool {
    let addr: SocketAddr = ([127, 0, 0, 1], HUB_PORT).into();
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

#[cfg(target_os = "macos")]
fn system_is_dark() -> bool {
    Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "Dark")
        .unwrap_or(false)
}

fn build_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Custom menu deliberately omits a Close item so Cmd+W reaches the
    // renderer, which uses it to close the active tab.
    let mut builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "asHub")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        builder = builder.item(&app_menu);
    }

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .build()?;

    let menu = builder.item(&edit_menu).item(&window_menu).build()?;
    app.set_menu(menu)?;
    Ok(())
}

fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let mut builder = WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(format!("http://127.0.0.1:{HUB_PORT}/").parse().unwrap()),
    )
    // Empty native title: the macOS Overlay title bar would otherwise draw the
    // title text over the web UI's toolbar icons. App/Dock name comes from
    // productName. (Electron's hiddenInset hid the title; Tauri's Overlay shows it.)
    .title("")
    .inner_size(1400.0, 900.0)
    .min_inner_size(900.0, 600.0)
    .initialization_script(INJECT_JS);

    #[cfg(target_os = "macos")]
    {
        use tauri::utils::TitleBarStyle;
        let bg = if system_is_dark() {
            tauri::webview::Color(0x18, 0x18, 0x1c, 0xff)
        } else {
            tauri::webview::Color(0xfa, 0xfa, 0xf7, 0xff)
        };
        builder = builder
            .title_bar_style(TitleBarStyle::Overlay)
            .background_color(bg);
    }

    builder.build()?;
    Ok(())
}

fn main() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .manage(HubProcess(Mutex::new(None)))
        .setup(|app| {
            // Reuse a hub already serving the port (e.g. one orphaned by a prior
            // crash) rather than double-spawning and contending for the bind.
            // Only a hub we spawn is tracked for kill-on-exit.
            if !wait_for_hub(Duration::from_millis(300)) {
                let child = spawn_hub(app.handle()).expect("failed to spawn hub sidecar");
                app.state::<HubProcess>().0.lock().unwrap().replace(child);
                if !wait_for_hub(Duration::from_secs(30)) {
                    eprintln!("[tauri] hub did not become ready on port {HUB_PORT}");
                }
            }

            build_menu(app.handle())?;
            create_main_window(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building tauri app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<HubProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
