//! The tray icon (notification area on Windows, menu bar on macOS, StatusNotifier/AppIndicator on Linux) and its
//! menu: "Show/Hide Sextant", "About Sextant…", "Quit Sextant".
//!
//! The icon is created once at start ([`install`]). When it cannot be created (Linux without the AppIndicator
//! library, a platform error), or on Linux when nothing would show it (no StatusNotifier host, as on GNOME without the
//! AppIndicator extension, and no XEmbed tray of an X11 session), the app runs as before: [`available`] is `false`, closing the window quits, and Settings says why
//! "keep in the tray" is off (`tray_status`). Menu texts start as `src/locales/en/tray.json`; the window sends them
//! in its UI language (`tray_set_texts`) whenever that language is set, and the menu is relabelled at once.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, RwLock};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::tray::TrayTexts;
use crate::events;
use crate::window::{self, MAIN_WINDOW};

/// Menu item ids.
pub const SHOW_HIDE: &str = "show-hide";
pub const ABOUT: &str = "about";
pub const QUIT: &str = "quit";

const TRAY_ID: &str = "sextant";

/// The product name the Linux StatusNotifier item shows (not a translated text).
#[cfg(target_os = "linux")]
const APP_NAME: &str = "Sextant";

/// The longest menu text kept from the window (in characters); a longer one is cut.
const MAX_TEXT_CHARS: usize = 80;

/// The English texts, read from the translation folder when the app is built: the menu has them until the window
/// sends its language, and keeps them for any text the window sends empty.
static ENGLISH: LazyLock<TrayTexts> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/en/tray.json")).unwrap_or_else(|_| {
        TrayTexts {
            show: "show".into(),
            hide: "hide".into(),
            about: "about".into(),
            quit: "quit".into(),
            tooltip: "Sextant".into(),
        }
    })
});

/// The menu texts now: English, then whatever the window last sent (`set_texts`).
static TEXTS: LazyLock<RwLock<TrayTexts>> = LazyLock::new(|| RwLock::new(ENGLISH.clone()));

fn texts() -> TrayTexts {
    TEXTS
        .read()
        .map_or_else(|e| e.into_inner().clone(), |t| t.clone())
}

/// Unicode format characters (category Cf): bidirectional overrides and isolates (which could make a label read
/// backwards), zero-width characters, the BOM, tags. None belongs in a menu label of Sextant's languages.
fn is_format(c: char) -> bool {
    matches!(c,
        '\u{00AD}'
        | '\u{0600}'..='\u{0605}'
        | '\u{061C}'
        | '\u{06DD}'
        | '\u{070F}'
        | '\u{0890}'..='\u{0891}'
        | '\u{08E2}'
        | '\u{180E}'
        | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206F}'
        | '\u{FEFF}'
        | '\u{FFF9}'..='\u{FFFB}'
        | '\u{110BD}'
        | '\u{110CD}'
        | '\u{13430}'..='\u{1343F}'
        | '\u{1BCA0}'..='\u{1BCA3}'
        | '\u{1D173}'..='\u{1D17A}'
        | '\u{E0001}'
        | '\u{E0020}'..='\u{E007F}')
}

/// A label as the menu library reads it: `&` marks a mnemonic on every platform (muda turns it into GTK's `_` and
/// escapes a literal `_` itself), so a literal `&` is written `&&`.
fn menu_text(label: &str) -> String {
    label.replace('&', "&&")
}

/// One text from the window: control and format characters dropped, trimmed, cut to [`MAX_TEXT_CHARS`]; the English
/// one when nothing is left.
fn clean(text: &str, english: &str) -> String {
    let text: String = text
        .chars()
        .filter(|c| !c.is_control() && !is_format(*c))
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect();
    if text.is_empty() {
        english.to_owned()
    } else {
        text
    }
}

/// The texts as the menu will show them (see [`clean`]).
fn cleaned(texts: &TrayTexts) -> TrayTexts {
    let english = &*ENGLISH;
    TrayTexts {
        show: clean(&texts.show, &english.show),
        hide: clean(&texts.hide, &english.hide),
        about: clean(&texts.about, &english.about),
        quit: clean(&texts.quit, &english.quit),
        tooltip: clean(&texts.tooltip, &english.tooltip),
    }
}

/// Takes the window's texts (its UI language) and relabels the menu and the tooltip, if the icon exists.
pub fn set_texts<R: Runtime>(app: &AppHandle<R>, texts: &TrayTexts) {
    let next = cleaned(texts);
    match TEXTS.write() {
        Ok(mut guard) => *guard = next.clone(),
        Err(e) => *e.into_inner() = next.clone(),
    }
    let Some(state) = app.try_state::<TrayState<R>>() else {
        return;
    };
    if let Some(item) = &state.show_hide {
        let says_show = state.says_show.load(Ordering::SeqCst);
        let _ = item.set_text(menu_text(if says_show { &next.show } else { &next.hide }));
    }
    if let Some(item) = &state.about {
        let _ = item.set_text(menu_text(&next.about));
    }
    if let Some(item) = &state.quit {
        let _ = item.set_text(menu_text(&next.quit));
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(&next.tooltip));
    }
}

/// What "Show/Hide" does now, and so what it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowToggle {
    Show,
    Hide,
}

impl WindowToggle {
    /// Linux: only a visible window that has the focus is hidden; any other (hidden, minimized, behind other windows)
    /// is brought back. The focus stands in for "minimized", which GTK on Wayland never reports, while a minimize
    /// always takes the focus away.
    #[cfg(any(target_os = "linux", test))]
    pub fn by_focus(visible: bool, focused: bool) -> Self {
        if visible && focused {
            Self::Hide
        } else {
            Self::Show
        }
    }

    /// Windows and macOS: a hidden or minimized window is brought back, a window on screen is hidden. They report the
    /// minimized state, and opening the tray menu takes the focus from the window, so the focus would say nothing.
    #[cfg(any(not(target_os = "linux"), test))]
    pub fn by_minimized(visible: bool, minimized: bool) -> Self {
        if visible && !minimized {
            Self::Hide
        } else {
            Self::Show
        }
    }

    pub fn label(self) -> String {
        let texts = texts();
        match self {
            Self::Show => texts.show,
            Self::Hide => texts.hide,
        }
    }
}

/// Managed state: whether the icon exists, and its items ("Show/Hide" follows the window; all follow the language).
struct TrayState<R: Runtime> {
    show_hide: Option<MenuItem<R>>,
    about: Option<MenuItem<R>>,
    quit: Option<MenuItem<R>>,
    /// The text the item has now: `true` = "Show". Resizing calls [`sync_label`] on every frame; the menu is only
    /// touched when the text changes.
    says_show: AtomicBool,
}

/// Creates the tray icon. Never fails the start: on an error (or a panic of the platform library, which Linux
/// raises when no AppIndicator library is installed) it logs once and returns `false`.
pub fn install<R: Runtime>(app: &AppHandle<R>) -> bool {
    let items = match std::panic::catch_unwind(AssertUnwindSafe(|| build(app))) {
        Ok(Ok(items)) => Some(items),
        Ok(Err(e)) => {
            eprintln!("Sextant: no tray icon: {e}");
            None
        }
        Err(_) => {
            eprintln!("Sextant: no tray icon: the system tray library could not be loaded");
            None
        }
    };
    let available = items.is_some();
    let says_show = app
        .get_webview_window(MAIN_WINDOW)
        .is_some_and(|w| current_toggle(&w) == WindowToggle::Show);
    let (show_hide, about, quit) = match items {
        Some((show_hide, about, quit)) => (Some(show_hide), Some(about), Some(quit)),
        None => (None, None, None),
    };
    app.manage(TrayState {
        show_hide,
        about,
        quit,
        says_show: AtomicBool::new(says_show),
    });
    available
}

/// Whether the tray icon is there for the user: it was created and, on Linux, something shows it now (a
/// StatusNotifier host, or an XEmbed tray of an X11 session). Asked again before every hide, since the host can go
/// away later (a panel restart, an extension turned off). On Linux this is a D-Bus round trip of at most about a
/// second each way, and maybe a round trip to the X server: call it on the blocking pool, never on the event loop (a
/// window event) or the async runtime.
pub fn available<R: Runtime>(app: &AppHandle<R>) -> bool {
    icon_created(app) && shown_somewhere()
}

#[cfg(target_os = "linux")]
fn shown_somewhere() -> bool {
    linux_tray_shown(status_notifier::host_present(), xembed::tray_present())
}

#[cfg(not(target_os = "linux"))]
fn shown_somewhere() -> bool {
    // Windows and macOS always have a notification area / menu bar.
    true
}

/// Whether the icon was created at start (no system call).
pub fn icon_created<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<TrayState<R>>()
        .is_some_and(|state| state.show_hide.is_some())
}

/// Whether a Linux desktop shows the icon. libayatana-appindicator exports it to a StatusNotifier host (the watcher
/// `org.kde.StatusNotifierWatcher` has an owner on the session bus and says a host is registered); without one it
/// falls back to an XEmbed icon, which an X11 session shows when a tray owns its `_NET_SYSTEM_TRAY_S<screen>`
/// selection (i3bar, older XFCE). With neither the icon silently shows nowhere.
#[cfg(any(target_os = "linux", test))]
pub fn linux_tray_shown(sni_host: bool, xembed_tray: bool) -> bool {
    sni_host || xembed_tray
}

/// Whether GTK draws this app through X11, where the XEmbed fallback works: `GDK_BACKEND` asks for X11, or there is
/// no Wayland display to prefer. A Wayland session without a StatusNotifier host shows no icon.
#[cfg(any(target_os = "linux", test))]
fn gtk_on_x11(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    if let Some(backend) = gdk_backend.filter(|b| !b.is_empty()) {
        return backend
            .split(',')
            .next()
            .is_some_and(|first| first.trim() == "x11");
    }
    wayland_display.is_none_or(str::is_empty)
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
        owned && registered
    }
}

#[cfg(target_os = "linux")]
mod xembed {
    use std::ffi::CString;

    use x11_dl::xlib::{self, Xlib};

    /// Whether an XEmbed tray runs on this X11 screen: the selection `_NET_SYSTEM_TRAY_S<screen>` has an owner. Any
    /// failure (a Wayland session, no libX11, no display) counts as "no tray". libX11 is loaded at run time, as tao
    /// does, so nothing new is linked.
    pub fn tray_present() -> bool {
        let wayland = std::env::var("WAYLAND_DISPLAY").ok();
        let backend = std::env::var("GDK_BACKEND").ok();
        if !super::gtk_on_x11(wayland.as_deref(), backend.as_deref()) {
            return false;
        }
        let Ok(x) = Xlib::open() else {
            return false;
        };
        // SAFETY: a private connection used only on this thread and closed before returning (tao has already called
        // `XInitThreads`); the atom name is a valid C string.
        unsafe {
            let display = (x.XOpenDisplay)(std::ptr::null());
            if display.is_null() {
                return false;
            }
            let screen = (x.XDefaultScreen)(display);
            let owned = CString::new(format!("_NET_SYSTEM_TRAY_S{screen}")).is_ok_and(|name| {
                // `only_if_exists`: no atom means no tray ever claimed it.
                let atom = (x.XInternAtom)(display, name.as_ptr(), xlib::True);
                atom != 0 && (x.XGetSelectionOwner)(display, atom) != 0
            });
            (x.XCloseDisplay)(display);
            owned
        }
    }
}

/// Sets the "Show/Hide" text to what the item would do now.
pub fn show_label<R: Runtime>(app: &AppHandle<R>, toggle: WindowToggle) {
    if let Some(state) = app.try_state::<TrayState<R>>()
        && let Some(item) = &state.show_hide
    {
        let says_show = toggle == WindowToggle::Show;
        if state.says_show.swap(says_show, Ordering::SeqCst) != says_show {
            let _ = item.set_text(menu_text(&toggle.label()));
        }
    }
}

/// Reads the window's state and sets the "Show/Hide" text from it (after a resize, a hide).
pub fn sync_label<R: Runtime>(app: &AppHandle<R>) {
    if !icon_created(app) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        show_label(app, current_toggle(&window));
    }
}

/// Sets the "Show/Hide" text after the window gained or lost the focus. On Linux the focus is taken from the event
/// itself (the window's own flag can lag behind it): a minimize, which GTK on Wayland never reports, lands here as a
/// lost focus. Elsewhere the window's state is read, as in [`sync_label`].
pub fn follow_focus<R: Runtime>(app: &AppHandle<R>, focused: bool) {
    if !icon_created(app) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        #[cfg(target_os = "linux")]
        let toggle = WindowToggle::by_focus(window.is_visible().unwrap_or(true), focused);
        #[cfg(not(target_os = "linux"))]
        let toggle = {
            let _ = focused;
            current_toggle(&window)
        };
        show_label(app, toggle);
    }
}

#[cfg(target_os = "linux")]
fn current_toggle<R: Runtime>(window: &tauri::WebviewWindow<R>) -> WindowToggle {
    WindowToggle::by_focus(
        window.is_visible().unwrap_or(true),
        window.is_focused().unwrap_or(false),
    )
}

#[cfg(not(target_os = "linux"))]
fn current_toggle<R: Runtime>(window: &tauri::WebviewWindow<R>) -> WindowToggle {
    WindowToggle::by_minimized(
        window.is_visible().unwrap_or(true),
        window.is_minimized().unwrap_or(false),
    )
}

type MenuItems<R> = (MenuItem<R>, MenuItem<R>, MenuItem<R>);

/// The icon and its menu; returns the items "Show/Hide", "About" and "Quit".
fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<MenuItems<R>> {
    let toggle = app
        .get_webview_window(MAIN_WINDOW)
        .map_or(WindowToggle::Hide, |w| current_toggle(&w));
    let texts = texts();
    let show_hide = MenuItem::with_id(
        app,
        SHOW_HIDE,
        menu_text(&toggle.label()),
        true,
        None::<&str>,
    )?;
    let about = MenuItem::with_id(app, ABOUT, menu_text(&texts.about), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, menu_text(&texts.quit), true, None::<&str>)?;
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
        .tooltip(&texts.tooltip)
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
    Ok((show_hide, about, quit))
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
    fn on_linux_only_a_visible_focused_window_is_hidden_and_any_other_is_shown() {
        assert_eq!(WindowToggle::by_focus(true, true), WindowToggle::Hide);
        assert_eq!(
            WindowToggle::by_focus(true, false),
            WindowToggle::Show,
            "visible without the focus: minimized (GTK on Wayland says it is not) or behind other windows"
        );
        assert_eq!(WindowToggle::by_focus(false, false), WindowToggle::Show);
        assert_eq!(WindowToggle::by_focus(false, true), WindowToggle::Show);
    }

    #[test]
    fn on_windows_and_macos_a_window_on_screen_is_hidden_and_any_other_is_shown() {
        assert_eq!(WindowToggle::by_minimized(true, false), WindowToggle::Hide);
        assert_eq!(WindowToggle::by_minimized(false, false), WindowToggle::Show);
        assert_eq!(WindowToggle::by_minimized(true, true), WindowToggle::Show);
        assert_eq!(WindowToggle::by_minimized(false, true), WindowToggle::Show);
    }

    #[test]
    fn on_linux_the_icon_shows_with_a_status_notifier_host_or_an_xembed_tray() {
        assert!(!linux_tray_shown(false, false), "nothing shows the icon");
        assert!(
            linux_tray_shown(false, true),
            "an XEmbed-only tray (i3bar) shows the fallback icon"
        );
        assert!(linux_tray_shown(true, false));
        assert!(linux_tray_shown(true, true));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn asking_the_x_server_for_a_tray_never_fails_the_caller() {
        // Whatever this machine runs (no display in CI, Wayland, X11), the answer is a plain yes or no.
        let _ = xembed::tray_present();
    }

    #[test]
    fn the_xembed_fallback_is_looked_for_only_when_gtk_draws_through_x11() {
        assert!(gtk_on_x11(None, None), "a plain X11 session");
        assert!(gtk_on_x11(Some(""), None));
        assert!(
            !gtk_on_x11(Some("wayland-0"), None),
            "a Wayland session without a StatusNotifier host stays unavailable"
        );
        assert!(
            gtk_on_x11(Some("wayland-0"), Some("x11")),
            "GTK forced to XWayland"
        );
        assert!(gtk_on_x11(Some("wayland-0"), Some("x11,wayland")));
        assert!(!gtk_on_x11(None, Some("wayland")));
        assert!(!gtk_on_x11(Some("wayland-0"), Some("wayland,x11")));
        assert!(!gtk_on_x11(Some("wayland-0"), Some("")));
    }

    const KEYS: [&str; 5] = ["show", "hide", "about", "quit", "tooltip"];

    #[test]
    fn every_menu_text_comes_from_the_translation_file() {
        let file: serde_json::Value =
            serde_json::from_str(include_str!("../../src/locales/en/tray.json")).unwrap();
        let english = serde_json::to_value(&*ENGLISH).unwrap();
        for key in KEYS {
            let text = file[key]
                .as_str()
                .unwrap_or_else(|| panic!("tray.json has no `{key}`"));
            assert_eq!(english[key], text);
        }
        assert_eq!(english["show"], "Show Sextant");
    }

    #[test]
    fn every_language_has_every_menu_text() {
        // The window sends these keys of `tray` in its language: each locale directory must have them all.
        let locales = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/locales");
        let mut seen = 0;
        for dir in std::fs::read_dir(&locales).unwrap() {
            let dir = dir.unwrap().path();
            if !dir.is_dir() {
                continue;
            }
            let path = dir.join("tray.json");
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let file: TrayTexts =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let file = serde_json::to_value(file).unwrap();
            for key in KEYS {
                assert!(
                    file[key].as_str().is_some_and(|t| !t.trim().is_empty()),
                    "{}: `{key}` is empty",
                    path.display()
                );
            }
            seen += 1;
        }
        assert!(seen >= 1, "no locale directories in {}", locales.display());
    }

    #[test]
    fn labels_lose_format_characters_and_keep_a_literal_ampersand() {
        // A right-to-left override would show "Quit" reversed; zero-width characters and the BOM hide in a label.
        assert_eq!(clean("\u{202E}tiuQ\u{202C}", "x"), "tiuQ");
        assert_eq!(
            clean("\u{FEFF}Sextant\u{200B} an\u{00AD}zeigen\u{2066}", "x"),
            "Sextant anzeigen"
        );
        assert_eq!(clean("\u{200E}\u{200F}", "English"), "English");
        // Ordinary letters of the translations stay (CJK, Cyrillic, Polish, Turkish).
        assert_eq!(clean("退出 Sextant", "x"), "退出 Sextant");
        assert_eq!(
            clean("Zakończ Sextant – Çıkış", "x"),
            "Zakończ Sextant – Çıkış"
        );
        // `&` is the mnemonic marker of the menu library: a literal one is doubled; `_` is left to it.
        assert_eq!(menu_text("Info & Hilfe"), "Info && Hilfe");
        assert_eq!(menu_text("about_sextant"), "about_sextant");
    }

    // The only test that changes the texts (they are process-wide): no other test reads a label.
    #[test]
    fn texts_from_the_window_relabel_the_menu_and_an_empty_one_stays_english() {
        let app = tauri::test::mock_app();
        set_texts(
            app.handle(),
            &TrayTexts {
                show: " Sextant anzeigen\n".into(),
                hide: "Sextant ausblenden".into(),
                about: "".into(),
                quit: "x".repeat(200),
                tooltip: "Sextant".into(),
            },
        );
        assert_eq!(WindowToggle::Show.label(), "Sextant anzeigen");
        assert_eq!(WindowToggle::Hide.label(), "Sextant ausblenden");
        let now = texts();
        assert_eq!(now.about, ENGLISH.about);
        assert_eq!(now.quit.chars().count(), MAX_TEXT_CHARS);
        set_texts(app.handle(), &ENGLISH);
        assert_eq!(WindowToggle::Show.label(), "Show Sextant");
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
            about: None,
            quit: None,
            says_show: AtomicBool::new(false),
        });
        assert!(!available(app.handle()));
        sync_label(app.handle());
        show_label(app.handle(), WindowToggle::Show);
    }
}
