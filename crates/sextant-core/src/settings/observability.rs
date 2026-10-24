//! Links to Grafana dashboards and traces (#266, ADR-0117): per cluster, a Grafana base URL, a dashboard URL template
//! per object kind and a trace URL template. Written by the frontend, which alone checks a template fully (only known
//! variables, the base URL's origin, https) and builds the links; Sextant never requests these URLs — a link is opened
//! in the system browser on the user's click.
//!
//! Read leniently like the other frontend-written settings: a field of the wrong type, a dashboard key this version
//! does not know, an empty, too long or control-character string and a base URL that is not http(s) are left out
//! instead of failing the file.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Longest base URL or template kept, in characters.
pub const MAX_LINK_CHARS: usize = 2048;
/// The objects a dashboard template may be set for.
pub const DASHBOARD_TARGETS: [&str; 5] = ["workload", "pod", "node", "namespace", "edge"];

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(default, rename_all = "camelCase")]
#[ts(export)]
pub struct ObservabilityLinks {
    /// Grafana's base URL (`https://grafana.example.com`, maybe with a path); `None` = no dashboard links.
    pub grafana_url: Option<String>,
    /// A dashboard URL template per target (`workload`, `pod`, `node`, `namespace`, `edge`): a path under the base URL
    /// or an absolute URL of the same origin, with `{variable}` placeholders.
    pub dashboards: BTreeMap<String, String>,
    /// The base URL of trace links (Grafana with Tempo, or Jaeger's UI); `None` = Grafana's.
    pub traces_url: Option<String>,
    /// The trace URL template (by service name and time window); `None` = no trace links.
    pub traces: Option<String>,
}

/// A string worth keeping: non-empty after trimming, short enough, without control or white-space characters.
fn clean(value: Option<&serde_json::Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()
        && text.chars().count() <= MAX_LINK_CHARS
        && !text.chars().any(|c| c.is_control() || c.is_whitespace()))
    .then(|| text.to_owned())
}

fn is_http(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

/// A base URL: an http(s) URL (the frontend allows plain http only for a loopback host).
fn base_url(value: Option<&serde_json::Value>) -> Option<String> {
    clean(value).filter(|t| is_http(t))
}

/// A template: a path under the base URL or an http(s) URL.
fn template(value: Option<&serde_json::Value>) -> Option<String> {
    clean(value).filter(|t| t.starts_with('/') || is_http(t))
}

impl ObservabilityLinks {
    /// Reads a stored value leniently (see the module's header); `None` when nothing is left.
    pub fn read(value: &serde_json::Value) -> Option<Self> {
        let mut dashboards = BTreeMap::new();
        if let Some(stored) = value
            .get("dashboards")
            .and_then(serde_json::Value::as_object)
        {
            for target in DASHBOARD_TARGETS {
                if let Some(t) = template(stored.get(target)) {
                    dashboards.insert(target.to_owned(), t);
                }
            }
        }
        let links = Self {
            grafana_url: base_url(value.get("grafanaUrl")),
            dashboards,
            traces_url: base_url(value.get("tracesUrl")),
            traces: template(value.get("traces")),
        };
        (links != Self::default()).then_some(links)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AppSettings;
    use serde_json::json;

    #[test]
    fn links_are_read_leniently_and_round_trip() {
        let stored = json!({
            "grafanaUrl": " https://grafana.example.com ",
            "dashboards": {
                "pod": "/d/6581e46e4e5c7ba40a07646395ef7b23?var-pod={pod}",
                "workload": "javascript:alert(1)",
                "secret": "/d/x",
                "node": 7,
                "namespace": "/d/x y"
            },
            "tracesUrl": "ftp://jaeger",
            "traces": "https://jaeger.example.com/search?service={service}",
            "extra": true
        });
        let links = ObservabilityLinks::read(&stored).unwrap();
        assert_eq!(
            links.grafana_url.as_deref(),
            Some("https://grafana.example.com")
        );
        assert_eq!(links.dashboards.len(), 1);
        assert!(links.dashboards.contains_key("pod"));
        assert_eq!(links.traces_url, None);
        assert!(links.traces.is_some());
        let back: ObservabilityLinks =
            serde_json::from_value(serde_json::to_value(&links).unwrap()).unwrap();
        assert_eq!(back, links);
    }

    #[test]
    fn links_move_with_a_renamed_context_and_go_with_a_deleted_one() {
        use crate::kubeconfig::ClusterId;
        use crate::kubeconfig::edit::{forget_cluster_settings, move_cluster_settings};
        let mut settings = AppSettings::default();
        let links = ObservabilityLinks {
            grafana_url: Some("https://g.example".into()),
            ..Default::default()
        };
        settings.clusters.insert(
            "old".into(),
            crate::settings::ClusterSettings {
                observability_links: Some(links.clone()),
                ..Default::default()
            },
        );
        move_cluster_settings(
            &mut settings,
            &ClusterId::from("old"),
            &ClusterId::from("new"),
        );
        assert_eq!(settings.clusters["new"].observability_links, Some(links));
        forget_cluster_settings(&mut settings, &ClusterId::from("new"));
        assert!(!settings.clusters.contains_key("new"));
    }

    #[test]
    fn nothing_usable_reads_as_none() {
        assert_eq!(ObservabilityLinks::read(&json!("text")), None);
        assert_eq!(ObservabilityLinks::read(&json!({"grafanaUrl": ""})), None);
        let long = format!("https://g.example/{}", "a".repeat(MAX_LINK_CHARS));
        assert_eq!(
            ObservabilityLinks::read(&json!({ "grafanaUrl": long })),
            None
        );
    }

    #[test]
    fn a_cluster_keeps_its_links_and_a_bad_value_does_not_fail_the_file() {
        let text = json!({
            "clusters": {
                "a": { "displayName": "A", "observabilityLinks": { "grafanaUrl": "https://g.example" } },
                "b": { "displayName": "B", "observabilityLinks": [1, 2] }
            }
        })
        .to_string();
        let settings: AppSettings = serde_json::from_str(&text).unwrap();
        let a = &settings.clusters["a"];
        assert_eq!(
            a.observability_links
                .as_ref()
                .and_then(|l| l.grafana_url.as_deref()),
            Some("https://g.example")
        );
        assert_eq!(settings.clusters["b"].display_name.as_deref(), Some("B"));
        assert_eq!(settings.clusters["b"].observability_links, None);
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            written["clusters"]["a"]["observabilityLinks"]["grafanaUrl"],
            "https://g.example"
        );
        assert!(written["clusters"]["b"].get("observabilityLinks").is_none());
    }
}
