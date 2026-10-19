//! Costs from OpenCost or Kubecost's compatible allocation API (#153), read-only.
//!
//! The cost service is found among the cluster's Services (the `opencost` and `kubecost` namespaces, and anywhere
//! by the label `app.kubernetes.io/name` `opencost` / `cost-analyzer`) and reached through the API server's service
//! proxy (`/api/v1/namespaces/<ns>/services/<svc>:<port>/proxy/…`), as Prometheus is: no local port is opened,
//! nothing is held between calls, so closing a cluster leaves nothing behind, and no credentials are needed or kept
//! (the user's own RBAC decides, `services/proxy` `get`). Sextant builds every path and query parameter itself from
//! a fixed set (window, aggregation, namespaces); each request has a timeout and a cap on the answer's size, and only
//! the fields the views need are kept. Sextant never installs OpenCost.

mod client;
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

pub use client::{MAX_BODY, MAX_ROWS, REQUEST_TIMEOUT};

/// Namespaces whose Services are all looked at, in order of preference.
pub const CANDIDATE_NAMESPACES: [&str; 2] = ["opencost", "kubecost"];
/// Services anywhere with one of these `app.kubernetes.io/name` values are candidates too.
const LABEL_SELECTOR: &str = "app.kubernetes.io/name in (opencost,cost-analyzer)";
/// At most this many labelled Services are listed cluster-wide.
const LABELLED_LIMIT: u32 = 50;
/// How long a discovery result (also "not found") is reused for a connection.
const DETECT_TTL: Duration = Duration::from_secs(60);
/// At most this many namespaces in a filter.
pub const MAX_FILTER_NAMESPACES: usize = 200;

/// Which product answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum CostProduct {
    Opencost,
    Kubecost,
}

/// The cost service that was found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CostSource {
    pub product: CostProduct,
    pub namespace: String,
    pub service: String,
    pub port: u16,
}

impl CostSource {
    /// The allocation API's path on this service's port: OpenCost's cost model listens on 9003 and its UI (9090)
    /// proxies `/model/`; Kubecost's frontend (9090) serves `/model/allocation`, its cost model (9003) `/allocation`.
    pub fn api_path(&self) -> &'static str {
        match (self.product, self.port) {
            (CostProduct::Opencost, 9003) => "/allocation/compute",
            (CostProduct::Opencost, _) => "/model/allocation/compute",
            (CostProduct::Kubecost, 9003) => "/allocation",
            (CostProduct::Kubecost, _) => "/model/allocation",
        }
    }
}

/// The period costs are summed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CostWindow {
    Day,
    Week,
    Month,
}

impl CostWindow {
    /// The `window` parameter.
    pub fn param(self) -> &'static str {
        match self {
            Self::Day => "24h",
            Self::Week => "7d",
            Self::Month => "30d",
        }
    }

    pub fn hours(self) -> f64 {
        match self {
            Self::Day => 24.0,
            Self::Week => 168.0,
            Self::Month => 720.0,
        }
    }
}

/// What costs are grouped by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum CostAggregate {
    Namespace,
    /// Controllers (Deployment, StatefulSet, …) within their namespaces.
    Workload,
    Pod,
    Node,
    /// The value of one label; `key` as on the objects (`app.kubernetes.io/name`).
    Label {
        key: String,
    },
}

/// One allocation request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CostQuery {
    pub window: CostWindow,
    pub aggregate: CostAggregate,
    /// Only these namespaces; `None` = all.
    pub namespaces: Option<Vec<String>>,
}

/// Costs of one group over the window. Each part includes the API's adjustment of it; `other_cost` is what the total
/// holds beyond the parts (load balancers, shared and external costs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CostRow {
    /// The group's name as the API gives it (`__idle__`, `__unallocated__` for the special groups).
    pub name: String,
    /// Properties every allocation of the group shares, when the API says.
    pub namespace: Option<String>,
    pub controller_kind: Option<String>,
    pub controller: Option<String>,
    pub pod: Option<String>,
    pub node: Option<String>,
    pub cpu_cost: f64,
    pub ram_cost: f64,
    pub pv_cost: f64,
    pub network_cost: f64,
    pub gpu_cost: f64,
    pub other_cost: f64,
    pub total_cost: f64,
    /// CPU cores × hours and RAM bytes × hours the costs are for (unit prices: cost ÷ these).
    pub cpu_core_hours: f64,
    pub ram_byte_hours: f64,
    /// Minutes of the window the group ran.
    pub minutes: f64,
    /// Usage ÷ request, as fractions, when the API gives them.
    pub cpu_efficiency: Option<f64>,
    pub ram_efficiency: Option<f64>,
    pub total_efficiency: Option<f64>,
}

/// The answer of [`allocation`]. `source: None`: no OpenCost or Kubecost was found (and `rows` is empty).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CostReport {
    pub source: Option<CostSource>,
    pub window: CostWindow,
    /// ISO 4217 code when the answer names one; otherwise the numbers are in the installation's currency.
    pub currency: Option<String>,
    /// Most expensive first, at most [`MAX_ROWS`]; the idle cost is not among them.
    pub rows: Vec<CostRow>,
    pub idle: Option<CostRow>,
    /// Groups the answer had before the cap.
    pub total_rows: u32,
    pub truncated: bool,
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A namespace name (DNS-1123 label).
fn is_namespace(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0] != b'-'
        && bytes[bytes.len() - 1] != b'-'
}

/// A label key: an optional DNS prefix and `/`, then a name of letters, digits, `-`, `_`, `.`.
fn is_label_key(key: &str) -> bool {
    let (prefix, name) = match key.split_once('/') {
        Some((p, n)) => (Some(p), n),
        None => (None, key),
    };
    let name_ok = !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric();
    let prefix_ok = prefix.is_none_or(|p| {
        !p.is_empty()
            && p.len() <= 253
            && p.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"-.".contains(&b))
    });
    name_ok && prefix_ok
}

/// Checks a query before anything is sent.
pub fn validate(query: &CostQuery) -> CoreResult<()> {
    if let CostAggregate::Label { key } = &query.aggregate
        && !is_label_key(key)
    {
        return Err(invalid(format!("{key:?} is not a label key")));
    }
    if let Some(namespaces) = &query.namespaces {
        if namespaces.is_empty() || namespaces.len() > MAX_FILTER_NAMESPACES {
            return Err(invalid(format!(
                "a namespace filter needs 1 to {MAX_FILTER_NAMESPACES} namespaces"
            )));
        }
        if let Some(bad) = namespaces.iter().find(|n| !is_namespace(n)) {
            return Err(invalid(format!("{bad:?} is not a namespace name")));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery

/// What a Service is to discovery: OpenCost or Kubecost, and the port to use; `None` for anything else.
pub(crate) fn classify(service: &Service) -> Option<(CostProduct, u16)> {
    let name = service.metadata.name.as_deref()?;
    let labels = service.metadata.labels.as_ref();
    let label = |key: &str| labels.and_then(|l| l.get(key)).map(String::as_str);
    let app_name = label("app.kubernetes.io/name");
    let product = if app_name == Some("opencost") || name == "opencost" {
        CostProduct::Opencost
    } else if app_name == Some("cost-analyzer")
        || label("app") == Some("cost-analyzer")
        || name.ends_with("cost-analyzer")
    {
        CostProduct::Kubecost
    } else {
        return None;
    };
    let ports: Vec<u16> = service
        .spec
        .as_ref()?
        .ports
        .iter()
        .flatten()
        .filter_map(|p| u16::try_from(p.port).ok())
        .collect();
    let preferred: [u16; 2] = match product {
        CostProduct::Opencost => [9003, 9090],
        CostProduct::Kubecost => [9090, 9003],
    };
    let port = preferred.into_iter().find(|p| ports.contains(p))?;
    Some((product, port))
}

/// The best candidate among `services`: OpenCost before Kubecost, then the namespaces of [`CANDIDATE_NAMESPACES`]
/// before others, then by namespace and name.
pub(crate) fn pick(services: &[Service]) -> Option<CostSource> {
    let mut found: Vec<CostSource> = services
        .iter()
        .filter_map(|s| {
            let (product, port) = classify(s)?;
            Some(CostSource {
                product,
                namespace: s.metadata.namespace.clone()?,
                service: s.metadata.name.clone()?,
                port,
            })
        })
        .collect();
    let preference = |ns: &str| {
        CANDIDATE_NAMESPACES
            .iter()
            .position(|c| *c == ns)
            .unwrap_or(CANDIDATE_NAMESPACES.len())
    };
    found.sort_by(|a, b| {
        (a.product == CostProduct::Kubecost)
            .cmp(&(b.product == CostProduct::Kubecost))
            .then(preference(&a.namespace).cmp(&preference(&b.namespace)))
            .then(a.namespace.cmp(&b.namespace))
            .then(a.service.cmp(&b.service))
    });
    found.into_iter().next()
}

/// Lists the candidate Services (a namespace or a cluster-wide list that is forbidden or missing adds nothing).
async fn discover(client: &kube::Client) -> Option<CostSource> {
    let namespaced = join_all(CANDIDATE_NAMESPACES.iter().map(|ns| async move {
        let api: Api<Service> = Api::namespaced(client.clone(), ns);
        api.list(&ListParams::default().limit(LABELLED_LIMIT))
            .await
            .map(|l| l.items)
            .unwrap_or_default()
    }));
    let labelled = async {
        let api: Api<Service> = Api::all(client.clone());
        api.list(
            &ListParams::default()
                .labels(LABEL_SELECTOR)
                .limit(LABELLED_LIMIT),
        )
        .await
        .map(|l| l.items)
        .unwrap_or_default()
    };
    let (namespaced, labelled) = futures::join!(namespaced, labelled);
    let all: Vec<Service> = namespaced.into_iter().flatten().chain(labelled).collect();
    pick(&all)
}

/// Discovery results per cluster: when, for which connection, and what was found.
type Detected = HashMap<ClusterId, (Instant, u64, Option<CostSource>)>;

static DETECTED: LazyLock<Mutex<Detected>> = LazyLock::new(Default::default);

fn lock_detected() -> std::sync::MutexGuard<'static, Detected> {
    DETECTED.lock().unwrap_or_else(|e| e.into_inner())
}

/// The cost service of a connected cluster; results (also "not found") are reused for [`DETECT_TTL`] while the
/// connection stays the same.
pub async fn detect(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<Option<CostSource>> {
    let client = mgr.client(cluster)?;
    let connection = mgr.connection(cluster)?;
    if let Some((at, conn, found)) = lock_detected().get(cluster)
        && *conn == connection
        && at.elapsed() < DETECT_TTL
    {
        return Ok(found.clone());
    }
    let found = discover(&client).await;
    lock_detected().insert(cluster.clone(), (Instant::now(), connection, found.clone()));
    Ok(found)
}

/// Costs of `query` from the cluster's OpenCost or Kubecost. The query is checked before anything is sent; without
/// a cost service the report has `source: None`.
pub async fn allocation(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    query: &CostQuery,
) -> CoreResult<CostReport> {
    validate(query)?;
    let Some(source) = detect(mgr, cluster).await? else {
        return Ok(CostReport {
            source: None,
            window: query.window,
            currency: None,
            rows: Vec::new(),
            idle: None,
            total_rows: 0,
            truncated: false,
        });
    };
    let client = mgr.client(cluster)?;
    client::fetch(&client, source, query).await
}
