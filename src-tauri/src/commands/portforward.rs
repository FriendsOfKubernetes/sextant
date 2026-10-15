//! Port forwards. The full list is pushed as the `portforwards` event after every change.

use sextant_core::portforward::{ForwardInfo, ForwardTarget};
use sextant_core::{ClusterId, CoreError};
use tauri::State;

use crate::state::AppState;

/// Starts forwarding a local port (`localPort`, or a free one when absent) to a pod or service port. A taken
/// local port gives `portInUse`. The forward belongs to the cluster: disconnecting it closes the forward.
#[tauri::command]
pub async fn portforward_start(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    target: ForwardTarget,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<ForwardInfo, CoreError> {
    state
        .forwarder
        .start(
            &state.clusters,
            &cluster_id,
            target,
            remote_port,
            local_port,
            sextant_core::portforward::PodFilter::Any,
        )
        .await
}

#[tauri::command]
pub async fn portforward_list(state: State<'_, AppState>) -> Result<Vec<ForwardInfo>, CoreError> {
    Ok(state.forwarder.list())
}

/// Closes a forward and frees its local port.
#[tauri::command]
pub async fn portforward_stop(state: State<'_, AppState>, id: String) -> Result<(), CoreError> {
    state.forwarder.stop(&id).await
}

#[cfg(test)]
mod tests {
    use sextant_core::ErrorCode;
    use tauri::Manager;

    use super::*;

    fn app() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        (app, dir)
    }

    #[tokio::test]
    async fn there_are_no_forwards_at_first_and_an_unknown_one_cannot_be_stopped() {
        let (app, _dir) = app();

        let list = portforward_list(app.state::<AppState>()).await.unwrap();
        let err = portforward_stop(app.state::<AppState>(), "pf-404".into())
            .await
            .unwrap_err();

        assert!(list.is_empty());
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn starting_on_a_cluster_that_is_not_connected_is_not_found() {
        let (app, _dir) = app();

        let err = portforward_start(
            app.state::<AppState>(),
            ClusterId::from("nope"),
            ForwardTarget::Pod {
                namespace: "default".into(),
                name: "web".into(),
            },
            80,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
