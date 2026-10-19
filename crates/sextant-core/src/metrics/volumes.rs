//! Fill level of PersistentVolumeClaims (#152): bytes and inodes used of each mounted claim, from the kubelet's stats
//! summary (`/api/v1/nodes/<node>/proxy/stats/summary`, through the API server) or, when `nodes/proxy` is forbidden or
//! no node answers, from Prometheus (`kubelet_volume_stats_*`).
//!
//! Bounded on every side: at most [`MAX_NODES`] nodes are asked, [`PARALLEL_NODES`] at a time, each answer within
//! [`NODE_TIMEOUT`] and [`MAX_SUMMARY_BYTES`], the whole round within [`ROUND_TIMEOUT`]; of a summary only the volume
//! fields of claims are kept (the claim's namespace and name, capacity, used, available, inodes), and the answer is
//! capped at [`MAX_VOLUMES`] claims. The PromQL is fixed: it names no object. Read-only.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures::StreamExt;
use http_body_util::{BodyExt, Limited};
use k8s_openapi::api::core::v1::Node;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::PrometheusMode;
use super::prometheus::{self, Prometheus};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, code_for_http_status, kube_error};
use crate::kubeconfig::ClusterId;

/// At most this many nodes are asked for their stats summary; beyond it the answer is `truncated`.
pub const MAX_NODES: usize = 500;
/// Nodes asked at the same time.
pub const PARALLEL_NODES: usize = 8;
/// How long one node's summary may take.
pub const NODE_TIMEOUT: Duration = Duration::from_secs(10);
/// How long one round over every node may take; nodes not asked by then count as failed.
pub const ROUND_TIMEOUT: Duration = Duration::from_secs(40);
/// A larger summary is not read (it counts as failed).
pub const MAX_SUMMARY_BYTES: usize = 16 * 1024 * 1024;
/// At most this many claims come back; beyond it the answer is `truncated`.
pub const MAX_VOLUMES: usize = 10_000;

/// Where the fill levels came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum VolumeUsageSource {
    /// The kubelets' stats summaries.
    Kubelet,
    /// Prometheus' `kubelet_volume_stats_*`.
    Prometheus,
}

/// The fill level of one claim, as the kubelet of a node that mounts it measured it. A value the source does not
/// give is `None`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VolumeUsage {
    pub namespace: String,
    /// The PersistentVolumeClaim's name.
    pub claim: String,
    pub capacity_bytes: Option<f64>,
    pub used_bytes: Option<f64>,
    pub available_bytes: Option<f64>,
    pub inodes: Option<f64>,
    pub inodes_used: Option<f64>,
    pub inodes_free: Option<f64>,
}

/// Every mounted claim's fill level in a cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VolumeUsageReport {
    pub source: VolumeUsageSource,
    /// By namespace and name. A claim no running pod mounts is not here (nothing measures it).
    pub volumes: Vec<VolumeUsage>,
    /// Nodes asked for their summary (kubelet only).
    pub nodes: u32,
    /// Nodes whose summary did not come: no answer in time, an error, too large.
    pub nodes_failed: u32,
    /// `nodes/proxy` is forbidden for the user: the levels come from Prometheus.
    pub kubelet_forbidden: bool,
    /// More nodes than [`MAX_NODES`] or claims than [`MAX_VOLUMES`]: some are left out.
    pub truncated: bool,
}

/// The fill level of every mounted claim: from the kubelets, else (forbidden, no node answered) from the Prometheus of
/// `prometheus`. Neither → the kubelet's error, with Prometheus' reason.
pub async fn volume_usage(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    prometheus: &PrometheusMode,
) -> CoreResult<VolumeUsageReport> {
    let client = mgr.client(cluster)?;
    let kubelet_error = match kubelet_usage(&client).await {
        Ok(report) => return Ok(report),
        Err(err) => err,
    };
    let forbidden = kubelet_error.code == ErrorCode::Forbidden;
    let fallback = async {
        let target = super::prometheus_target(mgr, cluster, prometheus)
            .await?
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    match prometheus {
                        PrometheusMode::Off => "Prometheus is turned off in the cluster settings",
                        _ => "Prometheus was not found",
                    },
                )
            })?;
        let prometheus = Prometheus::new(&client, &target)?;
        prometheus::volume_stats(&prometheus).await
    };
    match fallback.await {
        Ok((volumes, truncated)) => Ok(VolumeUsageReport {
            source: VolumeUsageSource::Prometheus,
            volumes,
            nodes: 0,
            nodes_failed: 0,
            kubelet_forbidden: forbidden,
            truncated,
        }),
        Err(prometheus_error) => Err(CoreError::new(
            kubelet_error.code,
            format!("{}; {}", kubelet_error.message, prometheus_error.message),
        )),
    }
}

/// The kubelets' summaries of at most [`MAX_NODES`] nodes. `forbidden` when the user may read none of them (or may
/// not list the nodes); an error too when there are nodes and none answered. Nodes that failed are counted.
pub(crate) async fn kubelet_usage(client: &kube::Client) -> CoreResult<VolumeUsageReport> {
    let nodes: Api<Node> = Api::all(client.clone());
    let list = tokio::time::timeout(
        NODE_TIMEOUT,
        nodes.list_metadata(&ListParams::default().limit(MAX_NODES as u32)),
    )
    .await
    .map_err(|_| CoreError::new(ErrorCode::Timeout, "listing the nodes took too long"))?
    .map_err(|e| kube_error(e, None))?;
    let more_nodes = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|c| !c.is_empty());
    let names: Vec<String> = list
        .items
        .into_iter()
        .filter_map(|n| n.metadata.name)
        .take(MAX_NODES)
        .collect();
    let deadline = Instant::now() + ROUND_TIMEOUT;
    // Owned names and a client per request: the future stays `Send` (a borrowed name trips the higher-ranked
    // lifetime check of the command's future).
    let answers: Vec<CoreResult<Vec<VolumeUsage>>> = futures::stream::iter(names.clone())
        .map(|name| {
            let client = client.clone();
            async move { node_volumes(&client, &name, deadline).await }
        })
        .buffer_unordered(PARALLEL_NODES)
        .collect()
        .await;
    // A node that refused or failed is counted; the others' readings stay. Only when every node refused is the
    // round "forbidden" (and Prometheus asked instead).
    let mut failed = 0u32;
    let mut refused = 0usize;
    let mut first_error: Option<CoreError> = None;
    let mut found: Vec<VolumeUsage> = Vec::new();
    for answer in answers {
        match answer {
            Ok(volumes) => found.extend(volumes),
            Err(err) => {
                failed += 1;
                refused += usize::from(err.code == ErrorCode::Forbidden);
                first_error.get_or_insert(err);
            }
        }
    }
    if !names.is_empty() && refused == names.len() {
        return Err(CoreError::new(
            ErrorCode::Forbidden,
            "reading the kubelet's stats (nodes/proxy) is forbidden",
        ));
    }
    if !names.is_empty() && failed as usize == names.len() {
        let reason = first_error.map(|e| e.message).unwrap_or_default();
        return Err(CoreError::new(
            ErrorCode::Unreachable,
            format!("no node answered with its stats summary ({reason})"),
        ));
    }
    let (volumes, too_many) = merge(found);
    Ok(VolumeUsageReport {
        source: VolumeUsageSource::Kubelet,
        volumes,
        nodes: names.len() as u32,
        nodes_failed: failed,
        kubelet_forbidden: false,
        truncated: more_nodes || too_many,
    })
}

/// Whether `name` can be put into a path as is (a node name is a DNS subdomain).
fn safe_node_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// The claims of one node's summary, read within [`NODE_TIMEOUT`] (and the round's deadline) and
/// [`MAX_SUMMARY_BYTES`].
async fn node_volumes(
    client: &kube::Client,
    name: &str,
    deadline: Instant,
) -> CoreResult<Vec<VolumeUsage>> {
    if !safe_node_name(name) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a node name that is not valid",
        ));
    }
    let left = deadline.saturating_duration_since(Instant::now());
    if left.is_zero() {
        return Err(CoreError::new(
            ErrorCode::Timeout,
            "the round took too long",
        ));
    }
    let request = http::Request::get(format!("/api/v1/nodes/{name}/proxy/stats/summary"))
        .header(http::header::ACCEPT, "application/json")
        .body(kube::client::Body::from(Vec::new()))
        .map_err(|e| CoreError::new(ErrorCode::Invalid, e.to_string()))?;
    let read = async {
        let response = client
            .send(request)
            .await
            .map_err(|e| kube_error(e, None))?;
        let status = response.status();
        if !status.is_success() {
            return Err(CoreError::new(
                code_for_http_status(status.as_u16()),
                format!(
                    "node {name}: the stats summary answered {}",
                    status.as_u16()
                ),
            ));
        }
        let body = Limited::new(response.into_body(), MAX_SUMMARY_BYTES)
            .collect()
            .await
            .map_err(|e| {
                CoreError::new(
                    ErrorCode::Other,
                    format!("node {name}: reading the stats summary: {e}"),
                )
            })?
            .to_bytes();
        parse_summary(&body)
            .map_err(|e| CoreError::new(ErrorCode::Invalid, format!("node {name}: {e}")))
    };
    tokio::time::timeout(left.min(NODE_TIMEOUT), read)
        .await
        .map_err(|_| {
            CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "node {name}: no stats summary within {} seconds",
                    NODE_TIMEOUT.as_secs()
                ),
            )
        })?
}

// Only the fields kept are read; serde skips everything else of a summary (containers, CPU, memory, …) unread.
#[derive(Deserialize)]
struct Summary {
    #[serde(default)]
    pods: Vec<PodStats>,
}

#[derive(Deserialize)]
struct PodStats {
    #[serde(default)]
    volume: Vec<VolumeStats>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VolumeStats {
    pvc_ref: Option<PvcRef>,
    capacity_bytes: Option<f64>,
    used_bytes: Option<f64>,
    available_bytes: Option<f64>,
    inodes: Option<f64>,
    inodes_used: Option<f64>,
    inodes_free: Option<f64>,
}

#[derive(Deserialize)]
struct PvcRef {
    name: Option<String>,
    namespace: Option<String>,
}

/// The claims' volumes of a kubelet stats summary; volumes that are no claim (emptyDir, configMap, …) are left out.
pub(crate) fn parse_summary(body: &[u8]) -> Result<Vec<VolumeUsage>, String> {
    let summary: Summary = serde_json::from_slice(body)
        .map_err(|_| "the answer is not a kubelet stats summary".to_owned())?;
    Ok(summary
        .pods
        .into_iter()
        .flat_map(|pod| pod.volume)
        .filter_map(|v| {
            let pvc = v.pvc_ref?;
            Some(VolumeUsage {
                namespace: pvc.namespace.filter(|n| !n.is_empty())?,
                claim: pvc.name.filter(|n| !n.is_empty())?,
                capacity_bytes: v.capacity_bytes,
                used_bytes: v.used_bytes,
                available_bytes: v.available_bytes,
                inodes: v.inodes,
                inodes_used: v.inodes_used,
                inodes_free: v.inodes_free,
            })
        })
        .collect())
}

/// One entry per claim (a claim mounted on several nodes or by several pods is one volume: the fullest reading
/// stays), sorted, at most [`MAX_VOLUMES`]; whether some were left out.
pub(crate) fn merge(found: Vec<VolumeUsage>) -> (Vec<VolumeUsage>, bool) {
    let mut by_claim: BTreeMap<(String, String), VolumeUsage> = BTreeMap::new();
    for usage in found {
        let key = (usage.namespace.clone(), usage.claim.clone());
        match by_claim.get(&key) {
            Some(kept) if kept.used_bytes.unwrap_or(-1.0) >= usage.used_bytes.unwrap_or(-1.0) => {}
            _ => {
                by_claim.insert(key, usage);
            }
        }
    }
    let truncated = by_claim.len() > MAX_VOLUMES;
    (
        by_claim.into_values().take(MAX_VOLUMES).collect(),
        truncated,
    )
}

#[cfg(test)]
mod tests;
