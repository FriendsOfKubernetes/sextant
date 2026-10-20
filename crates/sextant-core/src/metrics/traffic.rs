//! The live traffic graph (#211): who calls whom inside and around a few namespaces, how often, how many calls fail
//! and how slow they are — from the edge metrics of the request-metric sources the cluster's Prometheus has (Istio,
//! Linkerd, Grafana Beyla's service graph, Cilium Hubble), found by [`request_sources`] like the workload request
//! metrics (#212, ADR-0095). Every query is fixed and built in `metrics/prometheus/traffic.rs`; the caller names only
//! namespaces (checked against the Kubernetes naming rules, escaped again in the query) and one of two windows.
//! Bounded: at most [`MAX_TRAFFIC_NAMESPACES`] namespaces, the [`MAX_TRAFFIC_EDGES`] busiest edges (`topk` in the
//! query), [`MAX_TRAFFIC_BODY`] bytes and [`MAX_TRAFFIC_SERIES`] series of an answer. Read-only. Decision: ADR-0096.

use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::PrometheusMode;
use super::history::is_dns_label;
use super::prometheus::{self, Prometheus};
use super::requests::{DetectedSource, RequestSourceKind, RequestVia, request_sources};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

#[cfg(test)]
mod tests;

/// Namespaces one graph covers (an edge counts when either end is in one of them).
pub const MAX_TRAFFIC_NAMESPACES: usize = 5;
/// The busiest edges kept, per source in the query (`topk`) and over all sources in the answer.
pub const MAX_TRAFFIC_EDGES: usize = 200;
/// The largest Prometheus answer read for one source.
pub const MAX_TRAFFIC_BODY: usize = 8 * 1024 * 1024;
/// At most this many series of one answer are looked at (the query itself returns fewer: see the ADR).
pub const MAX_TRAFFIC_SERIES: usize = 4000;

/// The window the rates, error shares and latencies are averaged over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrafficWindow {
    /// The last 5 minutes.
    Minutes5,
    /// The last hour.
    Hour1,
}

impl TrafficWindow {
    /// The `rate()` range.
    pub fn promql(self) -> &'static str {
        match self {
            TrafficWindow::Minutes5 => "5m",
            TrafficWindow::Hour1 => "1h",
        }
    }
}

/// What one end of an edge is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrafficPeerKind {
    /// A workload by the name its source gives (a Deployment, StatefulSet or DaemonSet name, usually).
    Workload,
    /// A Service (or, for Istio, a host) the source names when the callee has no proxy of its own.
    Service,
    /// The source cannot tell: outside the mesh or the cluster, or without the labels that name it.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrafficPeer {
    pub kind: TrafficPeerKind,
    /// `None` when the source does not tell.
    pub namespace: Option<String>,
    /// `None` for an unknown peer.
    pub name: Option<String>,
}

/// The protocol of an edge, where the source tells.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrafficProtocol {
    Http,
    Grpc,
    /// New TCP connections per second, of traffic the source sees only as connections.
    Tcp,
    /// The source does not say (Beyla's service graph).
    Unknown,
}

/// A detail of an edge read by a query of its own, which may fail without hiding the edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TrafficDetail {
    /// `error_ratio` (and, where the classes tell the errors, both).
    Errors,
    /// `status_classes`.
    Classes,
    /// `p50_ms` and `p95_ms`.
    Latency,
}

/// Requests per second of one HTTP status class (`"2xx"`…`"5xx"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StatusClassRate {
    pub class: String,
    pub rate: f64,
}

/// Calls from one peer to another seen by one source over the window.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrafficEdge {
    pub source: RequestSourceKind,
    pub via: RequestVia,
    pub from: TrafficPeer,
    pub to: TrafficPeer,
    pub protocol: TrafficProtocol,
    /// Requests (TCP: new connections) per second.
    pub rate: f64,
    /// Share (0–1) of failed requests by the source's own rule (ADR-0095); `None` for TCP.
    pub error_ratio: Option<f64>,
    /// `None` without the source's histogram (or without requests).
    pub p50_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    /// By class; empty when the source has no HTTP status (TCP, Beyla's service graph). A gRPC call counts under
    /// its HTTP status (usually 2xx; its own status decides `error_ratio`).
    pub status_classes: Vec<StatusClassRate>,
    /// Details whose query failed (a timeout, a limit of Prometheus, an answer too big): their fields are unknown,
    /// not absent.
    pub missing: Vec<TrafficDetail>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TrafficGraph {
    /// Unix seconds the queries were evaluated at.
    pub evaluated_at: i64,
    pub window: TrafficWindow,
    /// The namespaces asked about.
    pub namespaces: Vec<String>,
    /// The cluster settings name a Prometheus (or one was found).
    pub prometheus: bool,
    /// The sources with edge metrics, whether or not they have edges here.
    pub sources: Vec<DetectedSource>,
    /// Sources of request metrics without edge metrics (ingress-nginx, Beyla without its service graph): named in
    /// the "no source" state.
    pub request_only: Vec<RequestSourceKind>,
    /// Sources whose queries failed (their edges are unknown, not absent).
    pub failed: Vec<RequestSourceKind>,
    /// Those of `failed` whose query a proxy in front of Prometheus refused as too long (HTTP 414 or 431).
    pub query_too_long: Vec<RequestSourceKind>,
    /// The busiest first, at most [`MAX_TRAFFIC_EDGES`].
    pub edges: Vec<TrafficEdge>,
    /// How many edges there are in all (more than `edges.len()` when the cap cut some).
    pub total_edges: usize,
}

fn invalid(message: String) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// One to [`MAX_TRAFFIC_NAMESPACES`] distinct namespace names; anything else never reaches a query.
pub fn validate_namespaces(namespaces: &[String]) -> CoreResult<()> {
    if namespaces.is_empty() {
        return Err(invalid("choose at least one namespace".to_owned()));
    }
    if namespaces.len() > MAX_TRAFFIC_NAMESPACES {
        return Err(invalid(format!(
            "at most {MAX_TRAFFIC_NAMESPACES} namespaces at once"
        )));
    }
    if let Some(bad) = namespaces.iter().find(|ns| !is_dns_label(ns)) {
        return Err(invalid(format!("{bad:?} is not a namespace name")));
    }
    if namespaces.iter().collect::<BTreeSet<_>>().len() != namespaces.len() {
        return Err(invalid("a namespace is named twice".to_owned()));
    }
    Ok(())
}

/// Every instant query the traffic graph may send for `kind` about `namespaces` (validated) — per part of the source,
/// the busiest edges, their count, then each of errors, status classes and latency for every edge and for the busiest
/// only — or none when the source has no edges (ingress-nginx). For review, tests and the kind-cluster check.
pub fn traffic_queries(
    kind: RequestSourceKind,
    namespaces: &[String],
    window: TrafficWindow,
    latency: bool,
) -> Vec<String> {
    prometheus::edge_queries(kind, namespaces, window, latency)
}

/// The traffic graph of `namespaces` over `window` from the edge sources [`request_sources`] finds for `mode`. Fails
/// when the names are invalid, the cluster is not connected or its Prometheus fails the source lookup; a source whose
/// query fails is listed in `failed`.
pub async fn traffic_graph(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
    namespaces: Vec<String>,
    window: TrafficWindow,
) -> CoreResult<TrafficGraph> {
    validate_namespaces(&namespaces)?;
    let found = request_sources(mgr, cluster, mode).await?;
    let client = mgr.client(cluster)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let answers = futures::future::join_all(found.edges.iter().map(|source| {
        let (client, namespaces) = (&client, &namespaces);
        let via_target = found.target(source.via).cloned();
        async move {
            let answer = match via_target {
                None => Ok(None),
                Some(target) => match Prometheus::new(client, &target) {
                    Ok(p) => prometheus::traffic_edges(&p, *source, namespaces, window, now)
                        .await
                        .map(Some),
                    Err(err) => Err(err),
                },
            };
            (source.kind, answer)
        }
    }))
    .await;
    let edge_kinds: BTreeSet<RequestSourceKind> = found.edges.iter().map(|s| s.kind).collect();
    let mut graph = TrafficGraph {
        evaluated_at: now,
        window,
        namespaces,
        prometheus: found.prometheus.is_some(),
        sources: found.edges.clone(),
        request_only: found
            .sources
            .iter()
            .map(|s| s.kind)
            .filter(|k| !edge_kinds.contains(k))
            .collect(),
        failed: Vec::new(),
        query_too_long: Vec::new(),
        edges: Vec::new(),
        total_edges: 0,
    };
    for (kind, answer) in answers {
        match answer {
            Ok(Some(part)) => {
                graph.total_edges += part.total;
                graph.edges.extend(part.edges);
            }
            Ok(None) => {}
            Err(err) => {
                if prometheus::is_query_too_long(&err) {
                    graph.query_too_long.push(kind);
                }
                graph.failed.push(kind);
            }
        }
    }
    graph.edges.sort_by(|a, b| b.rate.total_cmp(&a.rate));
    graph.edges.truncate(MAX_TRAFFIC_EDGES);
    graph.total_edges = graph.total_edges.max(graph.edges.len());
    Ok(graph)
}

/// The edges one source gave, and how many it has in all.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct SourceEdges {
    pub edges: Vec<TrafficEdge>,
    pub total: usize,
}
