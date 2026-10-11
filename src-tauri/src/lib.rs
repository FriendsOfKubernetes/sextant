//! Sextant desktop application: Tauri state, commands, events, local PTY.

pub mod commands;
pub mod events;
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
        resources::watch_start,
        resources::watch_stop,
        resources::resource_get,
        resources::resource_replace,
        resources::resource_apply,
        resources::resource_delete,
        actions::workload_scale,
        actions::workload_restart,
        actions::node_cordon,
        actions::node_drain,
        actions::cronjob_trigger,
        actions::cronjob_suspend,
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
        files::file_save,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    with_commands(tauri::Builder::default())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let paths = app.path();
            let state = AppState::new(&paths.app_config_dir()?, &paths.app_data_dir()?);
            app.manage(state);
            spawn_event_forwarders(app.handle());
            window::restore_main_window(app.handle());
            Ok(())
        })
        .on_window_event(window::on_window_event)
        .run(tauri::generate_context!())
        .expect("error while running Sextant");
}
