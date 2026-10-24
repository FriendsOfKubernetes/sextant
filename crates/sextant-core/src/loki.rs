//! Logs of gone pods (and of earlier container runs) from Grafana Loki (#265), read-only.
//!
//! Loki is found among the cluster's Services by the names its Helm charts give (see [`detect`]) and reached through
//! the API server's service proxy (`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/…`), as Prometheus and
//! OpenCost are: no local port, nothing held between calls, the user's own RBAC (`services/proxy` `get`) decides. The
//! cluster settings may name the Service instead (`ClusterSettings.loki`) or turn Loki off, and may give the tenant
//! sent as `X-Scope-OrgID`.
//!
//! Every request is built here from validated names (namespace, pod, container, workload kind and name): the LogQL
//! stream selector, the label names (one of a fixed set of schemes, [`LokiLabelScheme`], picked from what
//! `/loki/api/v1/labels` lists) and every query parameter. No LogQL, label, path or URL comes from the window. Each
//! request has a timeout and a cap on the answer's size; a log read is at most [`MAX_RANGE_MS`] long and
//! [`MAX_LINES`] lines, fetched in pages of [`PAGE_LINES`]. Decision: ADR-0118.

mod client;
mod logql;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::Stream;
use futures::future::join_all;
use k8s_openapi::api::core::v1::Service;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

pub use client::{MAX_BODY, REQUEST_TIMEOUT};
pub use logql::{LokiLabelScheme, WORKLOAD_KINDS, pod_name_pattern};

/// Namespaces whose Services are all looked at, in order of preference.
pub const CANDIDATE_NAMESPACES: [&str; 6] = [
    "loki",
    "logging",
    "monitoring",
    "observability",
    "grafana",
    "loki-stack",
];
/// Services anywhere with this label are candidates too (the grafana/loki and loki-distributed charts set it).
const LABEL_SELECTOR: &str = "app.kubernetes.io/name in (loki,loki-distributed)";
/// At most this many Services are listed per namespace and cluster-wide by label.
const LIST_LIMIT: u32 = 100;
/// How long a detection result (also "not found") is reused for a connection and the same settings.
const DETECT_TTL: Duration = Duration::from_secs(60);
/// The longest time range of one log read or name listing.
pub const MAX_RANGE_MS: i64 = 24 * 60 * 60 * 1000;
/// The most lines one log read returns.
pub const MAX_LINES: u32 = 5000;
/// Lines asked per request; a read is several requests, each continuing where the previous ended.
pub const PAGE_LINES: u32 = 1000;
/// The most names a listing returns.
pub const MAX_NAMES: usize = 200;
/// The longest line sent, in bytes, as for live logs (`logs::MAX_LINE_BYTES`); a longer one is sent in pieces.
pub use crate::logs::MAX_LINE_BYTES;
/// The labels are looked up over this period before now.
const LABELS_LOOKBACK_MS: i64 = MAX_RANGE_MS;
/// The end of a range may be at most this far in the future (clock skew between the window and Loki).
const FUTURE_SLACK_MS: i64 = 5 * 60 * 1000;

/// How Loki is found. Serialized with a `mode` tag.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LokiMode {
    /// Look for the known Services ([`detect`]).
    #[default]
    Auto,
    /// This Service, reached through the API server's service proxy; `path_prefix` goes in front of `/loki/api/v1`.
    Manual {
        namespace: String,
        service: String,
        port: u16,
        path_prefix: String,
    },
    /// No Loki for this cluster.
    Off,
}

/// Per-cluster Loki settings (`ClusterSettings.loki`). Owned by the frontend; read leniently (an unreadable value
/// is the default).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct LokiSettings {
    pub mode: LokiMode,
    /// The tenant sent as `X-Scope-OrgID` (a multi-tenant Loki needs one); `None` sends no header.
    #[ts(optional = nullable)]
    pub tenant: Option<String>,
}

impl LokiSettings {
    /// The stored JSON read leniently: anything that does not read is the default.
    pub fn lenient(value: Option<serde_json::Value>) -> Self {
        value
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }
}

/// The Loki Service in use.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiSource {
    pub namespace: String,
    pub service: String,
    pub port: u16,
    /// In front of `/loki/api/v1`, without a trailing slash; usually empty.
    pub path_prefix: String,
}

/// What [`status`] found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiStatus {
    /// Loki is turned off in the cluster settings (nothing was asked).
    pub off: bool,
    /// The Service is the one the settings name (not found by detection).
    pub manual: bool,
    /// `None`: no Loki was found (or the named Service did not answer as Loki).
    #[ts(optional = nullable)]
    pub source: Option<LokiSource>,
    /// The labels Loki's streams carry; `None` when none of the known schemes is there (nothing can be read then).
    #[ts(optional = nullable)]
    pub scheme: Option<LokiLabelScheme>,
    /// Whether the scheme's container label is there (else a pod's containers are read together).
    pub container_label: bool,
    /// Why the Service the settings name did not answer as Loki (a manual address only: no permission, no endpoints,
    /// not Loki), with every URI in it cleaned; `None` when it answered or detection is automatic.
    #[ts(optional = nullable)]
    pub probe_error: Option<CoreError>,
}

/// A time range, in Unix milliseconds; `end` is excluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiRange {
    #[ts(type = "number")]
    pub start_ms: i64,
    #[ts(type = "number")]
    pub end_ms: i64,
}

/// Which names to list. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum LokiNamesQuery {
    /// Pods a workload's controller made (by the names it gives them) that have logs in the range.
    WorkloadPods {
        namespace: String,
        /// One of [`WORKLOAD_KINDS`].
        kind: String,
        name: String,
    },
    /// The containers of a pod that have logs in the range.
    PodContainers { namespace: String, pod: String },
}

/// The answer of [`names`]: sorted, at most [`MAX_NAMES`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiNames {
    pub names: Vec<String>,
    /// More names were there than [`MAX_NAMES`].
    pub truncated: bool,
}

/// The order lines are read in: `backward` gives the newest `limit` lines of the range, `forward` the oldest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LokiDirection {
    #[default]
    Backward,
    Forward,
}

/// One log read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiLogsQuery {
    pub namespace: String,
    pub pod: String,
    /// `None`: every container of the pod (also when Loki has no container label).
    #[ts(optional = nullable)]
    pub container: Option<String>,
    pub range: LokiRange,
    pub direction: LokiDirection,
    /// 1 to [`MAX_LINES`].
    pub limit: u32,
}

/// One line from Loki.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LokiEntry {
    /// Nanoseconds since the Unix epoch, as decimal text (too large for a JavaScript number).
    pub ts: String,
    pub line: String,
    /// The line was longer than [`MAX_LINE_BYTES`]: its rest follows as the next entry (with the same `ts`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    #[ts(as = "Option<bool>", optional)]
    pub cut: bool,
}

/// What a log read sends, page by page. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum LokiUpdate {
    /// One page, in the read's direction (newest first for `backward`).
    Entries {
        entries: Vec<LokiEntry>,
    },
    /// The read is over: `lines` were sent; `truncated` when the limit stopped it while Loki had more.
    Ended {
        lines: u32,
        truncated: bool,
    },
    Error(CoreError),
}

// ---------------------------------------------------------------------------------------------------------------
// Validation: everything that goes into a request is checked before anything is sent.

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A DNS-1123 label (namespace, Service, container names).
fn is_dns_label(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// A DNS-1123 subdomain (pod and workload names).
fn is_dns_subdomain(name: &str) -> bool {
    !name.is_empty() && name.len() <= 253 && name.split('.').all(is_dns_label)
}

/// A path prefix: empty, or `/segment` parts of unreserved characters (no `.` or `..` segment), ≤ 200 characters.
fn is_path_prefix(prefix: &str) -> bool {
    prefix.is_empty()
        || (prefix.len() <= 200
            && prefix.starts_with('/')
            && prefix[1..].split('/').all(|segment| {
                !segment.is_empty()
                    && segment != "."
                    && segment != ".."
                    && segment
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
            }))
}

/// A tenant ID as Loki accepts it (letters, digits and `!-_.*'()`, at most 150 characters, not `.` or `..`), or
/// several joined by `|` for a multi-tenant query.
pub fn validate_tenant(tenant: &str) -> CoreResult<()> {
    let ok = !tenant.is_empty()
        && tenant.len() <= 150
        && tenant.split('|').all(|id| {
            !id.is_empty()
                && id != "."
                && id != ".."
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!-_.*'()".contains(&b))
        });
    if ok {
        Ok(())
    } else {
        Err(invalid(format!("{tenant:?} is not a Loki tenant ID")))
    }
}

/// Checks the settings: a manual Service and the tenant.
pub fn validate_settings(settings: &LokiSettings) -> CoreResult<()> {
    if let LokiMode::Manual {
        namespace,
        service,
        port,
        path_prefix,
    } = &settings.mode
    {
        if !is_dns_label(namespace) || !is_dns_label(service) || *port == 0 {
            return Err(invalid(format!(
                "{namespace}/{service}:{port} is not a Service address"
            )));
        }
        if !is_path_prefix(path_prefix.trim_end_matches('/')) {
            return Err(invalid(format!("{path_prefix:?} is not a path prefix")));
        }
    }
    if let Some(tenant) = &settings.tenant {
        validate_tenant(tenant)?;
    }
    Ok(())
}

/// Now, in Unix milliseconds.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// A range of 1 ms to [`MAX_RANGE_MS`] after the epoch that ends no later than a few minutes after `now_ms`.
pub fn validate_range(range: &LokiRange, now_ms: i64) -> CoreResult<()> {
    if range.start_ms <= 0 || range.end_ms <= range.start_ms {
        return Err(invalid("the period must end after it starts"));
    }
    if range.end_ms - range.start_ms > MAX_RANGE_MS {
        return Err(invalid("the period can be at most 24 hours"));
    }
    if range.end_ms > now_ms + FUTURE_SLACK_MS {
        return Err(invalid("the period cannot end in the future"));
    }
    Ok(())
}

fn check_namespace(namespace: &str) -> CoreResult<()> {
    if is_dns_label(namespace) {
        Ok(())
    } else {
        Err(invalid(format!("{namespace:?} is not a namespace name")))
    }
}

fn check_name(what: &str, name: &str) -> CoreResult<()> {
    if is_dns_subdomain(name) {
        Ok(())
    } else {
        Err(invalid(format!("{name:?} is not a {what} name")))
    }
}

/// Checks a names query.
pub fn validate_names_query(query: &LokiNamesQuery) -> CoreResult<()> {
    match query {
        LokiNamesQuery::WorkloadPods {
            namespace,
            kind,
            name,
        } => {
            check_namespace(namespace)?;
            if !WORKLOAD_KINDS.contains(&kind.as_str()) {
                return Err(invalid(format!("no pod names for the kind {kind:?}")));
            }
            check_name("workload", name)
        }
        LokiNamesQuery::PodContainers { namespace, pod } => {
            check_namespace(namespace)?;
            check_name("pod", pod)
        }
    }
}

/// Checks a log read.
pub fn validate_logs_query(query: &LokiLogsQuery, now_ms: i64) -> CoreResult<()> {
    check_namespace(&query.namespace)?;
    check_name("pod", &query.pod)?;
    if let Some(container) = &query.container
        && !is_dns_label(container)
    {
        return Err(invalid(format!("{container:?} is not a container name")));
    }
    if query.limit == 0 || query.limit > MAX_LINES {
        return Err(invalid(format!("a read is 1 to {MAX_LINES} lines")));
    }
    validate_range(&query.range, now_ms)
}

// ---------------------------------------------------------------------------------------------------------------
// Detection

/// Whether `base` is the full name the Loki charts give their objects: `loki`, `<release>-loki`, or the
/// loki-distributed chart's `loki-distributed` / `<release>-loki-distributed`.
fn is_loki_base(base: &str) -> bool {
    ["loki", "loki-distributed"]
        .iter()
        .any(|b| base == *b || base.ends_with(&format!("-{b}")))
}

/// What a Service of this name is to detection: its rank (lower is better) and port, by the names and ports of the
/// charts' templates — grafana/loki (`production/helm/loki`): `<fullname>-gateway` on 80
/// (`gateway/service-gateway.yaml`, `gateway.service.port`), `<fullname>-query-frontend` and `<fullname>-read` on
/// 3100 (`loki.server.http_listen_port`), the single binary `<fullname>` on 3100; grafana/loki-distributed the same
/// gateway and query-frontend names; grafana/loki-stack's Loki `<release>` (`loki`, `loki-stack`) on 3100.
fn known(name: &str) -> Option<(u8, u16)> {
    let split = |suffix: &str| name.strip_suffix(suffix).filter(|base| is_loki_base(base));
    if split("-gateway").is_some() {
        Some((0, 80))
    } else if split("-query-frontend").is_some() {
        Some((1, 3100))
    } else if split("-read").is_some() {
        Some((2, 3100))
    } else if is_loki_base(name) || name == "loki-stack" || name.ends_with("-loki-stack") {
        Some((3, 3100))
    } else {
        None
    }
}

/// A Service's rank and port, when it is a known Loki Service that has that port.
pub(crate) fn classify(service: &Service) -> Option<(u8, u16)> {
    let (rank, port) = known(service.metadata.name.as_deref()?)?;
    let has_port = service
        .spec
        .as_ref()?
        .ports
        .iter()
        .flatten()
        .any(|p| p.port == i32::from(port));
    has_port.then_some((rank, port))
}

/// The candidates among `services`, best first: the namespaces of [`CANDIDATE_NAMESPACES`] in order, then others;
/// within a namespace the gateway, then the query frontend, the read path, the single binary; then by name.
pub(crate) fn candidates(services: &[Service]) -> Vec<LokiSource> {
    let preference = |ns: &str| {
        CANDIDATE_NAMESPACES
            .iter()
            .position(|c| *c == ns)
            .unwrap_or(CANDIDATE_NAMESPACES.len())
    };
    let mut found: Vec<(usize, u8, LokiSource)> = services
        .iter()
        .filter_map(|s| {
            let (rank, port) = classify(s)?;
            let namespace = s.metadata.namespace.clone()?;
            Some((
                preference(&namespace),
                rank,
                LokiSource {
                    namespace,
                    service: s.metadata.name.clone()?,
                    port,
                    path_prefix: String::new(),
                },
            ))
        })
        .collect();
    found.sort_by(|a, b| {
        (a.0, a.1, &a.2.namespace, &a.2.service).cmp(&(b.0, b.1, &b.2.namespace, &b.2.service))
    });
    found.dedup_by(|a, b| a.2 == b.2);
    found.into_iter().map(|(_, _, source)| source).collect()
}

/// At most this many candidates are probed.
const MAX_PROBES: usize = 6;

/// The first candidate Service that answers as Loki (a namespace or a label list that is forbidden or missing adds
/// nothing).
async fn discover(client: &kube::Client, tenant: Option<&String>) -> Option<LokiSource> {
    let namespaced = join_all(CANDIDATE_NAMESPACES.iter().map(|ns| async move {
        let api: Api<Service> = Api::namespaced(client.clone(), ns);
        api.list(&ListParams::default().limit(LIST_LIMIT))
            .await
            .map(|l| l.items)
            .unwrap_or_default()
    }));
    let labelled = async {
        let api: Api<Service> = Api::all(client.clone());
        api.list(
            &ListParams::default()
                .labels(LABEL_SELECTOR)
                .limit(LIST_LIMIT),
        )
        .await
        .map(|l| l.items)
        .unwrap_or_default()
    };
    let (namespaced, labelled) = futures::join!(namespaced, labelled);
    let all: Vec<Service> = namespaced.into_iter().flatten().chain(labelled).collect();
    for source in candidates(&all).into_iter().take(MAX_PROBES) {
        let loki = client::Loki::new(client.clone(), source.clone(), tenant.cloned());
        if loki.probe().await.is_ok() {
            return Some(source);
        }
    }
    None
}

/// The Loki of a cluster as resolved for one connection and one settings value.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Resolved {
    source: LokiSource,
    scheme: Option<LokiLabelScheme>,
    container_label: bool,
}

/// What resolving gave: the source and scheme (`None`: no Loki), and why a manual address did not answer.
#[derive(Debug, Clone, Default)]
struct Resolution {
    found: Option<Resolved>,
    probe_error: Option<CoreError>,
}

/// The failed probe of a manual address as the window may show it: its code, and its message with every URI cleaned
/// (no credentials, query or fragment) and clipped; nothing else of the error.
fn probe_failure(err: &CoreError) -> CoreError {
    CoreError::new(
        err.code,
        crate::alerts::clean_text(&err.message)
            .chars()
            .take(300)
            .collect::<String>(),
    )
}

/// Results per cluster: when, for which connection and settings, and what was found.
type Detected = HashMap<ClusterId, (Instant, u64, LokiSettings, Resolution)>;

static DETECTED: LazyLock<Mutex<Detected>> = LazyLock::new(Default::default);

fn lock_detected() -> std::sync::MutexGuard<'static, Detected> {
    DETECTED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The source the settings name, or the detected one; then the label scheme. A Loki that answers but refuses the
/// labels (no tenant, no permission) is an error, not "not found", and is not remembered.
async fn resolve(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &LokiSettings,
) -> CoreResult<Resolution> {
    let client = mgr.client(cluster)?;
    let connection = mgr.connection(cluster)?;
    if let Some((at, conn, kept, found)) = lock_detected().get(cluster)
        && *conn == connection
        && kept == settings
        && at.elapsed() < DETECT_TTL
    {
        return Ok(found.clone());
    }
    let mut probe_error = None;
    let source = match &settings.mode {
        LokiMode::Off => return Ok(Resolution::default()),
        LokiMode::Manual {
            namespace,
            service,
            port,
            path_prefix,
        } => {
            let source = LokiSource {
                namespace: namespace.clone(),
                service: service.clone(),
                port: *port,
                path_prefix: path_prefix.trim_end_matches('/').to_owned(),
            };
            match client::Loki::new(client.clone(), source.clone(), settings.tenant.clone())
                .probe()
                .await
            {
                Ok(()) => Some(source),
                Err(err) => {
                    probe_error = Some(probe_failure(&err));
                    None
                }
            }
        }
        LokiMode::Auto => discover(&client, settings.tenant.as_ref()).await,
    };
    let found = match source {
        None => None,
        Some(source) => {
            let loki = client::Loki::new(client, source.clone(), settings.tenant.clone());
            let now = now_ms();
            let labels = loki.labels(ns(now - LABELS_LOOKBACK_MS), ns(now)).await?;
            let detected = LokiLabelScheme::detect(&labels);
            Some(Resolved {
                source,
                scheme: detected.map(|(s, _)| s),
                container_label: detected.is_some_and(|(_, c)| c),
            })
        }
    };
    let resolution = Resolution { found, probe_error };
    lock_detected().insert(
        cluster.clone(),
        (
            Instant::now(),
            connection,
            settings.clone(),
            resolution.clone(),
        ),
    );
    Ok(resolution)
}

/// Milliseconds to nanoseconds.
fn ns(ms: i64) -> i64 {
    ms.saturating_mul(1_000_000)
}

/// Whether Loki is there, where, and which labels it has.
pub async fn status(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &LokiSettings,
) -> CoreResult<LokiStatus> {
    validate_settings(settings)?;
    let Resolution { found, probe_error } = resolve(mgr, cluster, settings).await?;
    Ok(LokiStatus {
        off: settings.mode == LokiMode::Off,
        manual: matches!(settings.mode, LokiMode::Manual { .. }),
        scheme: found.as_ref().and_then(|f| f.scheme),
        container_label: found.as_ref().is_some_and(|f| f.container_label),
        source: found.map(|f| f.source),
        probe_error,
    })
}

/// The source and scheme to read with, or the error that says why there is none.
async fn readable(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &LokiSettings,
) -> CoreResult<(client::Loki, LokiLabelScheme, bool)> {
    validate_settings(settings)?;
    let resolution = resolve(mgr, cluster, settings).await?;
    let Some(found) = resolution.found else {
        // The manual address's own error says why (403 vs a wrong port); else "not found".
        if let Some(err) = resolution.probe_error {
            return Err(err);
        }
        return Err(CoreError::new(
            ErrorCode::NotFound,
            match settings.mode {
                LokiMode::Off => "Loki is turned off in the cluster settings",
                _ => "Loki was not found",
            },
        ));
    };
    let Some(scheme) = found.scheme else {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            "Loki's log streams have no namespace and pod labels Sextant knows",
        ));
    };
    let loki = client::Loki::new(mgr.client(cluster)?, found.source, settings.tenant.clone());
    Ok((loki, scheme, found.container_label))
}

/// Pod or container names seen in Loki in the range, sorted, at most [`MAX_NAMES`]. The query is checked before
/// the cluster is looked up.
pub async fn names(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &LokiSettings,
    query: &LokiNamesQuery,
    range: &LokiRange,
) -> CoreResult<LokiNames> {
    validate_names_query(query)?;
    validate_range(range, now_ms())?;
    let (loki, scheme, container_label) = readable(mgr, cluster, settings).await?;
    let (label, selector) = match query {
        LokiNamesQuery::WorkloadPods {
            namespace,
            kind,
            name,
        } => (
            scheme.pod(),
            logql::stream_selector(
                scheme,
                namespace,
                &logql::PodMatch::Pattern(pod_name_pattern(kind, name)),
                None,
            ),
        ),
        LokiNamesQuery::PodContainers { namespace, pod } => {
            if !container_label {
                return Ok(LokiNames {
                    names: Vec::new(),
                    truncated: false,
                });
            }
            (
                scheme.container(),
                logql::stream_selector(scheme, namespace, &logql::PodMatch::Exact(pod), None),
            )
        }
    };
    let mut names = loki
        .label_values(label, &selector, ns(range.start_ms), ns(range.end_ms))
        .await?;
    names.retain(|n| is_dns_subdomain(n));
    names.sort();
    names.dedup();
    let truncated = names.len() > MAX_NAMES;
    names.truncate(MAX_NAMES);
    Ok(LokiNames { names, truncated })
}

// ---------------------------------------------------------------------------------------------------------------
// Reading lines, page by page

/// The most bytes of line text one read sends (the page that passes it is the last).
pub const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;
/// At most this many requests per read (a guard against an answer that never moves on).
const MAX_REQUESTS: u32 = 2 * MAX_LINES / PAGE_LINES + 4;

/// The lines of one container (or every container) of a pod, as a stream of pages; the read is checked and Loki is
/// resolved before the stream is returned, so those errors are the `Err`. The stream ends with
/// [`LokiUpdate::Ended`] or [`LokiUpdate::Error`]; dropping it stops the read.
pub async fn read_logs(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    settings: &LokiSettings,
    query: LokiLogsQuery,
) -> CoreResult<impl Stream<Item = LokiUpdate> + Send + 'static> {
    validate_logs_query(&query, now_ms())?;
    let (loki, scheme, container_label) = readable(mgr, cluster, settings).await?;
    let container = query.container.as_deref().filter(|_| container_label);
    let selector = logql::stream_selector(
        scheme,
        &query.namespace,
        &logql::PodMatch::Exact(&query.pod),
        container,
    );
    Ok(pages(Pager::new(Box::new(loki), selector, &query)))
}

/// Where the pages come from (Loki, or a test's answers).
pub(crate) trait Source: Send + Sync {
    fn query<'a>(
        &'a self,
        selector: &'a str,
        start_ns: i64,
        end_ns: i64,
        limit: u32,
        direction: LokiDirection,
    ) -> futures::future::BoxFuture<'a, CoreResult<Vec<(i64, String)>>>;
}

impl Source for client::Loki {
    fn query<'a>(
        &'a self,
        selector: &'a str,
        start_ns: i64,
        end_ns: i64,
        limit: u32,
        direction: LokiDirection,
    ) -> futures::future::BoxFuture<'a, CoreResult<Vec<(i64, String)>>> {
        Box::pin(self.query_range(selector, start_ns, end_ns, limit, direction))
    }
}

/// The paging of a read, as `logcli` does it: the next request starts at the last timestamp sent (forward) or ends
/// one nanosecond after it (backward, `end` being excluded), and the lines with that timestamp already sent are
/// dropped from its answer, so lines sharing a timestamp across a page break are neither lost nor sent twice.
pub(crate) struct Pager {
    source: Box<dyn Source>,
    selector: String,
    start_ns: i64,
    end_ns: i64,
    direction: LokiDirection,
    limit: u32,
    sent: u32,
    bytes: usize,
    requests: u32,
    /// The lines sent with the timestamp the next request starts or ends at.
    boundary: Vec<(i64, String)>,
    /// Set when the read is over: whether lines were left.
    over: Option<bool>,
    /// Lines were stepped over without being sent (more lines on one timestamp than one answer holds): the read
    /// ends as cut, whatever comes after.
    skipped: bool,
    /// The most lines one request asks for ([`MAX_LINES`], Loki's default `max_entries_limit_per_query`).
    max_ask: u32,
}

/// What [`Pager::next_page`] got.
pub(crate) enum Step {
    Page(Vec<LokiEntry>),
    End(bool),
    Fail(CoreError),
}

impl Pager {
    pub(crate) fn new(source: Box<dyn Source>, selector: String, query: &LokiLogsQuery) -> Self {
        Self {
            source,
            selector,
            start_ns: ns(query.range.start_ms),
            end_ns: ns(query.range.end_ms),
            direction: query.direction,
            limit: query.limit.min(MAX_LINES),
            sent: 0,
            bytes: 0,
            requests: 0,
            boundary: Vec::new(),
            over: None,
            skipped: false,
            max_ask: MAX_LINES,
        }
    }

    /// The same pager asking at most `max_ask` lines per request (tests: a source that holds more lines on one
    /// timestamp than one answer).
    #[cfg(test)]
    pub(crate) fn with_max_ask(mut self, max_ask: u32) -> Self {
        self.max_ask = max_ask;
        self
    }
}

impl Pager {
    /// The next page (oldest line first), or the end.
    pub(crate) async fn next_page(&mut self) -> Step {
        loop {
            if let Some(left) = self.over {
                return Step::End(left || self.skipped);
            }
            if self.sent >= self.limit || self.bytes >= MAX_TEXT_BYTES {
                return Step::End(true);
            }
            if self.requests >= MAX_REQUESTS {
                return Step::End(true);
            }
            self.requests += 1;
            let want = (self.limit - self.sent).min(PAGE_LINES);
            let boundary = u32::try_from(self.boundary.len()).unwrap_or(u32::MAX);
            let ask = want.saturating_add(boundary).min(self.max_ask);
            let got = match self
                .source
                .query(
                    &self.selector,
                    self.start_ns,
                    self.end_ns,
                    ask,
                    self.direction,
                )
                .await
            {
                Ok(got) => got,
                Err(err) => return Step::Fail(err),
            };
            let full = u32::try_from(got.len()).unwrap_or(u32::MAX) >= ask;
            let mut fresh = without_sent(got, &self.boundary);
            let more = fresh.len() > want as usize;
            match self.direction {
                LokiDirection::Backward => {
                    let extra = fresh.len().saturating_sub(want as usize);
                    fresh.drain(..extra);
                }
                LokiDirection::Forward => fresh.truncate(want as usize),
            }
            let Some(edge) = (match self.direction {
                LokiDirection::Backward => fresh.first(),
                LokiDirection::Forward => fresh.last(),
            })
            .map(|(ts, _)| *ts) else {
                if full && let Some((ts, _)) = self.boundary.first() {
                    // Only lines already sent came back (more lines share that timestamp than a page holds):
                    // step past the timestamp. Its lines that were not sent are lost, so the read is cut.
                    self.skipped = true;
                    match self.direction {
                        LokiDirection::Backward => self.end_ns = *ts,
                        LokiDirection::Forward => self.start_ns = ts.saturating_add(1),
                    }
                    self.boundary.clear();
                    continue;
                }
                return Step::End(self.skipped);
            };
            self.boundary.retain(|(ts, _)| *ts == edge);
            self.boundary
                .extend(fresh.iter().filter(|(ts, _)| *ts == edge).cloned());
            match self.direction {
                LokiDirection::Backward => self.end_ns = edge.saturating_add(1),
                LokiDirection::Forward => self.start_ns = edge,
            }
            self.sent += u32::try_from(fresh.len()).unwrap_or(u32::MAX);
            self.bytes += fresh.iter().map(|(_, line)| line.len()).sum::<usize>();
            if !full && !more {
                self.over = Some(false);
            } else if self.sent >= self.limit {
                self.over = Some(true);
            }
            return Step::Page(
                fresh
                    .into_iter()
                    .flat_map(|(ts, line)| pieces(ts, line))
                    .collect(),
            );
        }
    }
}

/// `got` without one line for each of `sent` (equal timestamp and text).
fn without_sent(got: Vec<(i64, String)>, sent: &[(i64, String)]) -> Vec<(i64, String)> {
    if sent.is_empty() {
        return got;
    }
    let mut left: Vec<&(i64, String)> = sent.iter().collect();
    got.into_iter()
        .filter(|entry| match left.iter().position(|s| *s == entry) {
            Some(i) => {
                left.swap_remove(i);
                false
            }
            None => true,
        })
        .collect()
}

/// A line as entries of at most [`MAX_LINE_BYTES`], cut at character boundaries; every piece but the last is
/// marked `cut`.
pub(crate) fn pieces(ts: i64, line: String) -> Vec<LokiEntry> {
    let ts = ts.to_string();
    if line.len() <= MAX_LINE_BYTES {
        return vec![LokiEntry {
            ts,
            line,
            cut: false,
        }];
    }
    let mut out = Vec::new();
    let mut rest = line.as_str();
    while rest.len() > MAX_LINE_BYTES {
        let mut at = MAX_LINE_BYTES;
        while !rest.is_char_boundary(at) {
            at -= 1;
        }
        out.push(LokiEntry {
            ts: ts.clone(),
            line: rest[..at].to_owned(),
            cut: true,
        });
        rest = &rest[at..];
    }
    out.push(LokiEntry {
        ts,
        line: rest.to_owned(),
        cut: false,
    });
    out
}

/// The pages of `pager` as updates, then the end.
pub(crate) fn pages(pager: Pager) -> impl Stream<Item = LokiUpdate> + Send + 'static {
    futures::stream::unfold(Some(pager), |state| async move {
        let mut pager = state?;
        match pager.next_page().await {
            Step::Page(entries) => Some((LokiUpdate::Entries { entries }, Some(pager))),
            Step::End(truncated) => Some((
                LokiUpdate::Ended {
                    lines: pager.sent,
                    truncated,
                },
                None,
            )),
            Step::Fail(err) => Some((LokiUpdate::Error(err), None)),
        }
    })
}
