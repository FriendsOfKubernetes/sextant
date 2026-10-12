//! Main window geometry: restored on start, recorded (debounced) on resize; subscriptions, sessions and port forwards
//! closed when the window is destroyed and when the application exits.

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

static RESIZE_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        WindowEvent::Resized(_) => schedule_geometry_save(window),
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
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if let RunEvent::Exit | RunEvent::ExitRequested { .. } = event
        && let Some(state) = app.try_state::<AppState>()
    {
        state.close_all();
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
