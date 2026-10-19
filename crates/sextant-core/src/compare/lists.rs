//! Bounded lists of a namespace's objects for comparing two namespaces: per kind at most `limit` objects as `get`
//! gives them (no `managedFields`, a Secret without its values) and without `status`.

use futures::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::check_namespace;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::kubeconfig::ClusterId;
use crate::resources::{KindRef, STEP_TIMEOUT, list, resolve_kind};

/// Kinds one call may list.
pub const MAX_COMPARE_KINDS: usize = 40;
/// Objects per kind, at most.
pub const MAX_COMPARE_LIMIT: u32 = 500;
/// Lists in flight at once.
const PARALLEL: usize = 4;

/// The objects of one kind in the namespace: at most `limit`, `truncated` when there are more; `error` when the kind
/// could not be listed (no permission, not served, cluster-scoped, a timeout).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CompareKindList {
    pub kind: KindRef,
    pub objects: Vec<Value>,
    pub truncated: bool,
    pub error: Option<CoreError>,
}

fn validate(namespace: &str, kinds: &[KindRef], limit: u32) -> CoreResult<()> {
    check_namespace(namespace)?;
    if kinds.len() > MAX_COMPARE_KINDS {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "at most {MAX_COMPARE_KINDS} kinds can be compared at once, not {}",
                kinds.len()
            ),
        ));
    }
    if limit == 0 || limit > MAX_COMPARE_LIMIT {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("the limit must be between 1 and {MAX_COMPARE_LIMIT}"),
        ));
    }
    Ok(())
}

async fn list_kind(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    kind: &KindRef,
    limit: u32,
) -> CoreResult<(Vec<Value>, bool)> {
    if !resolve_kind(mgr, cluster, kind).await?.namespaced {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{} is not a namespaced kind", kind.kind),
        ));
    }
    let page = list(mgr, cluster, kind, Some(namespace), None, None, limit).await?;
    let objects = page
        .items
        .into_iter()
        .map(|mut obj| {
            if let Some(map) = obj.as_object_mut() {
                map.remove("status");
            }
            obj
        })
        .collect();
    Ok((objects, page.truncated))
}

/// The objects of `kinds` (in their order) in `namespace`, at most `limit` (1–[`MAX_COMPARE_LIMIT`]) per kind.
pub async fn list_namespace(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    kinds: &[KindRef],
    limit: u32,
) -> CoreResult<Vec<CompareKindList>> {
    validate(namespace, kinds, limit)?;
    mgr.client(cluster)?;
    Ok(stream::iter(kinds.iter().cloned())
        .map(|kind| async move {
            let result = with_timeout(
                STEP_TIMEOUT,
                "the list",
                list_kind(mgr, cluster, namespace, &kind, limit),
            )
            .await;
            match result {
                Ok((objects, truncated)) => CompareKindList {
                    kind,
                    objects,
                    truncated,
                    error: None,
                },
                Err(error) => CompareKindList {
                    kind,
                    objects: Vec::new(),
                    truncated: false,
                    error: Some(error),
                },
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await)
}
