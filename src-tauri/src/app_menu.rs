//! The application menu of macOS. Tauri's default menu has "Close Window" on Cmd+W, so Cmd+W closed the whole window
//! (and, without "keep in the tray", quit) instead of the dock tab in front. This menu is Tauri's default with three
//! changes:
//! - File → "Close Tab" (Cmd+W) asks the window (`close-tab`): it closes the active dock tab, or, with nothing to close,
//!   the window itself (`window_close`), as a tabbed macOS app does; "Close Window" (Shift+Cmd+W) closes the window.
//! - "About Sextant" opens the window's own About dialog (as the tray menu does), not the system panel.
//! - "Settings…" (Cmd+,) opens Settings, where macOS users look for them.
//!
//! The window closes through `Window::close`, so `CloseRequested` decides as for the red button (keep in the tray).
//! Built on every platform (so it is compiled and tested on Linux) but set only on macOS: Linux and Windows show no
//! menu bar, and there Ctrl+W is handled in the window (`src/layout/dock/closeShortcut.ts`). The items' texts are
//! English, as the rest of the menu Tauri and macOS provide.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

use crate::{events, window};

pub const CLOSE_TAB: &str = "app-close-tab";
pub const CLOSE_WINDOW: &str = "app-close-window";
pub const SETTINGS: &str = "app-settings";
pub const ABOUT: &str = "app-about";
const FILE_SUBMENU: &str = "app-file";

// Set on macOS only (see the header); elsewhere only the tests build it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &MenuItem::with_id(app, ABOUT, format!("About {name}"), true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_id_and_items(
        app,
        FILE_SUBMENU,
        "File",
        true,
        &[
            &MenuItem::with_id(app, CLOSE_TAB, "Close Tab", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(
                app,
                CLOSE_WINDOW,
                "Close Window",
                true,
                Some("CmdOrCtrl+Shift+W"),
            )?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;
    // Tauri's "Window" menu without its "Close Window", whose fixed Cmd+W is the one this menu moves.
    let window_menu = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
        ],
    )?;
    let help_menu =
        Submenu::with_id_and_items(app, tauri::menu::HELP_SUBMENU_ID, "Help", true, &[])?;
    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

/// The app menu's items; every other id (the tray's) is left to its own handler.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        CLOSE_TAB => {
            let _ = app.emit(events::CLOSE_TAB, ());
        }
        CLOSE_WINDOW => window::close_main(app),
        SETTINGS => {
            window::reveal(app);
            let _ = app.emit(events::OPEN_SETTINGS, ());
        }
        ABOUT => {
            window::reveal(app);
            let _ = app.emit(events::OPEN_ABOUT, ());
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_moves_cmd_w_from_the_window_to_the_tab() {
        let app = tauri::test::mock_app();
        let menu = build(app.handle()).expect("the menu builds");
        let file = menu
            .get(FILE_SUBMENU)
            .and_then(|item| item.as_submenu().cloned())
            .expect("a File menu");
        let close_tab = file.get(CLOSE_TAB).expect("Close Tab");
        assert_eq!(
            close_tab.as_menuitem().unwrap().text().unwrap(),
            "Close Tab"
        );
        assert!(file.get(CLOSE_WINDOW).is_some());
        let window_menu = menu
            .get(tauri::menu::WINDOW_SUBMENU_ID)
            .and_then(|item| item.as_submenu().cloned())
            .expect("a Window menu");
        // Minimize and Zoom only: no predefined "Close Window" holding Cmd+W.
        assert_eq!(window_menu.items().unwrap().len(), 2);
    }

    #[test]
    fn menu_ids_do_not_collide_with_the_tray_menu() {
        for id in [CLOSE_TAB, CLOSE_WINDOW, SETTINGS, ABOUT] {
            assert!(
                ![
                    crate::tray::SHOW_HIDE,
                    crate::tray::ABOUT,
                    crate::tray::QUIT
                ]
                .contains(&id)
            );
        }
    }
}
