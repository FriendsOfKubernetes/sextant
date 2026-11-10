//! Where an extension's problem rules run (ADR-0137). The window evaluates the rules on its own watches; this command
//! is the part decided in Rust: for an active extension and a cluster, each kind the user agreed to have judged with
//! the namespaces where the extension's granted rules allow Read. Window only: agents and extensions never call it.
//!
//! `extension_problem_judge` runs one of an extension's problem judges (ADR-0168) on the objects the window collected
//! from its problems store's sources; also window only.

use serde_json::Value;
use sextant_core::extensions::kinds_from::defined_scopes;
use sextant_core::extensions::problem_judges::JudgedFact;
use sextant_core::extensions::problems::{ProblemScope, problem_scopes};
use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode};
use tauri::State;

use super::ExtensionHost;
use crate::state::AppState;

/// Where the problem rules of extension `id` run in cluster `cluster_id`: empty for an extension that is not active
/// (disabled, failed, or asking for more than was granted) or whose rules were not agreed to. The kinds a `kindsFrom`
/// reads from definitions come last, `definedBy` that definition kind: decided here by listing the definitions with
/// the user's connection where the extension may read them (`kinds_from::defined_scopes`), never taken from the
/// window. The definition kind's scope says when the cluster holds more definitions than a `kindsFrom` reads
/// (`moreDefinitions`), so the window marks the category as a part.
#[tauri::command]
pub async fn extension_problem_scopes(
    host: State<'_, ExtensionHost>,
    state: State<'_, AppState>,
    id: String,
    cluster_id: ClusterId,
) -> CoreResult<Vec<ProblemScope>> {
    let blocking = host.inner().clone();
    let clusters = state.clusters.registry();
    let wanted = cluster_id.clone();
    let found = tauri::async_runtime::spawn_blocking(move || {
        let Some(entry) = blocking.active(&id) else {
            return Ok(None);
        };
        let Some(kinds) = entry.granted_problems.clone() else {
            return Ok(None);
        };
        let manifest = blocking.info(&id).and_then(|i| i.manifest);
        let context = clusters
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clusters()?
            .into_iter()
            .find(|c| c.id == wanted)
            .map(|c| c.context)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("no cluster {wanted}")))?;
        let scopes = problem_scopes(&entry.granted, &context, &kinds);
        Ok::<_, CoreError>(Some((entry, manifest, context, scopes)))
    })
    .await
    .map_err(|e| CoreError::other(e.to_string()))??;
    let Some((entry, manifest, context, mut scopes)) = found else {
        return Ok(Vec::new());
    };
    if let (Some(manifest), Some(agreed)) = (manifest, entry.granted_kinds_from.as_deref()) {
        defined_scopes(
            &state.clusters,
            &cluster_id,
            &context,
            &entry.granted,
            &manifest,
            agreed,
            &mut scopes,
        )
        .await;
    }
    Ok(scopes)
}

/// The context name of the cluster `cluster_id`.
async fn context_of(state: &AppState, cluster_id: &ClusterId) -> CoreResult<String> {
    let clusters = state.clusters.registry();
    let cluster_id = cluster_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        clusters
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clusters()?
            .into_iter()
            .find(|c| c.id == cluster_id)
            .map(|c| c.context)
            .ok_or_else(|| CoreError::new(ErrorCode::NotFound, format!("no cluster {cluster_id}")))
    })
    .await
    .map_err(|e| CoreError::other(e.to_string()))?
}

/// The facts the judge `judge` of extension `id` gives about `objects` of cluster `cluster_id` (ADR-0168), with
/// `partial` saying where its `partial` reads were not read: checked and re-projected in Rust, decided by the extension's backend with no way out. Window only.
#[tauri::command]
pub async fn extension_problem_judge(
    host: State<'_, ExtensionHost>,
    state: State<'_, AppState>,
    id: String,
    judge: String,
    cluster_id: ClusterId,
    objects: Vec<Value>,
    partial: Option<Vec<Value>>,
) -> CoreResult<Vec<JudgedFact>> {
    let context = context_of(&state, &cluster_id).await?;
    state
        .ext_api
        .problem_judge(
            host.inner(),
            &id,
            &judge,
            &context,
            objects,
            partial.unwrap_or_default(),
        )
        .await
}
