//! Usage history for right-sizing (#137): per container, the 95th percentile of CPU, the peak of memory, the share of
//! CFS periods throttled, since when there are samples and whether there is one now, over the last day or week, from
//! Prometheus.
//!
//! The PromQL is fixed and built here, never taken from the caller: the scope names only namespaces, a workload or a
//! pod, every name is checked against the Kubernetes naming rules before it is put into a query (and escaped as
//! well), the window is one of two values, each query is bounded in time (by Prometheus and by the client), and the
//! answer is capped at [`MAX_HISTORY_CONTAINERS`] containers.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::PrometheusTarget;
use super::prometheus::{self, Prometheus};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// At most this many containers come back; beyond it the answer is `truncated`.
pub const MAX_HISTORY_CONTAINERS: usize = 5000;
/// At most this many namespaces may be named in one scope.
pub const MAX_HISTORY_NAMESPACES: usize = 200;
/// Workload kinds whose pod names the history can recognise.
pub const HISTORY_WORKLOAD_KINDS: [&str; 3] = ["Deployment", "StatefulSet", "DaemonSet"];

/// Which containers the history is about. Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum HistoryScope {
    /// Every pod of these namespaces (`None` = all namespaces).
    Namespaces {
        namespaces: Option<Vec<String>>,
    },
    /// The pods a Deployment, StatefulSet or DaemonSet created (also the ones gone since), by their generated names.
    Workload {
        namespace: String,
        kind: String,
        name: String,
    },
    Pod {
        namespace: String,
        name: String,
    },
}

/// How far back the history goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum HistoryWindow {
    Day,
    #[default]
    Week,
}

impl HistoryWindow {
    pub fn seconds(self) -> i64 {
        match self {
            HistoryWindow::Day => 24 * 3600,
            HistoryWindow::Week => 7 * 24 * 3600,
        }
    }

    /// The PromQL duration.
    pub(crate) fn promql(self) -> &'static str {
        match self {
            HistoryWindow::Day => "1d",
            HistoryWindow::Week => "7d",
        }
    }
}

/// Usage of one container of one pod over the window. A value Prometheus has no data for is `None`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContainerHistory {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    /// 95th percentile of the 5-minute CPU rate, millicores.
    pub cpu_p95_millicores: Option<f64>,
    /// Peak working set, bytes.
    pub memory_max_bytes: Option<f64>,
    /// Share (0–1) of CFS periods that were throttled; `None` without the cAdvisor counters or a CPU limit.
    pub throttled_ratio: Option<f64>,
    /// Unix seconds of the first sample inside the window (about, at a 10-minute resolution).
    pub first_seen: Option<i64>,
    /// Unix seconds of the latest sample when the container has one now; `None` for a container that is gone.
    pub last_seen: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UsageHistory {
    pub window_secs: i64,
    /// Unix seconds the queries were evaluated at.
    pub evaluated_at: i64,
    /// By namespace, pod and container.
    pub containers: Vec<ContainerHistory>,
    /// More containers matched than [`MAX_HISTORY_CONTAINERS`]; the rest were left out.
    pub truncated: bool,
    /// `false` when Prometheus could not say since when there are samples (`first_seen` is then `None` everywhere):
    /// how much history there is is unknown.
    pub coverage_known: bool,
    /// `false` when Prometheus could not say which containers have a sample now (`last_seen` is `None` everywhere).
    pub live_known: bool,
}

/// The usage history of `scope` over `window` from the Prometheus at `target`.
pub async fn usage_history(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    target: &PrometheusTarget,
    scope: HistoryScope,
    window: HistoryWindow,
) -> CoreResult<UsageHistory> {
    validate_scope(&scope)?;
    let client = mgr.client(cluster)?;
    let prometheus = Prometheus::new(&client, target)?;
    prometheus::usage_history(&prometheus, &scope, window).await
}

fn invalid(message: String) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// A DNS-1123 label (namespaces): lowercase letters, digits and `-`, at most 63, alphanumeric at both ends.
pub(crate) fn is_dns_label(text: &str) -> bool {
    is_dns_name(text, 63, false)
}

/// A DNS-1123 subdomain (pod and workload names): like a label with `.` too, at most 253.
pub(crate) fn is_dns_subdomain(text: &str) -> bool {
    is_dns_name(text, 253, true)
}

fn is_dns_name(text: &str, max: usize, dots: bool) -> bool {
    let bytes = text.as_bytes();
    let alnum = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes.first().is_some_and(alnum)
        && bytes.last().is_some_and(alnum)
        && bytes
            .iter()
            .all(|b| alnum(b) || *b == b'-' || (dots && *b == b'.'))
}

/// Names that are not Kubernetes names never reach a query.
pub(crate) fn validate_scope(scope: &HistoryScope) -> CoreResult<()> {
    let namespace = |ns: &str| {
        if is_dns_label(ns) {
            Ok(())
        } else {
            Err(invalid(format!("{ns:?} is not a namespace name")))
        }
    };
    let name = |n: &str| {
        if is_dns_subdomain(n) {
            Ok(())
        } else {
            Err(invalid(format!("{n:?} is not an object name")))
        }
    };
    match scope {
        HistoryScope::Namespaces { namespaces: None } => Ok(()),
        HistoryScope::Namespaces {
            namespaces: Some(list),
        } => {
            if list.len() > MAX_HISTORY_NAMESPACES {
                return Err(invalid(format!(
                    "at most {MAX_HISTORY_NAMESPACES} namespaces can be asked at once"
                )));
            }
            list.iter().try_for_each(|ns| namespace(ns))
        }
        HistoryScope::Workload {
            namespace: ns,
            kind,
            name: n,
        } => {
            if !HISTORY_WORKLOAD_KINDS.contains(&kind.as_str()) {
                return Err(invalid(format!("no usage history for the kind {kind:?}")));
            }
            namespace(ns)?;
            name(n)
        }
        HistoryScope::Pod {
            namespace: ns,
            name: n,
        } => {
            namespace(ns)?;
            name(n)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kubernetes_names_pass_and_anything_else_is_refused() {
        for good in ["default", "kube-system", "a", "team-1"] {
            assert!(is_dns_label(good), "{good}");
        }
        for bad in [
            "",
            "-a",
            "a-",
            "A",
            "a.b",
            "a\"b",
            "a|b",
            "a}b",
            "a\\b",
            &"x".repeat(64),
        ] {
            assert!(!is_dns_label(bad), "{bad}");
        }
        assert!(is_dns_subdomain("web-7d9f8c-x2x4z"));
        assert!(is_dns_subdomain("api.v2"));
        assert!(!is_dns_subdomain("web.*"));
        assert!(!is_dns_subdomain(&"x".repeat(254)));
    }

    #[test]
    fn a_scope_with_a_name_that_could_change_the_query_is_invalid() {
        let cases = [
            HistoryScope::Namespaces {
                namespaces: Some(vec!["ok".into(), r#"x",namespace=~".+"#.into()]),
            },
            HistoryScope::Pod {
                namespace: "ok".into(),
                name: "p\"} or vector(1) #".into(),
            },
            HistoryScope::Workload {
                namespace: "ok".into(),
                kind: "Deployment".into(),
                name: "web|.*".into(),
            },
            HistoryScope::Workload {
                namespace: "ok".into(),
                kind: "CronJob".into(),
                name: "nightly".into(),
            },
            HistoryScope::Namespaces {
                namespaces: Some(vec!["a".into(); MAX_HISTORY_NAMESPACES + 1]),
            },
        ];
        for scope in cases {
            let err = validate_scope(&scope).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{scope:?}");
        }
        validate_scope(&HistoryScope::Workload {
            namespace: "shop".into(),
            kind: "StatefulSet".into(),
            name: "db".into(),
        })
        .unwrap();
        validate_scope(&HistoryScope::Namespaces { namespaces: None }).unwrap();
    }

    #[test]
    fn windows_are_a_day_and_a_week() {
        assert_eq!(HistoryWindow::Day.seconds(), 86_400);
        assert_eq!(HistoryWindow::Week.promql(), "7d");
        assert_eq!(
            serde_json::to_value(HistoryScope::Pod {
                namespace: "n".into(),
                name: "p".into()
            })
            .unwrap(),
            serde_json::json!({ "type": "pod", "namespace": "n", "name": "p" })
        );
    }
}
