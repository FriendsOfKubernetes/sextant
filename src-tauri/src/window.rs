//! Main window geometry: restored on start, recorded (debounced) on resize; subscriptions, sessions and port forwards
//! closed when the window is destroyed and when the application exits. With "keep in the tray" on (and a tray icon),
//! closing the window only hides it: everything keeps running, and [`reveal`] brings it back.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use sextant_core::WindowLayout;
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::state::AppState;

pub const MAIN_WINDOW: &str = "main";
/// Smallest size we restore to; matches `minWidth`/`minHeight` in `tauri.conf.json`.
pub const MIN_WIDTH: u32 = 360;
pub const MIN_HEIGHT: u32 = 480;
const SAVE_DELAY: Duration = Duration::from_millis(400);
/// How long after losing the focus the tray's "Show/Hide" text is checked again (a minimize).
const LABEL_RESYNC_DELAY: Duration = Duration::from_millis(500);

/// Logical size to restore, if one was saved.
pub fn restored_size(layout: &WindowLayout) -> Option<(u32, u32)> {
    match (layout.width, layout.height) {
        (Some(w), Some(h)) => Some((w.max(MIN_WIDTH), h.max(MIN_HEIGHT))),
        _ => None,
    }
}

/// Layout after a resize. A maximized window keeps the last normal size so un-maximizing restores it.
pub fn record_resize(layout: &mut WindowLayout, width: u32, height: u32, maximized: bool) {
    layout.maximized = maximized;
    if !maximized && width > 0 && height > 0 {
        layout.width = Some(width);
        layout.height = Some(height);
    }
}

pub fn restore_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let layout = app.state::<AppState>().settings.get().window;
        if let Some((w, h)) = restored_size(&layout) {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
            let _ = window.center();
        }
        if layout.maximized {
            let _ = window.maximize();
        }
        let _ = window.show();
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Brings the main window back: shown, unminimized and focused. Every "show the window" path uses it (the tray menu,
/// a confirmation request, "About" from the tray, a Dock click on macOS).
pub fn reveal<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        crate::tray::show_label(app, crate::tray::WindowToggle::Hide);
    }
    #[cfg(not(desktop))]
    let _ = app;
}

/// Whether closing the main window hides it instead: only with the setting on and a tray icon to bring it back from.
pub fn hides_on_close(close_to_tray: bool, tray_available: bool) -> bool {
    close_to_tray && tray_available
}

/// Whether a close request is held while the tray is asked (off the event loop) whether it shows the icon: only with
/// the setting on and an icon created. Otherwise the window closes as usual, without asking anything.
pub fn defers_close(close_to_tray: bool, icon_created: bool) -> bool {
    close_to_tray && icon_created
}

static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        WindowEvent::Resized(_) => {
            schedule_geometry_save(window);
            #[cfg(desktop)]
            crate::tray::sync_label(window.app_handle());
        }
        #[cfg(desktop)]
        WindowEvent::Focused(focused) => {
            crate::tray::sync_label(window.app_handle());
            // A minimize sends no event of its own; it takes the focus away, and the window manager may report the
            // minimized state only a moment later.
            if !focused {
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(LABEL_RESYNC_DELAY).await;
                    crate::tray::sync_label(&app);
                });
            }
        }
        // Hiding keeps every session, stream, port forward and the MCP server: `close_all` is not called.
        #[cfg(desktop)]
        WindowEvent::CloseRequested { api, .. } => {
            let close_to_tray = window
                .try_state::<AppState>()
                .is_some_and(|state| state.settings.get().close_to_tray);
            if defers_close(
                close_to_tray,
                crate::tray::icon_created(window.app_handle()),
            ) {
                // Whether the icon is shown is asked again now (the StatusNotifier host can be gone since start). On
                // Linux that is a D-Bus round trip, so it never runs on this thread, the event loop: the close is held
                // and decided on the blocking pool. Without a host the window is destroyed, which ends the app as a
                // close does (`Destroyed`, then the exit).
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let app = window.app_handle();
                    if hides_on_close(close_to_tray, crate::tray::available(app)) {
                        let _ = window.hide();
                        crate::tray::show_label(app, crate::tray::WindowToggle::Show);
                    } else {
                        let _ = window.destroy();
                    }
                });
            }
        }
        WindowEvent::Destroyed => {
            if let Some(state) = window.try_state::<AppState>() {
                state.close_all();
            }
        }
        _ => {}
    }
}

/// Application-level events. Quitting (Cmd+Q on macOS, the last window closed, `AppHandle::exit`) does not always
/// destroy the window first, so everything is closed here too: terminal sessions remove their temporary kubeconfig
/// before the process ends.
/// On macOS a click on the Dock icon (`Reopen`) brings a hidden window back.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event
        && let Some(state) = app.try_state::<AppState>()
    {
        state.close_all();
    }
    #[cfg(target_os = "macos")]
    if let RunEvent::Reopen { .. } = event {
        reveal(app);
    }
}

/// Saves the size once resizing settles, so dragging the window edge does not write the file on every frame.
fn schedule_geometry_save<R: Runtime>(window: &Window<R>) {
    let generation = RESIZE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SAVE_DELAY).await;
        if RESIZE_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
            return;
        };
        if window.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = window.is_maximized().unwrap_or(false);
        let logical = size.to_logical::<f64>(scale);
        let Some(state) = window.try_state::<AppState>() else {
            return;
        };
        let _ = state.settings.update(|s| {
            record_resize(
                &mut s.window,
                logical.width.round() as u32,
                logical.height.round() as u32,
                maximized,
            )
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exiting_the_application_closes_every_session_and_removes_its_temp_kubeconfig() {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        let state = app.state::<AppState>();
        let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let guard_path = guard.to_path_buf();
        let (input, _input_rx) = tokio::sync::mpsc::channel(1);
        let (resize, _resize_rx) = tokio::sync::mpsc::channel(1);
        let task = tauri::async_runtime::spawn(futures::future::pending::<()>());
        state
            .sessions
            .insert(
                "t-1".into(),
                crate::state::TermSession {
                    cluster: None,
                    input,
                    resize,
                    task: task.inner().abort_handle(),
                    guard: Some(Box::new(guard)),
                },
            )
            .unwrap();

        on_run_event(app.handle(), &RunEvent::Ready);
        assert_eq!(state.sessions.len(), 1, "other events change nothing");
        on_run_event(app.handle(), &RunEvent::Exit);
        assert!(state.sessions.is_empty());
        assert!(
            !guard_path.exists(),
            "the temp kubeconfig outlived the exit"
        );
    }

    #[test]
    fn a_close_waits_for_the_tray_check_only_with_the_setting_on_and_an_icon() {
        assert!(defers_close(true, true));
        assert!(
            !defers_close(true, false),
            "no icon: the window closes at once"
        );
        assert!(
            !defers_close(false, true),
            "the setting off: closes at once"
        );
        assert!(!defers_close(false, false));
    }

    #[test]
    fn closing_hides_only_with_the_setting_on_and_a_tray_icon() {
        assert!(hides_on_close(true, true));
        assert!(
            !hides_on_close(true, false),
            "without a tray the window would be lost"
        );
        assert!(!hides_on_close(false, true));
        assert!(!hides_on_close(false, false));
    }

    #[test]
    fn nothing_to_restore_without_saved_size() {
        assert_eq!(restored_size(&WindowLayout::default()), None);
    }

    #[test]
    fn restores_saved_size_but_not_below_minimum() {
        let layout = WindowLayout {
            width: Some(1500),
            height: Some(900),
            ..Default::default()
        };
        assert_eq!(restored_size(&layout), Some((1500, 900)));
        let tiny = WindowLayout {
            width: Some(10),
            height: Some(10),
            ..Default::default()
        };
        assert_eq!(restored_size(&tiny), Some((MIN_WIDTH, MIN_HEIGHT)));
    }

    #[test]
    fn resize_records_size_and_maximized_keeps_normal_size() {
        let mut layout = WindowLayout::default();
        record_resize(&mut layout, 1280, 800, false);
        assert_eq!(
            (layout.width, layout.height, layout.maximized),
            (Some(1280), Some(800), false)
        );
        record_resize(&mut layout, 2560, 1440, true);
        assert_eq!(
            (layout.width, layout.height, layout.maximized),
            (Some(1280), Some(800), true)
        );
    }
}
