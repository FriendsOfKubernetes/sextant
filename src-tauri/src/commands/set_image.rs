//! "Set image…" (#215): the images of some containers of a Deployment, StatefulSet, DaemonSet, CronJob or bare Pod,
//! as one strategic-merge patch, and its server-side dry run for the change preview. Each call is limited to
//! [`CHANGE_TIMEOUT`] and never repeated. Window only: agents use `patch_resource`, extensions get nothing new.

use sextant_core::error::with_timeout;
use sextant_core::resources::DryRunResult;
use sextant_core::resources::set_image::{self, SetImageChange};
use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::State;

use super::actions::CHANGE_TIMEOUT;
use crate::state::AppState;

/// Sets the images of the named containers.
#[tauri::command]
pub async fn workload_set_image(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
    changes: Vec<SetImageChange>,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "setting the image",
        set_image::set_images(&state.clusters, &cluster_id, &_ref, &changes),
    )
    .await
}

/// What setting the images would store (`dryRun=All`); changes nothing.
#[tauri::command]
pub async fn workload_set_image_dry_run(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
    changes: Vec<SetImageChange>,
) -> Result<DryRunResult, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "the dry run",
        set_image::dry_run_set_images(&state.clusters, &cluster_id, &_ref, &changes),
    )
    .await
}

#[cfg(test)]
mod tests {
    #[test]
    fn neither_agents_nor_extensions_get_set_image() {
        let tools = crate::mcp::server::all_tools().names();
        assert!(tools.len() > 10, "{tools:?}");
        assert!(!tools.iter().any(|t| t.contains("image")), "{tools:?}");
        let methods = crate::extensions::api::METHODS;
        assert!(
            !methods.iter().any(|m| m.to_lowercase().contains("image")),
            "{methods:?}"
        );
    }
}
