//! The tray icon (notification area on Windows, menu bar on macOS, StatusNotifier/AppIndicator on Linux) and its
//! menu: "Show/Hide Sextant", "About Sextant…", "Quit Sextant".
//!
//! The icon is created once at start ([`install`]). When it cannot be created (Linux without the AppIndicator
//! library, a platform error), or on Linux when no StatusNotifier host would show it (GNOME without the AppIndicator
//! extension), the app runs as before: [`available`] is `false`, closing the window quits, and Settings says why
//! "keep in the tray" is off (`tray_status`). Menu texts come from `src/locales/en/tray.json`.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::events;
use crate::window::{self, MAIN_WINDOW};

/// Menu item ids.
pub const SHOW_HIDE: &str = "show-hide";
pub const ABOUT: &str = "about";
pub const QUIT: &str = "quit";

const TRAY_ID: &str = "sextant";

/// The product name the Linux StatusNotifier item shows (not a translated text).
#[cfg(any(target_os = "linux", test))]
const APP_NAME: &str = "Sextant";

/// The native menu cannot use the window's i18next, so its texts are read from the same translation folder when the
/// app is built.
static TEXTS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/en/tray.json")).unwrap_or_default()
});

/// The text under `key` in `tray.json`; the key itself if the file lacks it (a test keeps every key there).
fn text_of(key: &'static str) -> &'static str {
    TEXTS.get(key).map_or(key, String::as_str)
}

/// What "Show/Hide" does now, and so what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowToggle {
    Show,
    Hide,
}

impl WindowToggle {
    /// For a window in this state: a hidden or minimized window is brought back, a window on screen is hidden.
    pub fn for_window(visible: bool, minimized: bool) -> Self {
        if visible && !minimized {
            Self::Hide
        } else {
            Self::Show
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Show => text_of("show"),
            Self::Hide => text_of("hide"),
        }
    }
}

/// Managed state: whether the icon exists, and its "Show/Hide" item (its text follows the window).
struct TrayState<R: Runtime> {
    show_hide: Option<MenuItem<R>>,
    /// The text the item has now: `true` = "Show". Resizing calls [`sync_label`] on every frame; the menu is only
    /// touched when the text changes.
    says_show: AtomicBool,
}

/// Creates the tray icon. Never fails the start: on an error (or a panic of the platform library, which Linux
/// raises when no AppIndicator library is installed) it logs once and returns `false`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> bool {
    let show_hide = match std::panic::catch_unwind(AssertUnwindSafe(|| build(app))) {
        Ok(Ok(item)) => Some(item),
        Ok(Err(e)) => {
            eprintln!("Sextant: no tray icon: {e}");
            None
        }
        Err(_) => {
            eprintln!("Sextant: no tray icon: the system tray library could not be loaded");
            None
        }
    };
    let available = show_hide.is_some();
    let says_show = app
        .get_webview_window(MAIN_WINDOW)
        .is_some_and(|w| current_toggle(&w) == WindowToggle::Show);
    app.manage(TrayState {
        show_hide,
        says_show: AtomicBool::new(says_show),
    });
    available
}

/// Whether the tray icon is there for the user: it was created and, on Linux, a StatusNotifier host shows it now.
/// Asked again before every hide, since the host can go away later (a panel restart, an extension turned off). On
/// Linux this is a D-Bus round trip of at most about a second each way: call it on the blocking pool, never on the
/// event loop (a window event) or the async runtime.
pub fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    icon_created(app) && status_notifier::host_present()
}

/// Whether the icon was created at start (no system call).
pub fn icon_created<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TrayState<R>>()
        .is_some_and(|state| state.show_hide.is_some())
}

/// Linux shows a tray icon only through a StatusNotifier host: the watcher `org.kde.StatusNotifierWatcher` must have
/// an owner on the session bus and say a host is registered. Without one the icon silently shows nowhere.
#[cfg(any(target_os = "linux", test))]
pub fn host_shows_icons(watcher_owned: bool, host_registered: bool) -> bool {
    watcher_owned && host_registered
}

#[cfg(target_os = "linux")]
mod status_notifier {
    use std::time::Duration;

    use dbus::blocking::Connection;
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;

    const WATCHER: &str = "org.kde.StatusNotifierWatcher";
    const TIMEOUT: Duration = Duration::from_secs(1);

    /// Any failure (no session bus, a timeout, an odd reply) counts as "no host": the window must never be hidden
    /// where nothing can bring it back.
    pub fn host_present() -> bool {
        let Ok(conn) = Connection::new_session() else {
            return false;
        };
        let bus = conn.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", TIMEOUT);
        let owned = bus
            .method_call::<(bool,), _, _, _>("org.freedesktop.DBus", "NameHasOwner", (WATCHER,))
            .is_ok_and(|(owned,)| owned);
        let registered = owned
            && conn
                .with_proxy(WATCHER, "/StatusNotifierWatcher", TIMEOUT)
                .get::<bool>(WATCHER, "IsStatusNotifierHostRegistered")
                .unwrap_or(false);
        super::host_shows_icons(owned, registered)
    }
}

#[cfg(not(target_os = "linux"))]
mod status_notifier {
    /// Windows and macOS always have a notification area / menu bar.
    pub fn host_present() -> bool {
        true
    }
}

/// Sets the "Show/Hide" text to what the item would do now.
pub fn show_label<R: Runtime>(app: &AppHandle<R>, toggle: WindowToggle) {
    if let Some(state) = app.try_state::<TrayState<R>>()
        && let Some(item) = &state.show_hide
    {
        let says_show = toggle == WindowToggle::Show;
        if state.says_show.swap(says_show, Ordering::SeqCst) != says_show {
            let _ = item.set_text(toggle.label());
        }
    }
}

/// Reads the window's state and sets the "Show/Hide" text from it (after a minimize, a focus change).
pub fn sync_label<R: Runtime>(app: &AppHandle<R>) {
    if !icon_created(app) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        show_label(app, current_toggle(&window));
    }
}

fn current_toggle<R: Runtime>(window: &tauri::WebviewWindow<R>) -> WindowToggle {
    WindowToggle::for_window(
        window.is_visible().unwrap_or(true),
        window.is_minimized().unwrap_or(false),
    )
}

fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItem<R>> {
    let toggle = app
        .get_webview_window(MAIN_WINDOW)
        .map_or(WindowToggle::Hide, |w| current_toggle(&w));
    let show_hide = MenuItem::with_id(app, SHOW_HIDE, toggle.label(), true, None::<&str>)?;
    let about = MenuItem::with_id(app, ABOUT, text_of("about"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, text_of("quit"), true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show_hide,
            &PredefinedMenuItem::separator(app)?,
            &about,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip(text_of("tooltip"))
        // Windows: a left click brings the window back, the menu is on the right button.
        .show_menu_on_left_click(!cfg!(windows))
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| on_icon(tray.app_handle(), &event));
    #[cfg(target_os = "macos")]
    let builder = builder
        .icon(tauri::include_image!("icons/tray-template.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.icon(tauri::include_image!("icons/64x64.png"));
    name_indicator();
    builder.build(app)?;
    Ok(show_hide)
}

/// Linux: the StatusNotifier item (libappindicator) is named by GLib's application name and falls back to the
/// program name (`sextant`), so "Sextant" is set before the item is created. tray-icon's own `title` is a text
/// label drawn beside the icon, not the item's name.
#[cfg(target_os = "linux")]
fn name_indicator() {
    glib::set_application_name(APP_NAME);
}

#[cfg(not(target_os = "linux"))]
fn name_indicator() {}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        SHOW_HIDE => toggle_window(app),
        ABOUT => {
            window::reveal(app);
            let _ = app.emit(events::OPEN_ABOUT, ());
        }
        // The usual way out: `ExitRequested`/`Exit` close everything (`AppState::close_all`).
        QUIT => app.exit(0),
        _ => {}
    }
}

fn on_icon<R: Runtime>(app: &AppHandle<R>, event: &TrayIconEvent) {
    if cfg!(windows)
        && let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
    {
        window::reveal(app);
    }
}

fn toggle_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    match current_toggle(&window) {
        WindowToggle::Show => window::reveal(app),
        WindowToggle::Hide => {
            let _ = window.hide();
            show_label(app, WindowToggle::Show);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_on_screen_is_hidden_and_any_other_is_shown() {
        assert_eq!(WindowToggle::for_window(true, false), WindowToggle::Hide);
        assert_eq!(WindowToggle::for_window(false, false), WindowToggle::Show);
        assert_eq!(WindowToggle::for_window(true, true), WindowToggle::Show);
        assert_eq!(WindowToggle::for_window(false, true), WindowToggle::Show);
        assert_eq!(WindowToggle::Show.label(), "Show Sextant");
        assert_eq!(WindowToggle::Hide.label(), "Hide Sextant");
    }

    #[test]
    fn on_linux_the_icon_shows_only_with_a_status_notifier_host() {
        assert!(!host_shows_icons(false, false), "no watcher on the bus");
        assert!(!host_shows_icons(false, true), "no watcher on the bus");
        assert!(!host_shows_icons(true, false), "a watcher without a host");
        assert!(host_shows_icons(true, true));
    }

    #[test]
    fn every_menu_text_comes_from_the_translation_file() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../src/locales/en/tray.json")).unwrap();
        for key in ["show", "hide", "about", "quit", "tooltip"] {
            let text = file[key]
                .as_str()
                .unwrap_or_else(|| panic!("tray.json has no `{key}`"));
            assert_eq!(text_of(key), text);
        }
        assert_eq!(WindowToggle::Show.label(), file["show"].as_str().unwrap());
        assert_eq!(WindowToggle::Hide.label(), file["hide"].as_str().unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_status_notifier_item_is_named_sextant_not_after_the_program() {
        glib::set_prgname(Some("sextant"));
        name_indicator();
        assert_eq!(glib::application_name().as_deref(), Some("Sextant"));
    }

    #[test]
    fn without_an_installed_icon_the_tray_is_unavailable() {
        let app = tauri::test::mock_app();
        assert!(!available(app.handle()));
        app.manage(TrayState::<tauri::test::MockRuntime> {
            show_hide: None,
            says_show: AtomicBool::new(false),
        });
        assert!(!available(app.handle()));
        sync_label(app.handle());
        show_label(app.handle(), WindowToggle::Show);
    }
}
