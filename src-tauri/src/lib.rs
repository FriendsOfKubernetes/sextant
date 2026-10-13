//! Sextant desktop application: Tauri state, commands, events, local PTY.

pub mod commands;
pub mod events;
pub mod mcp;
pub mod mcp_proxy;
pub mod pty;
pub mod state;
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
        resources::resource_delete,
        secrets::secret_value,
        secrets::resource_get_full,
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
        terminal::term_input,
        terminal::term_resize,
        terminal::term_stop,
        portforward::portforward_start,
        portforward::portforward_list,
        portforward::portforward_stop,
        metrics::metrics_pods,
        metrics::metrics_nodes,
        metrics::metrics_status,
        metrics::metrics_charts,
        helm::helm_status,
        helm::helm_releases,
        helm::helm_release_detail,
        helm::helm_release_history,
        helm::helm_upgrade,
        helm::helm_rollback,
        helm::helm_uninstall,
        helm::helm_install,
        helm::helm_repos,
        helm::helm_repo_add,
        helm::helm_repo_remove,
        helm::helm_repo_update,
        helm::helm_search,
        helm::helm_show_values,
        settings::settings_get,
        settings::settings_update,
        settings::settings_status,
        files::file_save,
        argocd::argocd_status,
        argocd::argocd_login,
        argocd::argocd_logout,
        argocd::argocd_diff,
        access::access_preset_rules,
        commands::mcp::mcp_status,
        commands::mcp::mcp_token,
        commands::mcp::mcp_regenerate_token,
        commands::mcp::mcp_audit_list,
        commands::mcp::mcp_audit_clear,
        commands::mcp::mcp_confirm_answer,
        commands::mcp::mcp_binary_path,
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
            McpEvent::Confirm(request) => {
                let Some(window) = handle.get_webview_window(window::MAIN_WINDOW) else {
                    return false;
                };
                #[cfg(desktop)]
                let _ = window.request_user_attention(Some(tauri::UserAttentionType::Critical));
                window.emit(events::MCP_CONFIRM, request).is_ok()
            }
        }
    }));
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = handle.state::<AppState>();
        let settings = state.settings.get();
        state.mcp.apply_settings(&settings).await;
    });
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let builder = with_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    with_updates(builder, context.config())
        .setup(|app| {
            // Temporary kubeconfigs of a Sextant that crashed or was killed: no session owns them now.
            sextant_core::kubeconfig::remove_stale_temp_kubeconfigs(&std::env::temp_dir());
            let paths = app.path();
            let state = AppState::new(&paths.app_config_dir()?, &paths.app_data_dir()?);
            app.manage(state);
            spawn_event_forwarders(app.handle());
            start_mcp(app.handle());
            window::restore_main_window(app.handle());
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
