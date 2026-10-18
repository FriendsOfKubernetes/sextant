//! PromQL of the usage history (right-sizing, #137); see `metrics::history` for the contract. The scope was validated
//! before it gets here; names are escaped anyway.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use futures::future::join_all;
use serde_json::Value;

use super::{
    CONTAINERS, Prometheus, encode, labels, literal, namespace_filter, number, regex_literal,
    results,
};
use crate::error::CoreResult;
use crate::metrics::history::{
    ContainerHistory, HistoryScope, HistoryWindow, MAX_HISTORY_CONTAINERS, UsageHistory,
};

/// Asked of Prometheus so it gives up before the client does (`QUERY_TIMEOUT`, 20 s).
const SERVER_TIMEOUT: &str = "18s";
/// `rate()` window and step of the CPU subqueries.
const CPU_STEP: &str = "5m";
/// Step of the memory peak subquery; each step takes the peak of its own raw samples, so no spike is missed.
const MEMORY_STEP: &str = "5m";
/// Resolution of "first seen".
const SEEN_STEP: &str = "10m";
const BY: &str = "namespace, pod, container";
/// The characters of generated name parts (`k8s.io/apimachinery/pkg/util/rand`): the pod-template-hash and the random
/// suffix of a pod name.
const SAFE: &str = "[bcdfghjklmnpqrstvwxz2456789]";

/// The selector of the scope's containers (without braces); `None` when it can match nothing.
pub(crate) fn scope_selector(scope: &HistoryScope) -> Option<String> {
    let base = format!(r#"{CONTAINERS},pod!="""#);
    match scope {
        HistoryScope::Namespaces { namespaces: None } => Some(base),
        HistoryScope::Namespaces {
            namespaces: Some(list),
        } if list.is_empty() => None,
        HistoryScope::Namespaces {
            namespaces: Some(list),
        } => Some(format!("{base}{}", namespace_filter(Some(list)))),
        HistoryScope::Pod { namespace, name } => Some(format!(
            r#"{base},namespace="{}",pod="{}""#,
            literal(namespace),
            literal(name)
        )),
        HistoryScope::Workload {
            namespace,
            kind,
            name,
        } => {
            let name = regex_literal(name);
            // Exactly the names the controllers give their pods (`=~` is anchored), so pods replaced inside the window
            // still count but pods of `web-api` or `web-agent` are not taken for pods of `web`: a Deployment's pods
            // are `<name>-<pod-template-hash>-<5>`, a StatefulSet's `<name>-<ordinal>`, a DaemonSet's `<name>-<5>`.
            // The hash and the suffix use Kubernetes' safe alphabet (no vowels, no 0, 1, 3), which also keeps out most
            // pods of a CronJob `<name>-<minutes>-<5>`.
            let pods = match kind.as_str() {
                "Deployment" => format!("{name}-{SAFE}{{6,10}}-{SAFE}{{5}}"),
                "StatefulSet" => format!("{name}-[0-9]+"),
                _ => format!("{name}-{SAFE}{{5}}"),
            };
            Some(format!(
                r#"{base},namespace="{}",pod=~"{}""#,
                literal(namespace),
                literal(&pods)
            ))
        }
    }
}

/// The queries, by the field they fill. The CPU rate subquery is the expensive part and is evaluated once (for
/// the 95th percentile); the peak of CPU is not asked.
pub(crate) fn history_queries(selector: &str, window: HistoryWindow) -> Vec<(Field, String)> {
    let w = window.promql();
    let cpu_rate = format!(
        "sum by ({BY}) (rate(container_cpu_usage_seconds_total{{{selector}}}[{CPU_STEP}]))"
    );
    vec![
        (
            Field::CpuP95,
            format!("quantile_over_time(0.95, ({cpu_rate})[{w}:{CPU_STEP}]) * 1000"),
        ),
        (
            Field::MemoryMax,
            format!(
                "max_over_time((max by ({BY}) (max_over_time(container_memory_working_set_bytes{{{selector}}}[{MEMORY_STEP}])))[{w}:{MEMORY_STEP}])"
            ),
        ),
        (
            Field::Throttled,
            format!(
                "sum by ({BY}) (increase(container_cpu_cfs_throttled_periods_total{{{selector}}}[{w}])) / sum by ({BY}) (increase(container_cpu_cfs_periods_total{{{selector}}}[{w}]))"
            ),
        ),
        (
            Field::FirstSeen,
            format!(
                "min_over_time((min by ({BY}) (timestamp(container_memory_working_set_bytes{{{selector}}})))[{w}:{SEEN_STEP}])"
            ),
        ),
        (
            // Plain instant query: only the containers that have a sample now (within the lookback).
            Field::LastSeen,
            format!("max by ({BY}) (timestamp(container_memory_working_set_bytes{{{selector}}}))"),
        ),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Field {
    CpuP95,
    MemoryMax,
    Throttled,
    FirstSeen,
    LastSeen,
}

type Samples = Vec<(BTreeMap<String, String>, f64)>;

impl Prometheus {
    /// Instant query at `time`, bounded by Prometheus' own `timeout` as well.
    async fn query_at(&self, promql: &str, time: i64) -> CoreResult<Samples> {
        let data: Value = self
            .get(&format!(
                "api/v1/query?query={}&time={time}&timeout={SERVER_TIMEOUT}",
                encode(promql)
            ))
            .await?;
        Ok(results(&data)
            .filter_map(|r| {
                let value = number(r.get("value")?.get(1)?)?;
                Some((labels(r), value))
            })
            .collect())
    }
}

/// Usage history of the scope's containers. Fails only when neither CPU nor memory could be read.
pub(crate) async fn usage_history(
    prometheus: &Prometheus,
    scope: &HistoryScope,
    window: HistoryWindow,
) -> CoreResult<UsageHistory> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let mut history = UsageHistory {
        window_secs: window.seconds(),
        evaluated_at: now,
        containers: Vec::new(),
        truncated: false,
        coverage_known: true,
        live_known: true,
    };
    let Some(selector) = scope_selector(scope) else {
        return Ok(history);
    };
    let queries = history_queries(&selector, window);
    let answers = join_all(queries.iter().map(|(_, q)| prometheus.query_at(q, now))).await;
    let mut first_error = None;
    let mut read = Vec::new();
    for ((field, _), answer) in queries.iter().zip(answers) {
        match answer {
            Ok(samples) => read.push((*field, samples)),
            Err(err) => {
                match field {
                    Field::FirstSeen => history.coverage_known = false,
                    Field::LastSeen => history.live_known = false,
                    _ => {}
                }
                first_error.get_or_insert(err);
            }
        }
    }
    let essential = read
        .iter()
        .any(|(f, _)| matches!(f, Field::CpuP95 | Field::MemoryMax));
    if !essential && let Some(err) = first_error {
        return Err(err);
    }
    let (containers, truncated) = assemble(read);
    history.containers = containers;
    history.truncated = truncated;
    Ok(history)
}

/// One entry per (namespace, pod, container), sorted; at most [`MAX_HISTORY_CONTAINERS`] (the alphabetically first),
/// and whether any were left out.
pub(crate) fn assemble(answers: Vec<(Field, Samples)>) -> (Vec<ContainerHistory>, bool) {
    let mut by_key: BTreeMap<(String, String, String), ContainerHistory> = BTreeMap::new();
    let mut truncated = false;
    for (field, samples) in answers {
        for (labels, value) in samples {
            let (Some(ns), Some(pod), Some(container)) = (
                labels.get("namespace"),
                labels.get("pod"),
                labels.get("container"),
            ) else {
                continue;
            };
            let key = (ns.clone(), pod.clone(), container.clone());
            if !by_key.contains_key(&key) && by_key.len() >= MAX_HISTORY_CONTAINERS {
                truncated = true;
                match by_key.last_key_value() {
                    Some((last, _)) if key < *last => {
                        by_key.pop_last();
                    }
                    _ => continue,
                }
            }
            let entry = by_key.entry(key).or_insert_with(|| ContainerHistory {
                namespace: ns.clone(),
                pod: pod.clone(),
                container: container.clone(),
                ..ContainerHistory::default()
            });
            match field {
                Field::CpuP95 => entry.cpu_p95_millicores = Some(value),
                Field::MemoryMax => entry.memory_max_bytes = Some(value),
                Field::Throttled => entry.throttled_ratio = Some(value.clamp(0.0, 1.0)),
                Field::FirstSeen => entry.first_seen = Some(value as i64),
                Field::LastSeen => entry.last_seen = Some(value as i64),
            }
        }
    }
    (by_key.into_values().collect(), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply};
    use crate::metrics::PrometheusTarget;

    fn decode(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                out.push(u8::from_str_radix(&text[i + 1..i + 3], 16).unwrap());
                i += 3;
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn selectors_quote_and_escape_every_name() {
        let pod = scope_selector(&HistoryScope::Pod {
            namespace: "shop".into(),
            name: "web-0".into(),
        })
        .unwrap();
        assert_eq!(
            pod,
            r#"container!="",container!="POD",pod!="",namespace="shop",pod="web-0""#
        );
        // Validation refuses such names first; the selector still escapes them.
        let odd = scope_selector(&HistoryScope::Pod {
            namespace: "a\"b".into(),
            name: "c\\d".into(),
        })
        .unwrap();
        assert!(odd.ends_with(r#"namespace="a\"b",pod="c\\d""#), "{odd}");
        let workload = scope_selector(&HistoryScope::Workload {
            namespace: "shop".into(),
            kind: "Deployment".into(),
            name: "api.v2".into(),
        })
        .unwrap();
        assert!(
            workload.ends_with(
                r#"pod=~"api\\.v2-[bcdfghjklmnpqrstvwxz2456789]{6,10}-[bcdfghjklmnpqrstvwxz2456789]{5}""#
            ),
            "{workload}"
        );
        let sts = scope_selector(&HistoryScope::Workload {
            namespace: "shop".into(),
            kind: "StatefulSet".into(),
            name: "db".into(),
        })
        .unwrap();
        assert!(sts.ends_with(r#"pod=~"db-[0-9]+""#), "{sts}");
        let ds = scope_selector(&HistoryScope::Workload {
            namespace: "shop".into(),
            kind: "DaemonSet".into(),
            name: "agent".into(),
        })
        .unwrap();
        assert!(
            ds.ends_with(r#"pod=~"agent-[bcdfghjklmnpqrstvwxz2456789]{5}""#),
            "{ds}"
        );
        let namespaces = scope_selector(&HistoryScope::Namespaces {
            namespaces: Some(vec!["a".into(), "b".into()]),
        })
        .unwrap();
        assert!(namespaces.ends_with(r#"namespace=~"a|b""#), "{namespaces}");
        assert_eq!(
            scope_selector(&HistoryScope::Namespaces {
                namespaces: Some(vec![])
            }),
            None
        );
    }

    #[test]
    fn the_queries_are_fixed_and_cover_the_window() {
        let queries = history_queries("SEL", HistoryWindow::Day);
        let text: Vec<&str> = queries.iter().map(|(_, q)| q.as_str()).collect();
        assert_eq!(
            text,
            [
                "quantile_over_time(0.95, (sum by (namespace, pod, container) (rate(container_cpu_usage_seconds_total{SEL}[5m])))[1d:5m]) * 1000",
                "max_over_time((max by (namespace, pod, container) (max_over_time(container_memory_working_set_bytes{SEL}[5m])))[1d:5m])",
                "sum by (namespace, pod, container) (increase(container_cpu_cfs_throttled_periods_total{SEL}[1d])) / sum by (namespace, pod, container) (increase(container_cpu_cfs_periods_total{SEL}[1d]))",
                "min_over_time((min by (namespace, pod, container) (timestamp(container_memory_working_set_bytes{SEL})))[1d:10m])",
                "max by (namespace, pod, container) (timestamp(container_memory_working_set_bytes{SEL}))",
            ]
        );
    }

    fn sample(ns: &str, pod: &str, container: &str, value: f64) -> (BTreeMap<String, String>, f64) {
        let labels = [("namespace", ns), ("pod", pod), ("container", container)]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        (labels, value)
    }

    #[test]
    fn answers_merge_by_container_and_the_list_is_capped() {
        let (list, truncated) = assemble(vec![
            (Field::CpuP95, vec![sample("a", "p", "c", 12.0)]),
            (
                Field::MemoryMax,
                vec![sample("a", "p", "c", 1024.0), sample("a", "p", "d", 5.0)],
            ),
            (Field::Throttled, vec![sample("a", "p", "c", 1.5)]),
            (
                Field::FirstSeen,
                vec![sample("a", "p", "c", 1_700_000_000.4)],
            ),
            (Field::LastSeen, vec![(BTreeMap::new(), 3.0)]),
        ]);
        assert!(!truncated);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].cpu_p95_millicores, Some(12.0));
        assert_eq!(list[0].memory_max_bytes, Some(1024.0));
        assert_eq!(list[0].throttled_ratio, Some(1.0));
        assert_eq!(list[0].first_seen, Some(1_700_000_000));
        assert_eq!(list[0].last_seen, None);
        assert_eq!(list[1].container, "d");
        assert_eq!(list[1].cpu_p95_millicores, None);

        let many: Samples = (0..MAX_HISTORY_CONTAINERS + 10)
            .rev()
            .map(|i| sample("ns", &format!("p{i:05}"), "c", 1.0))
            .collect();
        let (list, truncated) = assemble(vec![(Field::CpuP95, many)]);
        assert!(truncated);
        assert_eq!(list.len(), MAX_HISTORY_CONTAINERS);
        assert_eq!(list[0].pod, "p00000");
        assert_eq!(
            list.last().unwrap().pod,
            format!("p{:05}", MAX_HISTORY_CONTAINERS - 1)
        );
    }

    const ANSWER: &str = r#"{"status":"success","data":{"resultType":"vector","result":[{"metric":{"namespace":"shop","pod":"web-0","container":"app"},"value":[1,"42.5"]}]}}"#;

    #[tokio::test]
    async fn every_query_is_bounded_and_one_failing_metric_leaves_the_others() {
        let api = FakeApi::start(|req| {
            let query = decode(&req.query);
            if query.contains("cfs_throttled") {
                Reply::json(400, r#"{"status":"error","error":"no such metric"}"#)
            } else {
                Reply::json(200, ANSWER)
            }
        })
        .await;
        let client =
            kube::Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap()))
                .unwrap();
        let prometheus = Prometheus::new(
            &client,
            &PrometheusTarget::Url {
                url: api.url().to_owned(),
            },
        )
        .unwrap();
        let scope = HistoryScope::Pod {
            namespace: "shop".into(),
            name: "web-0".into(),
        };
        let history = usage_history(&prometheus, &scope, HistoryWindow::Week)
            .await
            .unwrap();
        assert_eq!(history.window_secs, 7 * 86_400);
        assert!(!history.truncated);
        assert_eq!(history.containers.len(), 1);
        let c = &history.containers[0];
        assert_eq!(c.cpu_p95_millicores, Some(42.5));
        assert_eq!(c.memory_max_bytes, Some(42.5));
        assert_eq!(c.throttled_ratio, None);
        assert!(history.coverage_known && history.live_known);
        let requests = api.requests();
        assert_eq!(requests.len(), 5);
        for r in &requests {
            assert_eq!(r.path, "/api/v1/query");
            assert!(r.query.contains("&timeout=18s"), "{}", r.query);
            assert!(
                r.query.contains(&format!("&time={}", history.evaluated_at)),
                "{}",
                r.query
            );
            assert!(decode(&r.query).contains(r#"namespace="shop",pod="web-0""#));
        }
    }

    #[tokio::test]
    async fn without_cpu_and_memory_the_history_fails() {
        let api =
            FakeApi::start(|_| Reply::json(400, r#"{"status":"error","error":"bad query"}"#)).await;
        let client =
            kube::Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap()))
                .unwrap();
        let prometheus = Prometheus::new(
            &client,
            &PrometheusTarget::Url {
                url: api.url().to_owned(),
            },
        )
        .unwrap();
        let scope = HistoryScope::Namespaces { namespaces: None };
        assert!(
            usage_history(&prometheus, &scope, HistoryWindow::Day)
                .await
                .is_err()
        );
        // An empty namespace list asks nothing.
        let none = HistoryScope::Namespaces {
            namespaces: Some(vec![]),
        };
        let empty = usage_history(&prometheus, &none, HistoryWindow::Day)
            .await
            .unwrap();
        assert!(empty.containers.is_empty());
        assert_eq!(api.requests().len(), 5);
    }

    fn url_prometheus(api: &FakeApi) -> Prometheus {
        let client =
            kube::Client::try_from(kube::Config::new("http://127.0.0.1:1".parse().unwrap()))
                .unwrap();
        Prometheus::new(
            &client,
            &PrometheusTarget::Url {
                url: api.url().to_owned(),
            },
        )
        .unwrap()
    }

    #[tokio::test]
    async fn a_failed_first_seen_leaves_the_coverage_unknown_not_zero() {
        let api = FakeApi::start(|req| {
            if decode(&req.query).contains("min_over_time((min by") {
                Reply::json(400, r#"{"status":"error","error":"query too heavy"}"#)
            } else {
                Reply::json(200, ANSWER)
            }
        })
        .await;
        let scope = HistoryScope::Pod {
            namespace: "shop".into(),
            name: "web-0".into(),
        };
        let history = usage_history(&url_prometheus(&api), &scope, HistoryWindow::Week)
            .await
            .unwrap();
        assert!(!history.coverage_known);
        assert!(history.live_known);
        let c = &history.containers[0];
        assert_eq!(c.first_seen, None);
        assert_eq!(c.cpu_p95_millicores, Some(42.5));
        assert_eq!(c.last_seen, Some(42));

        // And a failed "now" query says so too.
        let api = FakeApi::start(|req| {
            let query = decode(&req.query);
            if query.starts_with("query=max by") {
                Reply::json(400, r#"{"status":"error","error":"x"}"#)
            } else {
                Reply::json(200, ANSWER)
            }
        })
        .await;
        let history = usage_history(&url_prometheus(&api), &scope, HistoryWindow::Day)
            .await
            .unwrap();
        assert!(history.coverage_known);
        assert!(!history.live_known);
    }
}
