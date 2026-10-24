//! The LogQL Sextant sends: stream selectors over a fixed set of label schemes, from validated names only.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The labels a Loki installation puts on Kubernetes log streams, as far as Sextant reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum LokiLabelScheme {
    /// `namespace`, `pod`, `container`: what Promtail's and Grafana Alloy's Kubernetes discovery examples and the
    /// grafana/loki chart's own log collection write.
    Kubernetes,
    /// `k8s_namespace_name`, `k8s_pod_name`, `k8s_container_name`: OpenTelemetry resource attributes, which Loki's
    /// native OTLP ingestion turns into these index labels by default.
    OpenTelemetry,
}

impl LokiLabelScheme {
    /// Every scheme, in order of preference.
    pub const ALL: [LokiLabelScheme; 2] = [Self::Kubernetes, Self::OpenTelemetry];

    pub fn namespace(self) -> &'static str {
        match self {
            Self::Kubernetes => "namespace",
            Self::OpenTelemetry => "k8s_namespace_name",
        }
    }

    pub fn pod(self) -> &'static str {
        match self {
            Self::Kubernetes => "pod",
            Self::OpenTelemetry => "k8s_pod_name",
        }
    }

    pub fn container(self) -> &'static str {
        match self {
            Self::Kubernetes => "container",
            Self::OpenTelemetry => "k8s_container_name",
        }
    }

    /// The first scheme whose namespace and pod labels are both among `labels`, and whether its container label is
    /// there too.
    pub fn detect(labels: &[String]) -> Option<(Self, bool)> {
        let has = |name: &str| labels.iter().any(|l| l == name);
        Self::ALL
            .into_iter()
            .find(|s| has(s.namespace()) && has(s.pod()))
            .map(|s| (s, has(s.container())))
    }
}

pub use crate::pod_names::{WORKLOAD_KINDS, pod_name_pattern};

/// A LogQL string literal (double quotes, Go escapes).
fn literal(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', r"\\").replace('"', "\\\""))
}

/// How the pod label is matched.
pub(crate) enum PodMatch<'a> {
    Exact(&'a str),
    /// A regular expression from [`pod_name_pattern`] (`crate::pod_names`).
    Pattern(String),
}

/// `{<namespace>="…", <pod>="…" | <pod>=~"…"[, <container>="…"]}`.
pub(crate) fn stream_selector(
    scheme: LokiLabelScheme,
    namespace: &str,
    pod: &PodMatch<'_>,
    container: Option<&str>,
) -> String {
    let mut out = format!("{{{}={}", scheme.namespace(), literal(namespace));
    match pod {
        PodMatch::Exact(name) => out.push_str(&format!(", {}={}", scheme.pod(), literal(name))),
        PodMatch::Pattern(re) => out.push_str(&format!(", {}=~{}", scheme.pod(), literal(re))),
    }
    if let Some(container) = container {
        out.push_str(&format!(", {}={}", scheme.container(), literal(container)));
    }
    out.push('}');
    out
}
