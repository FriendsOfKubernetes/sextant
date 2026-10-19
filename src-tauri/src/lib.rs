//! Sextant desktop application: Tauri state, commands, events, local PTY.

pub mod access_guard;
pub mod commands;
pub mod download;
pub mod events;
pub mod extensions;
pub mod gitops_install;
pub mod malloc;
pub mod mcp;
pub mod mcp_proxy;
pub mod pty;
pub mod state;
// The tray exists on the desktop only (as the window code in `window.rs`); elsewhere there is no icon.
#[cfg(desktop)]
mod tray;
#[cfg(not(desktop))]
mod tray {
    /// No tray off the desktop: closing the window quits, Settings offers no "keep in the tray".
    pub fn available<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> bool {
        false
    }

    /// No menu to relabel.
    pub fn set_texts<R: tauri::Runtime>(
        _app: &tauri::AppHandle<R>,
        _texts: &crate::commands::tray::TrayTexts,
    ) {
    }
}
mod window;

use tauri::{Emitter, Manager, Runtime};

pub use state::AppState;

/// Registers every command. Shared by [`run`] and the tests (which use Tauri's mock runtime).
pub fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    use commands::*;
    builder.invoke_handler(tauri::generate_handler![
        clusters::clusters_list,
        clusters::kubeconfig_sources,
        clusters::kubeconfig_add_file,
        clusters::kubeconfig_add_pasted,
        clusters::kubeconfig_remove,
        commands::kubeconfig::kubeconfig_edit_preview,
        commands::kubeconfig::kubeconfig_edit_apply,
        commands::kubeconfig::kubeconfig_credentials,
        commands::kubeconfig::kubeconfig_edit_target,
        commands::kubeconfig::kubeconfig_validate,
        commands::kubeconfig::kubeconfig_check_connection,
        clusters::cluster_connect,
        clusters::cluster_disconnect,
        clusters::cluster_state,
        clusters::cluster_kinds,
        clusters::cluster_kinds_refresh,
        cloud::cloud_status,
        cloud::cloud_accounts,
        cloud::cloud_find,
        cloud::cloud_import,
        cloud::cloud_login_hint,
        resources::watch_start,
        resources::watch_stop,
        resources::streams_reset,
        resources::resource_get,
        resources::resource_replace,
        resources::resource_apply,
        resources::resource_dry_run,
        resources::resource_delete,
        secrets::secret_value,
        secrets::resource_get_full,
        commands::tls::tls_certificate_info,
        commands::tls::tls_expiry_scan,
        actions::workload_scale,
        actions::workload_restart,
        actions::node_cordon,
        actions::node_drain_preview,
        actions::node_drain,
        actions::cronjob_trigger,
        actions::cronjob_suspend,
        actions::resource_patch,
        logs::logs_start,
        logs::logs_stop,
        terminal::exec_start,
        terminal::terminal_start,
        terminal::node_shell_start,
        terminal::debug_start,
        terminal::term_input,
        terminal::term_resize,
        terminal::term_stop,
        terminal::term_ack,
        portforward::portforward_start,
        portforward::portforward_list,
        portforward::portforward_stop,
        metrics::metrics_pods,
        metrics::metrics_nodes,
        metrics::metrics_status,
        metrics::metrics_charts,
        metrics::metrics_usage_history,
        helm::helm_status,
        helm::helm_releases,
        helm::helm_release_detail,
        helm::helm_release_history,
        helm::helm_upgrade,
        helm::helm_rollback,
        helm::helm_uninstall,
        helm::helm_install,
        helm::helm_upgrade_preview,
        helm::helm_install_preview,
        helm::helm_preview_stop,
        helm::helm_repos,
        helm::helm_repo_add,
        helm::helm_repo_remove,
        helm::helm_repo_update,
        helm::helm_search,
        helm::helm_show_values,
        settings::settings_get,
        settings::settings_update,
        settings::settings_status,
        commands::tray::tray_status,
        commands::tray::tray_set_texts,
        commands::about::about_info,
        commands::gitops_install::gitops_install_versions,
        commands::gitops_install::gitops_install_prepare,
        commands::gitops_install::gitops_install_start,
        commands::gitops_install::gitops_install_stop,
        commands::gitops_install::gitops_install_status,
        files::file_save,
        commands::views::views_import_open,
        files::files_stat,
        files::files_download_start,
        files::files_upload_start,
        files::files_transfer_stop,
        argocd::argocd_status,
        argocd::argocd_login,
        argocd::argocd_logout,
        argocd::argocd_diff,
        access::access_preset_rules,
        commands::rbac::rbac_can_i,
        commands::rbac::rbac_rules_review,
        commands::upgrade::upgrade_scan,
        commands::cleanup::cleanup_sample,
        commands::cleanup::cleanup_cluster_check,
        commands::timeline::timeline_managers,
        commands::timeline::timeline_history,
        commands::timeline::timeline_object_history,
        commands::timeline::timeline_save,
        commands::timeline::timeline_load,
        commands::timeline::timeline_remove_all,
        commands::mcp::mcp_status,
        commands::mcp::mcp_token,
        commands::mcp::mcp_regenerate_token,
        commands::mcp::mcp_audit_list,
        commands::mcp::mcp_audit_clear,
        commands::mcp::mcp_confirm_answer,
        commands::mcp::mcp_binary_path,
        extensions::manage::extensions_list,
        extensions::manage::extension_inspect_file,
        extensions::manage::extension_inspect_url,
        extensions::manage::extension_inspect_folder,
        extensions::manage::extension_install,
        extensions::manage::extension_install_cancel,
        extensions::manage::extension_set_enabled,
        extensions::manage::extension_remove,
        extensions::manage::extension_reload,
        extensions::api::extension_call,
        extensions::api::extension_watch_stop,
        extensions::api::extension_audit_list,
        extensions::api::extension_audit_clear,
    ])
}

/// Forwards core broadcasts (cluster states, port-forward list) to the window as events.
fn spawn_event_forwarders<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();

    let mut states = state.clusters.subscribe_states();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match states.recv().await {
                Ok((cluster_id, state)) => {
                    let _ = handle.emit(
                        events::CLUSTER_STATE,
                        events::ClusterStatePayload { cluster_id, state },
                    );
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });

    let mut forwards = state.forwarder.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        loop {
            match forwards.recv().await {
                Ok(list) => {
                    let _ = handle.emit(events::PORTFORWARDS, list);
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => break,
            }
        }
    });
}

/// Puts a confirmation request (an agent's or an extension's) in front of the user: the main window comes back from
/// the tray or the taskbar, the OS is asked for attention, and the window gets `mcp-confirm`. `false` (the request is
/// declined) only when there is no window at all.
fn ask_in_window<R: Runtime, T: serde::Serialize + Clone>(
    handle: &tauri::AppHandle<R>,
    request: T,
) -> bool {
    let Some(window) = handle.get_webview_window(window::MAIN_WINDOW) else {
        return false;
    };
    window::reveal(handle);
    #[cfg(desktop)]
    let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
    window.emit(events::MCP_CONFIRM, request).is_ok()
}

/// Sends the MCP server's events to the window (a confirmation request also asks the OS for the user's attention)
/// and starts the server when the settings have it on.
fn start_mcp<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<AppState>();
    let handle = app.clone();
    state.mcp.set_emitter(std::sync::Arc::new(move |event| {
        use crate::mcp::McpEvent;
        match event {
            McpEvent::Status(status) => handle.emit(events::MCP_STATUS, status).is_ok(),
            McpEvent::Audit(entry) => handle.emit(events::MCP_AUDIT, entry).is_ok(),
            McpEvent::Confirm(request) => ask_in_window(&handle, request),
        }
    }));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let settings = state.settings.get();
        state.mcp.apply_settings(&settings).await;
    });
}

/// Sends the extension host's and the extension API's events to the window and starts looking at development folders.
/// An extension that stops being active (disabled, removed, waiting for consent) or is granted anything else loses its
/// watch streams at once.
fn start_extensions<R: Runtime>(app: &tauri::AppHandle<R>) {
    let host = app.state::<extensions::ExtensionHost>().inner().clone();
    let handle = app.clone();
    extensions::api::wire_host_events(&host, &app.state::<AppState>().ext_api, move |event| {
        use extensions::HostEvent;
        let _ = match event {
            HostEvent::ListChanged => handle.emit(events::EXTENSIONS_CHANGED, ()),
            HostEvent::FilesChanged { id } => handle.emit(
                events::EXTENSION_FILES_CHANGED,
                events::ExtensionFilesChangedPayload { id },
            ),
        };
    });
    let handle = app.clone();
    app.state::<AppState>()
        .ext_api
        .set_emitter(std::sync::Arc::new(move |event| {
            use extensions::api::ApiEvent;
            match event {
                ApiEvent::Audit(entry) => handle.emit(extensions::api::EXT_AUDIT, entry).is_ok(),
                ApiEvent::Confirm(request) => ask_in_window(&handle, request),
            }
        }));
    extensions::dev::spawn_poller(host);
}

/// Whether `plugins.updater` of the configuration has a public key and an endpoint. Without them the updater
/// plugin is not registered (it would fail at start); the frontend then shows updates as turned off.
pub fn updater_configured(config: &tauri::Config) -> bool {
    let Some(updater) = config.plugins.0.get("updater") else {
        return false;
    };
    let pubkey = updater.get("pubkey").and_then(|v| v.as_str()).unwrap_or("");
    let has_endpoint = updater
        .get("endpoints")
        .and_then(|v| v.as_array())
        .is_some_and(|list| {
            list.iter()
                .any(|e| e.as_str().is_some_and(|s| !s.trim().is_empty()))
        });
    !pubkey.trim().is_empty() && has_endpoint
}

/// In-app updates (desktop only): the updater checks and installs signed releases, `process` restarts the app.
#[cfg(desktop)]
fn with_updates<R: Runtime>(
    builder: tauri::Builder<R>,
    config: &tauri::Config,
) -> tauri::Builder<R> {
    let builder = builder.plugin(tauri_plugin_process::init());
    if updater_configured(config) {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    }
}

#[cfg(not(desktop))]
fn with_updates<R: Runtime>(
    builder: tauri::Builder<R>,
    _config: &tauri::Config,
) -> tauri::Builder<R> {
    builder
}

/// The single-instance callback: a second launch of Sextant (its arguments and working directory are not used) brings
/// the running window back with `reveal`, from the tray, the taskbar or behind other windows. Used by release
/// builds only (see [`with_single_instance`]).
#[cfg_attr(debug_assertions, allow(dead_code))]
fn on_second_instance<R: Runtime>(
    reveal: fn(&tauri::AppHandle<R>),
) -> impl FnMut(&tauri::AppHandle<R>, Vec<String>, String) + Send + Sync + 'static {
    move |app, _args, _cwd| reveal(app)
}

/// One Sextant per user (desktop release builds only). Registered before every other plugin, so a second process hands over to the
/// running one and exits during `build`, before the app's `setup`: it never creates `AppState`, writes
/// `settings.json`, starts the MCP server or sweeps node-shell pods. The running one reveals its window.
///
/// The instance is told apart by the bundle identifier (`dev.sextant.app`: a D-Bus name on Linux, a named mutex on
/// Windows, a socket on macOS), which a development build (`npm run tauri dev`, `target/debug/sextant`, e2e) shares
/// with an installed copy. Debug builds therefore do not register the plugin: they run beside an installed Sextant
/// (sharing its settings directory, as before) instead of handing over to it and exiting. Without a session bus
/// (Linux) the plugin cannot look and Sextant starts as before.
#[cfg(all(desktop, not(debug_assertions)))]
fn with_single_instance<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.plugin(tauri_plugin_single_instance::init(on_second_instance(
        window::reveal::<R>,
    )))
}

#[cfg(any(not(desktop), debug_assertions))]
fn with_single_instance<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
}

/// Whether an action on one of Sextant's desktop notifications brings the window back: a click on the notification
/// itself (`tap`, the page then opens the object). Its "Mute for 1 hour" button does not.
fn notification_action_reveals(action_id: &str) -> bool {
    action_id == "tap"
}

/// A click on a notification about a cluster problem reveals the window, from the tray too (the page, which hears the
/// same action through the plugin, opens the object). Registered before any notification is shown, so every one
/// reports its clicks.
fn reveal_on_notification_click<R: Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_notification::NotificationExt;
    let handle = app.clone();
    let _ = app.notification().on_action(move |performed| {
        if notification_action_reveals(performed.action_id()) {
            window::reveal(&handle);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let builder = with_single_instance(tauri::Builder::default());
    let builder = extensions::protocol::register(with_commands(builder))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());
    with_updates(builder, context.config())
        .setup(|app| {
            // Temporary kubeconfigs of a Sextant that crashed or was killed: no session owns them now.
            sextant_core::kubeconfig::remove_stale_temp_kubeconfigs(&std::env::temp_dir());
            let paths = app.path();
            let data_dir = paths.app_data_dir()?;
            let state = AppState::new(&paths.app_config_dir()?, &data_dir);
            let extensions =
                extensions::ExtensionHost::new(&data_dir, std::sync::Arc::clone(&state.settings));
            app.manage(state);
            app.manage(extensions);
            app.manage(commands::timeline::TimelineDir(data_dir.join("timeline")));
            spawn_event_forwarders(app.handle());
            start_mcp(app.handle());
            start_extensions(app.handle());
            window::restore_main_window(app.handle());
            reveal_on_notification_click(app.handle());
            // After the window is shown, so "Show/Hide" starts with the right text; no icon is not an error.
            #[cfg(desktop)]
            crate::tray::install(app.handle());
            Ok(())
        })
        .on_window_event(window::on_window_event)
        .build(context)
        .expect("error while building Sextant")
        .run(|app, event| window::on_run_event(app, &event));
}

#[cfg(test)]
mod tests {
    use super::updater_configured;

    #[test]
    fn only_a_click_on_a_notification_reveals_the_window() {
        assert!(super::notification_action_reveals("tap"));
        assert!(!super::notification_action_reveals("mute-hour"));
        assert!(!super::notification_action_reveals("dismiss"));
    }

    #[test]
    fn a_confirmation_request_is_declined_only_without_the_main_window() {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        assert!(!super::ask_in_window(app.handle(), "request-1"));

        let window =
            tauri::WebviewWindowBuilder::new(&app, super::window::MAIN_WINDOW, Default::default())
                .build()
                .unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        window.listen(super::events::MCP_CONFIRM, move |event| {
            let _ = tx.send(event.payload().to_owned());
        });
        assert!(super::ask_in_window(app.handle(), "request-2"));
        assert_eq!(
            rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(),
            "\"request-2\""
        );
    }

    #[test]
    fn a_second_launch_reveals_the_running_window() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static REVEALED: AtomicUsize = AtomicUsize::new(0);
        fn reveal(_: &tauri::AppHandle<tauri::test::MockRuntime>) {
            REVEALED.fetch_add(1, Ordering::SeqCst);
        }
        let app = tauri::test::mock_app();
        let mut callback = super::on_second_instance(reveal);
        callback(app.handle(), vec!["sextant".to_owned()], "/".to_owned());
        assert_eq!(REVEALED.load(Ordering::SeqCst), 1);
    }

    fn config(plugins: serde_json::Value) -> tauri::Config {
        let mut config: tauri::Config =
            serde_json::from_value(serde_json::json!({ "identifier": "dev.sextant.test" }))
                .unwrap();
        config.plugins = serde_json::from_value(plugins).unwrap();
        config
    }

    #[test]
    fn updater_needs_a_public_key_and_an_endpoint() {
        let endpoint = "https://example.invalid/latest.json";
        assert!(updater_configured(&config(
            serde_json::json!({ "updater": { "pubkey": "key", "endpoints": [endpoint] } })
        )));
        assert!(!updater_configured(&config(serde_json::json!({}))));
        assert!(!updater_configured(&config(
            serde_json::json!({ "updater": { "pubkey": " ", "endpoints": [endpoint] } })
        )));
        assert!(!updater_configured(&config(
            serde_json::json!({ "updater": { "endpoints": [endpoint] } })
        )));
        assert!(!updater_configured(&config(
            serde_json::json!({ "updater": { "pubkey": "key", "endpoints": [] } })
        )));
    }

    #[test]
    fn the_shipped_configuration_has_the_updater() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(updater_configured(&config));
    }
}
