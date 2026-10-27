//! OpenShift's two actions (#267, ADR-0120): "Rollout latest" of a DeploymentConfig and "Start build" of a
//! BuildConfig, each one POST to an `instantiate` subresource with the body `oc` sends, built by the core from the
//! object's name (`sextant_core::resources::openshift`). The window asks first and shows that body. Window only:
//! neither the MCP server nor the extension API offers them.

use sextant_core::error::with_timeout;
use sextant_core::resources::openshift;
use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::State;

use super::actions::CHANGE_TIMEOUT;
use crate::state::AppState;

/// `oc rollout latest dc/<name>`; returns the ReplicationController of the new version.
#[tauri::command]
pub async fn openshift_rollout_latest(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<ObjectRef, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "starting the rollout",
        openshift::rollout_latest(&state.clusters, &cluster_id, &_ref),
    )
    .await
}

/// `oc start-build <name>` without flags; returns the new Build.
#[tauri::command]
pub async fn openshift_start_build(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<ObjectRef, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "starting the build",
        openshift::start_build(&state.clusters, &cluster_id, &_ref),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_the_openshift_actions() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        let forbidden = [
            "openshift",
            "instantiate",
            "rollout_latest",
            "start_build",
            "build",
        ];
        assert!(
            !tools
                .iter()
                .any(|t| forbidden.iter().any(|f| t.contains(f))),
            "{tools:?}"
        );
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| {
                let m = m.to_lowercase();
                ["openshift", "instantiate", "rollout", "build"]
                    .iter()
                    .any(|f| m.contains(f))
            }),
            "{methods:?}"
        );
    }
}
