//! Alerts (#264, ADR-0119), read-only: the firing and pending alerts of the cluster's Prometheus-compatible source
//! (`api/v1/alerts`; VictoriaMetrics only through vmalert, `vmalert/api/v1/alerts`) and the alerts and silences of its
//! Alertmanager (`api/v2/alerts`, `api/v2/silences`).
//!
//! Both are reached through the API server's service proxy with the user's own credentials (a manual Prometheus URL
//! excepted, as everywhere else): nothing is installed, stored or changed, and no credential is asked for. Sextant
//! builds every path and query itself; the window chooses only Off, Auto or a Service address in the cluster settings,
//! which is validated here before it is used, and never sends a URL, a path, a query or a matcher. Every request has a
//! time limit and a cap on the answer's size; the answer is cut to [`MAX_ALERTS`] alerts, annotations and labels are
//! clipped, every URI in a text loses its credentials, query and fragment, and only `http(s)` annotation values become
//! links.

mod alertmanager;
mod read;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::future::join_all;
use k8s_openapi::api::core::v1::Service;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::metrics::{self, MetricsSourceKind, PrometheusMode, PrometheusTarget};

pub use read::{clean_text, safe_uri};

/// At most this many alerts are returned (most severe first); the rest are counted.
pub const MAX_ALERTS: usize = 5000;
/// At most this many silences are returned (active and pending ones).
pub const MAX_SILENCES: usize = 5000;
/// The largest answer read from either source; a bigger one is an error, not cut.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// How long one request may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// An annotation (or a silence's comment) is clipped to this many bytes.
pub const MAX_ANNOTATION_BYTES: usize = 2048;
/// At most this many labels of an alert are kept (by name).
pub const MAX_LABELS: usize = 64;
/// A label value (or a silence matcher's value) is clipped to this many bytes.
pub const MAX_LABEL_BYTES: usize = 512;
/// At most this many other annotations and links of an alert are kept.
pub const MAX_OTHER_ANNOTATIONS: usize = 16;
pub const MAX_LINKS: usize = 8;
/// How long an Alertmanager detection result (also "not found") is reused for a connection.
const DETECT_TTL: Duration = Duration::from_secs(60);

/// How the Alertmanager is found (a cluster setting, like [`PrometheusMode`]). Serialized with a `mode` tag.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(tag = "mode", rename_all = "camelCase")]
#[ts(export)]
pub enum AlertmanagerMode {
    #[default]
    Auto,
    Manual {
        target: AlertmanagerTarget,
    },
    Off,
}

/// An Alertmanager Service, reached through the API server's service proxy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AlertmanagerTarget {
    pub namespace: String,
    pub service: String,
    pub port: u16,
    /// Alertmanager's `--web.route-prefix`; empty for `/`.
    #[serde(default)]
    pub path_prefix: String,
}

impl AlertmanagerTarget {
    /// `namespace/service:port/prefix`, as the window shows it.
    pub fn describe(&self) -> String {
        format!(
            "{}/{}:{}{}",
            self.namespace,
            self.service,
            self.port,
            normalized_prefix(&self.path_prefix)
        )
    }

    /// The service proxy path in front of `api/v2/…` (the prefix checked by [`validate_target`]).
    fn base(&self) -> String {
        format!(
            "/api/v1/namespaces/{}/services/{}:{}/proxy{}",
            self.namespace,
            self.service,
            self.port,
            normalized_prefix(&self.path_prefix)
        )
    }
}

/// `""` or `/a/b` (no trailing slash).
fn normalized_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

/// What an alert's state is: Prometheus' (`firing`, `pending`) and Alertmanager's (active → firing, suppressed by a
/// silence → silenced, by an inhibition → inhibited).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AlertState {
    Firing,
    Pending,
    Silenced,
    Inhibited,
}

/// Where an alert was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AlertOrigin {
    /// The rules of the Prometheus-compatible source (vmalert for VictoriaMetrics).
    Prometheus,
    Alertmanager,
}

/// A link from an annotation (`runbook_url`, `dashboard`, …): an `http(s)` URL without credentials, query or fragment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AlertLink {
    /// The annotation's name.
    pub key: String,
    pub url: String,
    /// Credentials, a query or a fragment were left out.
    pub cleaned: bool,
}

/// One alert, clipped and cleaned (see the module's notes).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Alert {
    /// Alertmanager's fingerprint, or a hash of the labels for an alert read from Prometheus.
    pub id: String,
    /// The `alertname` label.
    pub name: String,
    pub state: AlertState,
    /// The `severity` label, lower-cased.
    pub severity: Option<String>,
    /// At most [`MAX_LABELS`], values clipped.
    pub labels: std::collections::BTreeMap<String, String>,
    /// The `summary` annotation (else `message`), plain text.
    pub summary: Option<String>,
    pub description: Option<String>,
    /// Other annotations that are not links, by name.
    pub annotations: Vec<(String, String)>,
    pub links: Vec<AlertLink>,
    /// Since when it is pending or firing (Prometheus' `activeAt`, Alertmanager's `startsAt`), RFC 3339.
    pub active_at: Option<String>,
    pub origin: AlertOrigin,
    /// Ids of the silences or of the alerts that suppress it.
    pub silenced_by: Vec<String>,
    pub inhibited_by: Vec<String>,
}

/// A silence's matcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SilenceMatcher {
    pub name: String,
    pub value: String,
    pub is_regex: bool,
    /// `false` for `!=` / `!~`.
    pub is_equal: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SilenceState {
    Active,
    Pending,
    Expired,
}

/// One silence of the Alertmanager (read-only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Silence {
    pub id: String,
    pub state: SilenceState,
    pub matchers: Vec<SilenceMatcher>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub created_by: Option<String>,
    pub comment: Option<String>,
}

/// What a source gave.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum AlertSourceStatus {
    /// Turned off in the cluster settings.
    Off,
    /// Nothing answering was found (auto) or nothing is set.
    NotFound,
    /// The source exists but cannot give alerts: a VictoriaMetrics without `-vmalert.proxyURL`.
    NotAvailable,
    Ok,
    /// The request failed (`error` says why).
    Failed,
}

/// One source of a report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AlertSource {
    pub status: AlertSourceStatus,
    /// `namespace/service:port/prefix` or the URL of the source asked.
    pub target: Option<String>,
    /// What answers there, when its name or path tells (Prometheus-compatible sources only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kind: Option<MetricsSourceKind>,
    pub error: Option<CoreError>,
}

impl AlertSource {
    fn of(status: AlertSourceStatus) -> Self {
        Self {
            status,
            target: None,
            kind: None,
            error: None,
        }
    }
}

/// The alerts of a cluster: both sources' states, the alerts (most severe first) and the Alertmanager's silences.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AlertsReport {
    pub prometheus: AlertSource,
    pub alertmanager: AlertSource,
    /// At most [`MAX_ALERTS`]: Alertmanager's (firing, silenced, inhibited), Prometheus' pending ones, and Prometheus'
    /// firing ones that Alertmanager does not hold.
    pub alerts: Vec<Alert>,
    /// Alerts before the cap.
    pub total_alerts: u32,
    pub truncated: bool,
    /// Active and pending silences, at most [`MAX_SILENCES`]; expired ones are only counted.
    pub silences: Vec<Silence>,
    pub expired_silences: u32,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A DNS-1123 label of at most `max` characters (`first_letter`: a DNS-1035 label, as Service names are).
fn is_label(text: &str, max: usize, first_letter: bool) -> bool {
    let b = text.as_bytes();
    !b.is_empty()
        && b.len() <= max
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && (!first_letter || b[0].is_ascii_lowercase())
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

/// Checks a manual Alertmanager address: a namespace and a Service name, a port, and a path prefix of plain segments
/// (letters, digits, `.`, `_`, `~`, `-`; no `..`, query, fragment or escape), at most 200 characters.
pub fn validate_target(target: &AlertmanagerTarget) -> CoreResult<()> {
    if !is_label(&target.namespace, 63, false) {
        return Err(invalid("the Alertmanager namespace is not a valid name"));
    }
    if !is_label(&target.service, 63, true) {
        return Err(invalid("the Alertmanager Service is not a valid name"));
    }
    if target.port == 0 {
        return Err(invalid("the Alertmanager port must be 1–65535"));
    }
    let prefix = target.path_prefix.trim();
    let segments_ok = prefix.split('/').filter(|s| !s.is_empty()).all(|s| {
        s != "."
            && s != ".."
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'~' | b'-'))
    });
    if prefix.len() > 200 || !segments_ok || (!prefix.is_empty() && !prefix.starts_with('/')) {
        return Err(invalid(
            "the Alertmanager path prefix must look like /alertmanager",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Alertmanager detection

/// A known Alertmanager Service name: its rank (lower first) and the ports to use (the first the Service has).
///
/// - `alertmanager-operated`: the governing Service prometheus-operator creates for every `Alertmanager` (port `web`
///   9093) — kube-prometheus, kube-prometheus-stack and any other operator install.
/// - `alertmanager-main`: kube-prometheus' own Service (`manifests/alertmanager-service.yaml`, 9093).
/// - `…-alertmanager`: kube-prometheus-stack's `<fullname>-alertmanager` (`templates/alertmanager/service.yaml`,
///   `alertmanager.service.port` 9093) and the prometheus-community `alertmanager` chart's `<release>-alertmanager`
///   (`templates/services.yaml`, `service.port` 9093; also the `prometheus` chart's subchart); 80 for the old
///   `prometheus` chart's own `<release>-alertmanager`.
/// - `alertmanager`: the `alertmanager` chart when the release name contains the chart's (`alertmanager.fullname`).
/// - `vmalertmanager-<name>`: VictoriaMetrics operator's `VMAlertmanager.PrefixedName()` (default port 9093,
///   `VMAlertmanager.Port()`), as victoria-metrics-k8s-stack creates it.
fn known(name: &str) -> Option<(u8, &'static [u16])> {
    if name == "alertmanager-operated" {
        Some((0, &[9093]))
    } else if name == "alertmanager-main" {
        Some((1, &[9093]))
    } else if name.starts_with("vmalertmanager-") {
        Some((10, &[9093]))
    } else if name.ends_with("-alertmanager") {
        Some((2, &[9093, 80]))
    } else if name == "alertmanager" {
        Some((3, &[9093]))
    } else {
        None
    }
}

/// A known Service's rank and port; `None` for another name or one without its port.
fn candidate(service: &Service) -> Option<(u8, u16)> {
    let name = service.metadata.name.as_deref()?;
    let (rank, ports) = known(name)?;
    let has: Vec<u16> = service
        .spec
        .as_ref()?
        .ports
        .iter()
        .flatten()
        .filter_map(|p| u16::try_from(p.port).ok())
        .collect();
    let port = *ports.iter().find(|p| has.contains(p))?;
    Some((rank, port))
}

type Detected = HashMap<ClusterId, (u64, Instant, Option<AlertmanagerTarget>)>;
static DETECTED: LazyLock<Mutex<Detected>> = LazyLock::new(Default::default);

fn lock_detected() -> std::sync::MutexGuard<'static, Detected> {
    DETECTED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The first known Alertmanager Service in the namespaces Prometheus is looked for in ([`metrics::CANDIDATE_NAMESPACES`],
/// one list each, in parallel) that answers `api/v2/alerts` through the service proxy: Prometheus' Alertmanagers
/// before VictoriaMetrics', then by namespace, then by rank. Kept a minute per connection, "not found" too.
async fn detect(
    mgr: &ClusterManager,
    cluster: &ClusterId,
) -> CoreResult<Option<AlertmanagerTarget>> {
    let client = mgr.client(cluster)?;
    let connection = mgr.connection(cluster)?;
    if let Some((conn, at, found)) = lock_detected().get(cluster)
        && *conn == connection
        && at.elapsed() < DETECT_TTL
    {
        return Ok(found.clone());
    }
    let lists = join_all(metrics::CANDIDATE_NAMESPACES.iter().map(|ns| {
        let client = client.clone();
        async move {
            let api: Api<Service> = Api::namespaced(client, ns);
            // A missing namespace lists nothing; a forbidden one is skipped.
            api.list(&ListParams::default())
                .await
                .map(|l| l.items)
                .unwrap_or_default()
        }
    }))
    .await;
    let mut candidates: Vec<(bool, usize, u8, AlertmanagerTarget)> = Vec::new();
    for (index, services) in lists.into_iter().enumerate() {
        for service in services {
            if let Some((rank, port)) = candidate(&service) {
                candidates.push((
                    rank >= 10,
                    index,
                    rank,
                    AlertmanagerTarget {
                        namespace: metrics::CANDIDATE_NAMESPACES[index].to_owned(),
                        service: service.metadata.name.clone().unwrap_or_default(),
                        port,
                        path_prefix: String::new(),
                    },
                ));
            }
        }
    }
    candidates.sort_by_key(|(victoria, index, rank, _)| (*victoria, *index, *rank));
    let mut found = None;
    for (_, _, _, target) in candidates {
        if alertmanager::probe(&client, &target).await.is_ok() {
            found = Some(target);
            break;
        }
    }
    lock_detected().insert(cluster.clone(), (connection, Instant::now(), found.clone()));
    Ok(found)
}

// ---------------------------------------------------------------------------------------------------------------
// The report

/// The alerts of `cluster` from the Prometheus-compatible source of `prometheus` and the Alertmanager of
/// `alertmanager` (both cluster settings), asked in parallel. A source that fails is reported in its [`AlertSource`];
/// only a cluster that is not connected is an error.
pub async fn report(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    prometheus: &PrometheusMode,
    alertmanager: &AlertmanagerMode,
) -> CoreResult<AlertsReport> {
    mgr.client(cluster)?;
    let (from_prometheus, from_alertmanager) = futures::join!(
        prometheus_part(mgr, cluster, prometheus),
        alertmanager_part(mgr, cluster, alertmanager)
    );
    let (prometheus, prometheus_alerts) = from_prometheus;
    let mut from_alertmanager = from_alertmanager;
    let held = alertmanager_ok(&from_alertmanager.source)
        .then(|| std::mem::take(&mut from_alertmanager.alerts));
    let mut alerts = read::merge(held, prometheus_alerts);
    let total_alerts = alerts.len();
    alerts.truncate(MAX_ALERTS);
    Ok(AlertsReport {
        prometheus,
        alertmanager: from_alertmanager.source,
        total_alerts: u32::try_from(total_alerts).unwrap_or(u32::MAX),
        truncated: total_alerts > MAX_ALERTS,
        alerts,
        silences: from_alertmanager.silences,
        expired_silences: from_alertmanager.expired,
    })
}

fn alertmanager_ok(source: &AlertSource) -> bool {
    source.status == AlertSourceStatus::Ok
}

/// `namespace/service:port/prefix`, or the URL without credentials, query or fragment.
fn describe_prometheus(target: &PrometheusTarget) -> String {
    match target {
        PrometheusTarget::Service {
            namespace,
            service,
            port,
            path_prefix,
        } => format!(
            "{namespace}/{service}:{port}{}",
            normalized_prefix(path_prefix)
        ),
        PrometheusTarget::Url { url } => safe_uri(url).map(|u| u.0).unwrap_or_default(),
    }
}

fn failed(target: Option<String>, kind: Option<MetricsSourceKind>, err: CoreError) -> AlertSource {
    AlertSource {
        status: AlertSourceStatus::Failed,
        target,
        kind,
        error: Some(err),
    }
}

/// Prometheus' `api/v1/alerts`; for VictoriaMetrics vmalert's, through `vmalert/api/v1/alerts`, which single-node and
/// vmselect proxy only with `-vmalert.proxyURL` (and refuse with HTTP 400 otherwise): their own `api/v1/alerts` answers
/// an empty placeholder without it, so it cannot tell "no alerts" from "no vmalert".
async fn prometheus_part(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &PrometheusMode,
) -> (AlertSource, Vec<Alert>) {
    let target = match metrics::prometheus_target(mgr, cluster, mode).await {
        Err(err) => return (failed(None, None, err), Vec::new()),
        Ok(None) if *mode == PrometheusMode::Off => {
            return (AlertSource::of(AlertSourceStatus::Off), Vec::new());
        }
        Ok(None) => return (AlertSource::of(AlertSourceStatus::NotFound), Vec::new()),
        Ok(Some(target)) => target,
    };
    let kind = metrics::source_kind(&target);
    let described = Some(describe_prometheus(&target));
    let victoria = matches!(
        kind,
        Some(MetricsSourceKind::VictoriaMetricsSingle | MetricsSourceKind::VictoriaMetricsCluster)
    );
    let path = if victoria {
        "vmalert/api/v1/alerts"
    } else {
        "api/v1/alerts"
    };
    let answer = async {
        let client = mgr.client(cluster)?;
        let prometheus = metrics::Prometheus::new(&client, &target)?;
        prometheus.get_raw_limited(path, MAX_BODY).await
    };
    match answer.await {
        Err(err) => (failed(described, kind, err), Vec::new()),
        Ok((status, _)) if victoria && matches!(status.as_u16(), 400 | 404) => (
            AlertSource {
                status: AlertSourceStatus::NotAvailable,
                target: described,
                kind,
                error: None,
            },
            Vec::new(),
        ),
        Ok((status, body)) => match read::prometheus_alerts(status, &body) {
            Ok(alerts) => (
                AlertSource {
                    status: AlertSourceStatus::Ok,
                    target: described,
                    kind,
                    error: None,
                },
                alerts,
            ),
            Err(err) => (failed(described, kind, err), Vec::new()),
        },
    }
}

/// What the Alertmanager gave.
struct AlertmanagerPart {
    source: AlertSource,
    alerts: Vec<Alert>,
    silences: Vec<Silence>,
    expired: u32,
}

impl AlertmanagerPart {
    fn only(source: AlertSource) -> Self {
        Self {
            source,
            alerts: Vec::new(),
            silences: Vec::new(),
            expired: 0,
        }
    }
}

async fn alertmanager_part(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    mode: &AlertmanagerMode,
) -> AlertmanagerPart {
    let target = match mode {
        AlertmanagerMode::Off => {
            return AlertmanagerPart::only(AlertSource::of(AlertSourceStatus::Off));
        }
        AlertmanagerMode::Manual { target } => match validate_target(target) {
            Ok(()) => target.clone(),
            Err(err) => return AlertmanagerPart::only(failed(None, None, err)),
        },
        AlertmanagerMode::Auto => match detect(mgr, cluster).await {
            Err(err) => return AlertmanagerPart::only(failed(None, None, err)),
            Ok(None) => {
                return AlertmanagerPart::only(AlertSource::of(AlertSourceStatus::NotFound));
            }
            Ok(Some(target)) => target,
        },
    };
    let described = Some(target.describe());
    let client = match mgr.client(cluster) {
        Ok(client) => client,
        Err(err) => return AlertmanagerPart::only(failed(described, None, err)),
    };
    let (alerts, silences) = futures::join!(
        alertmanager::alerts(&client, &target),
        alertmanager::silences(&client, &target)
    );
    let alerts = match alerts {
        Ok(alerts) => alerts,
        Err(err) => return AlertmanagerPart::only(failed(described, None, err)),
    };
    // Silences that cannot be read leave the alerts (which say what silences them) and say so.
    let (silences, expired, error) = match silences {
        Ok((silences, expired)) => (silences, expired, None),
        Err(err) => (Vec::new(), 0, Some(err)),
    };
    AlertmanagerPart {
        source: AlertSource {
            status: AlertSourceStatus::Ok,
            target: described,
            kind: None,
            error,
        },
        alerts,
        silences,
        expired,
    }
}
