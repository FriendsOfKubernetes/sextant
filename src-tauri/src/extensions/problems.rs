//! Where an extension's problem rules run (ADR-0137). The window evaluates the rules on its own watches; this command
//! is the part decided in Rust: for an active extension and a cluster, each kind the user agreed to have judged with
//! the namespaces where the extension's granted rules allow Read. Window only: agents and extensions never call it.

use sextant_core::extensions::problems::{ProblemScope, problem_scopes};
use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode};
use tauri::State;

use super::ExtensionHost;
use crate::state::AppState;

/// Where the problem rules of extension `id` run in cluster `cluster_id`: empty for an extension that is not active
/// (disabled, failed, or asking for more than was granted) or whose rules were not agreed to.
#[tauri::command]
pub async fn extension_problem_scopes(
    host: State<'_, ExtensionHost>,
    state: State<'_, AppState>,
    id: String,
    cluster_id: ClusterId,
) -> CoreResult<Vec<ProblemScope>> {
    let host = host.inner().clone();
    let clusters = state.clusters.registry();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(entry) = host.active(&id) else {
            return Ok(Vec::new());
        };
        let Some(kinds) = entry.granted_problems.as_deref() else {
            return Ok(Vec::new());
        };
        let context = clusters
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clusters()?
            .into_iter()
            .find(|c| c.id == cluster_id)
            .map(|c| c.context)
            .ok_or_else(|| {
                CoreError::new(ErrorCode::NotFound, format!("no cluster {cluster_id}"))
            })?;
        Ok(problem_scopes(&entry.granted, &context, kinds))
    })
    .await
    .map_err(|e| CoreError::other(e.to_string()))?
}
