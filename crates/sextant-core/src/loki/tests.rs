use std::sync::{Arc, Mutex};

use k8s_openapi::api::core::v1::Service;
use serde_json::json;

use super::client::{parse_streams, parse_strings, query_range_api};
use super::logql::{PodMatch, stream_selector};
use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const EMPTY_LIST: &str = r#"{"kind":"ServiceList","apiVersion":"v1","metadata":{},"items":[]}"#;
const QUERY_RANGE: &str = include_str!("testdata/query_range.json");
const LABELS_K8S: &str = include_str!("testdata/labels_kubernetes.json");
const LABELS_OTEL: &str = include_str!("testdata/labels_otel.json");
const LABEL_VALUES: &str = include_str!("testdata/label_values.json");
const BUILDINFO: &str = include_str!("testdata/buildinfo.json");

fn service(namespace: &str, name: &str, ports: &[u16]) -> Service {
    let ports: Vec<_> = ports.iter().map(|p| json!({ "port": p })).collect();
    serde_json::from_value(json!({
        "metadata": { "name": name, "namespace": namespace },
        "spec": { "ports": ports },
    }))
    .unwrap()
}

fn list(services: &[Service]) -> String {
    json!({ "kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": services })
        .to_string()
}

fn source(namespace: &str, service: &str, port: u16) -> LokiSource {
    LokiSource {
        namespace: namespace.into(),
        service: service.into(),
        port,
        path_prefix: String::new(),
    }
}

#[test]
fn the_charts_services_are_known_by_name_and_port_and_ranked() {
    let services = [
        service("monitoring", "loki", &[3100, 9095]),
        service("loki", "loki-read", &[3100, 9095]),
        service("loki", "loki-headless", &[3100]),
        service("loki", "loki-memberlist", &[7946]),
        service("loki", "loki-canary", &[3500]),
        service("loki", "loki-chunks-cache", &[11211]),
        service("loki", "loki-gateway", &[80]),
        service("loki", "loki-query-frontend-headless", &[3100]),
        service("logging", "logs-loki-distributed-gateway", &[80]),
        service("observability", "loki-stack", &[3100]),
        // A gateway without its port, and names that only look like Loki.
        service("loki", "other-loki-gateway", &[8080]),
        service("loki", "lokistack", &[3100]),
        service("loki", "promtail", &[3101]),
    ];
    assert_eq!(
        candidates(&services),
        vec![
            source("loki", "loki-gateway", 80),
            source("loki", "loki-read", 3100),
            source("logging", "logs-loki-distributed-gateway", 80),
            source("monitoring", "loki", 3100),
            source("observability", "loki-stack", 3100),
        ]
    );
}

#[test]
fn stream_selectors_are_built_from_the_scheme_and_escaped() {
    let selector = stream_selector(
        LokiLabelScheme::Kubernetes,
        "shop",
        &PodMatch::Exact("web-1"),
        Some("app"),
    );
    assert_eq!(
        selector,
        r#"{namespace="shop", pod="web-1", container="app"}"#
    );
    let selector = stream_selector(
        LokiLabelScheme::OpenTelemetry,
        "shop",
        &PodMatch::Pattern(pod_name_pattern("StatefulSet", "db.v2")),
        None,
    );
    assert_eq!(
        selector,
        r#"{k8s_namespace_name="shop", k8s_pod_name=~"db\\.v2-[0-9]+"}"#
    );
}

#[test]
fn pod_name_patterns_follow_the_controllers_names() {
    let safe = "[bcdfghjklmnpqrstvwxz2456789]";
    assert_eq!(
        pod_name_pattern("Deployment", "web"),
        format!("web-{safe}{{6,10}}-{safe}{{5}}")
    );
    assert_eq!(
        pod_name_pattern("DaemonSet", "agent"),
        format!("agent-{safe}{{5}}")
    );
    assert_eq!(
        pod_name_pattern("Job", "migrate"),
        format!("migrate-{safe}{{5}}")
    );
    assert_eq!(
        pod_name_pattern("CronJob", "backup"),
        format!("backup-[0-9]+-{safe}{{5}}")
    );
}

#[test]
fn the_label_scheme_is_picked_from_the_label_names() {
    let k8s = parse_strings(LABELS_K8S.as_bytes()).unwrap();
    assert_eq!(
        LokiLabelScheme::detect(&k8s),
        Some((LokiLabelScheme::Kubernetes, true))
    );
    let otel = parse_strings(LABELS_OTEL.as_bytes()).unwrap();
    assert_eq!(
        LokiLabelScheme::detect(&otel),
        Some((LokiLabelScheme::OpenTelemetry, true))
    );
    let no_container: Vec<String> = vec!["namespace".into(), "pod".into()];
    assert_eq!(
        LokiLabelScheme::detect(&no_container),
        Some((LokiLabelScheme::Kubernetes, false))
    );
    assert_eq!(
        LokiLabelScheme::detect(&["job".into(), "filename".into()]),
        None
    );
}

const NOW: i64 = 1_700_000_000_000;
const HOUR: i64 = 3_600_000;

fn logs_query(range: LokiRange) -> LokiLogsQuery {
    LokiLogsQuery {
        namespace: "shop".into(),
        pod: "web-7c9f8d6b5d-x2x4q".into(),
        container: Some("app".into()),
        range,
        direction: LokiDirection::Backward,
        limit: 1000,
    }
}

fn last(hours: i64) -> LokiRange {
    LokiRange {
        start_ms: NOW - hours * HOUR,
        end_ms: NOW,
    }
}

#[test]
fn reads_are_checked_before_anything_is_sent() {
    assert!(validate_logs_query(&logs_query(last(24)), NOW).is_ok());
    let bad = |q: LokiLogsQuery| validate_logs_query(&q, NOW).unwrap_err().code;
    assert_eq!(bad(logs_query(last(25))), ErrorCode::Invalid);
    let inverted = LokiRange {
        start_ms: NOW,
        end_ms: NOW - HOUR,
    };
    assert_eq!(bad(logs_query(inverted)), ErrorCode::Invalid);
    let future = LokiRange {
        start_ms: NOW,
        end_ms: NOW + HOUR,
    };
    assert_eq!(bad(logs_query(future)), ErrorCode::Invalid);
    let mut q = logs_query(last(1));
    q.namespace = "Shop".into();
    assert_eq!(bad(q), ErrorCode::Invalid);
    let mut q = logs_query(last(1));
    q.pod = "web\"} or {pod=~\".+".into();
    assert_eq!(bad(q), ErrorCode::Invalid);
    let mut q = logs_query(last(1));
    q.container = Some("a.b".into());
    assert_eq!(bad(q), ErrorCode::Invalid);
    for limit in [0, MAX_LINES + 1] {
        let mut q = logs_query(last(1));
        q.limit = limit;
        assert_eq!(bad(q), ErrorCode::Invalid);
    }
    let names = |kind: &str, name: &str| {
        validate_names_query(&LokiNamesQuery::WorkloadPods {
            namespace: "shop".into(),
            kind: kind.into(),
            name: name.into(),
        })
    };
    assert!(names("Deployment", "web").is_ok());
    assert!(names("Service", "web").is_err());
    assert!(names("Deployment", "web|.*").is_err());
}

#[test]
fn settings_and_tenants_are_checked() {
    let manual = |namespace: &str, service: &str, port: u16, prefix: &str| LokiSettings {
        mode: LokiMode::Manual {
            namespace: namespace.into(),
            service: service.into(),
            port,
            path_prefix: prefix.into(),
        },
        tenant: None,
    };
    assert!(validate_settings(&manual("loki", "loki-gateway", 80, "")).is_ok());
    assert!(validate_settings(&manual("loki", "loki-gateway", 80, "/loki-proxy/")).is_ok());
    assert!(validate_settings(&manual("loki", "loki-gateway", 0, "")).is_err());
    assert!(validate_settings(&manual("loki", "loki/../x", 80, "")).is_err());
    assert!(validate_settings(&manual("loki", "loki", 80, "/a/../b")).is_err());
    assert!(validate_settings(&manual("loki", "loki", 80, "/a?b=c")).is_err());
    assert!(validate_settings(&manual("loki", "loki", 80, "no-slash")).is_err());
    for good in ["team-a", "tenant_1", "a|b", "fake"] {
        assert!(validate_tenant(good).is_ok(), "{good}");
    }
    for bad in ["", "..", "a b", "a\r\nX-Other: 1", "a||b", &"x".repeat(151)] {
        assert!(validate_tenant(bad).is_err(), "{bad:?}");
    }
    // Stored settings are read leniently.
    assert_eq!(
        LokiSettings::lenient(Some(json!({ "mode": { "mode": "bogus" } }))),
        LokiSettings::default()
    );
    assert_eq!(
        LokiSettings::lenient(Some(json!({ "mode": { "mode": "off" }, "tenant": "t" }))),
        LokiSettings {
            mode: LokiMode::Off,
            tenant: Some("t".into())
        }
    );
}

#[test]
fn cluster_settings_keep_the_loki_settings_and_ignore_an_unreadable_value() {
    let read: crate::settings::ClusterSettings =
        serde_json::from_value(json!({ "loki": { "mode": { "mode": "off" } } })).unwrap();
    assert_eq!(read.loki.unwrap().mode, LokiMode::Off);
    let read: crate::settings::ClusterSettings =
        serde_json::from_value(json!({ "loki": 42, "displayName": "kept" })).unwrap();
    assert_eq!(read.loki, Some(LokiSettings::default()));
    assert_eq!(read.display_name.as_deref(), Some("kept"));
    let none: crate::settings::ClusterSettings = serde_json::from_value(json!({})).unwrap();
    assert_eq!(none.loki, None);
    assert!(serde_json::to_value(&none).unwrap().get("loki").is_none());
}

#[test]
fn query_range_answers_are_read_from_every_stream_oldest_first() {
    let entries = parse_streams(QUERY_RANGE.as_bytes()).unwrap();
    assert_eq!(
        entries,
        vec![
            (
                1569266492548155000,
                "\u{1b}[32mINFO\u{1b}[0m started".to_owned()
            ),
            (1569266495000000000, "warning: cache cold".to_owned()),
            (1569266497240578000, "GET /cart 200".to_owned()),
        ]
    );
    let matrix = r#"{"status":"success","data":{"resultType":"matrix","result":[]}}"#;
    assert_eq!(
        parse_streams(matrix.as_bytes()).unwrap_err().code,
        ErrorCode::Invalid
    );
    assert!(parse_streams(b"<html>nginx</html>").is_err());
    assert!(parse_streams(br#"{"status":"error","error":"x"}"#).is_err());
    assert_eq!(
        parse_strings(br#"{"status":"success"}"#).unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn a_query_range_request_carries_only_what_sextant_built() {
    let selector = r#"{namespace="shop", pod="web-1"}"#;
    assert_eq!(
        query_range_api(selector, 10, 20, 1000, "backward"),
        "/loki/api/v1/query_range?query=%7Bnamespace%3D%22shop%22%2C%20pod%3D%22web-1%22%7D\
         &start=10&end=20&limit=1000&direction=backward"
    );
}

#[test]
fn long_lines_are_sent_in_pieces_cut_at_character_boundaries() {
    let line = format!("{}é{}", "a".repeat(MAX_LINE_BYTES - 1), "b".repeat(10));
    let parts = pieces(7, line.clone());
    assert_eq!(parts.len(), 2);
    assert!(parts[0].cut && !parts[1].cut);
    assert_eq!(parts[0].line.len(), MAX_LINE_BYTES - 1);
    assert_eq!(format!("{}{}", parts[0].line, parts[1].line), line);
    assert!(parts.iter().all(|p| p.ts == "7"));
}

/// Loki's paging rules over fixed lines: `start` included, `end` excluded, the newest (backward) or oldest `limit`
/// lines, oldest first; every call recorded.
struct FakeLoki {
    lines: Vec<(i64, String)>,
    calls: Arc<Mutex<Vec<(i64, i64, u32)>>>,
}

impl Source for FakeLoki {
    fn query<'a>(
        &'a self,
        _selector: &'a str,
        start_ns: i64,
        end_ns: i64,
        limit: u32,
        direction: LokiDirection,
    ) -> futures::future::BoxFuture<'a, CoreResult<Vec<(i64, String)>>> {
        self.calls.lock().unwrap().push((start_ns, end_ns, limit));
        let mut inside: Vec<(i64, String)> = self
            .lines
            .iter()
            .filter(|(ts, _)| *ts >= start_ns && *ts < end_ns)
            .cloned()
            .collect();
        // As the client reads an answer: oldest first, lines of one timestamp in the answer's order.
        inside.sort_by_key(|(ts, _)| *ts);
        let limit = limit as usize;
        match direction {
            LokiDirection::Backward => {
                let extra = inside.len().saturating_sub(limit);
                inside.drain(..extra);
            }
            LokiDirection::Forward => inside.truncate(limit),
        }
        Box::pin(async move { Ok(inside) })
    }
}

/// `n` lines a millisecond apart from 1 s after the epoch, every third pair sharing a timestamp.
fn fake_lines(n: usize) -> Vec<(i64, String)> {
    (0..n)
        .map(|i| {
            let tick = i64::try_from(i - i % 3 / 2).unwrap();
            (ns(1000 + tick), format!("line {i}"))
        })
        .collect()
}

async fn read_all(
    lines: Vec<(i64, String)>,
    direction: LokiDirection,
    limit: u32,
) -> (Vec<String>, LokiUpdate, usize) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let source = FakeLoki {
        lines,
        calls: calls.clone(),
    };
    let mut query = logs_query(LokiRange {
        start_ms: 1000,
        end_ms: 1000 + MAX_RANGE_MS,
    });
    query.direction = direction;
    query.limit = limit;
    let mut pager = Pager::new(Box::new(source), "{}".into(), &query);
    let mut pages: Vec<Vec<String>> = Vec::new();
    let end = loop {
        match pager.next_page().await {
            Step::Page(entries) => {
                let ts: Vec<i64> = entries.iter().map(|e| e.ts.parse().unwrap()).collect();
                assert!(
                    ts.windows(2).all(|w| w[0] <= w[1]),
                    "a page is oldest first"
                );
                pages.push(entries.into_iter().map(|e| e.line).collect());
            }
            Step::End(truncated) => {
                break LokiUpdate::Ended {
                    lines: pager.sent,
                    truncated,
                };
            }
            Step::Fail(err) => break LokiUpdate::Error(err),
        }
    };
    if direction == LokiDirection::Backward {
        pages.reverse();
    }
    let calls = calls.lock().unwrap().len();
    (pages.into_iter().flatten().collect(), end, calls)
}

#[tokio::test]
async fn backward_pages_lose_and_repeat_nothing_across_shared_timestamps() {
    let lines = fake_lines(2500);
    let expected: Vec<String> = lines.iter().map(|(_, l)| l.clone()).collect();
    let (got, end, calls) = read_all(lines, LokiDirection::Backward, MAX_LINES).await;
    assert_eq!(got.len(), expected.len());
    let mut sorted_got = got.clone();
    sorted_got.sort();
    let mut sorted_expected = expected.clone();
    sorted_expected.sort();
    assert_eq!(sorted_got, sorted_expected, "every line once");
    assert_eq!(
        end,
        LokiUpdate::Ended {
            lines: 2500,
            truncated: false
        }
    );
    assert!(calls <= 4, "{calls} requests");
}

#[tokio::test]
async fn forward_pages_lose_and_repeat_nothing_and_the_limit_truncates() {
    let lines = fake_lines(2500);
    let expected: Vec<String> = lines.iter().take(1500).map(|(_, l)| l.clone()).collect();
    let (got, end, _) = read_all(lines.clone(), LokiDirection::Forward, 1500).await;
    assert_eq!(got, expected);
    assert_eq!(
        end,
        LokiUpdate::Ended {
            lines: 1500,
            truncated: true
        }
    );
    // Backward with a limit keeps the newest lines.
    let (got, end, _) = read_all(lines.clone(), LokiDirection::Backward, 1200).await;
    let newest: Vec<String> = lines[1300..].iter().map(|(_, l)| l.clone()).collect();
    let mut sorted_got = got;
    sorted_got.sort();
    let mut sorted_newest = newest;
    sorted_newest.sort();
    assert_eq!(sorted_got, sorted_newest);
    assert_eq!(
        end,
        LokiUpdate::Ended {
            lines: 1200,
            truncated: true
        }
    );
}

#[tokio::test]
async fn more_lines_on_one_timestamp_than_a_page_holds_never_stall_the_read() {
    let mut lines: Vec<(i64, String)> =
        (0..1500).map(|i| (ns(2000), format!("same {i}"))).collect();
    lines.push((ns(1500), "older".into()));
    let (got, end, calls) = read_all(lines, LokiDirection::Backward, MAX_LINES).await;
    assert!(got.contains(&"older".to_owned()));
    assert!(matches!(end, LokiUpdate::Ended { .. }), "{end:?}");
    assert!(calls <= MAX_REQUESTS as usize);
}

const GATEWAY: &str = "/api/v1/namespaces/loki/services/loki-gateway:80/proxy";

/// A cluster with the grafana/loki chart's gateway in `loki`; `labels` is the answer of the labels API.
async fn cluster_with_loki(
    labels: &'static str,
) -> (FakeApi, tempfile::TempDir, ClusterManager, ClusterId) {
    let in_loki = list(&[
        service("loki", "loki-gateway", &[80]),
        service("loki", "loki-read", &[3100]),
    ]);
    let api = FakeApi::start(move |req: &Request| {
        let path = req.path.as_str();
        match path {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/loki/services" => Reply::json(200, in_loki.clone()),
            p if p.ends_with("/services") => Reply::json(200, EMPTY_LIST),
            p if p == format!("{GATEWAY}/loki/api/v1/status/buildinfo") => {
                Reply::json(200, BUILDINFO)
            }
            p if p == format!("{GATEWAY}/loki/api/v1/labels") => Reply::json(200, labels),
            p if p.starts_with(&format!("{GATEWAY}/loki/api/v1/label/")) => {
                Reply::json(200, LABEL_VALUES)
            }
            p if p == format!("{GATEWAY}/loki/api/v1/query_range") => Reply::json(200, QUERY_RANGE),
            _ => Reply::not_found(),
        }
    })
    .await;
    let (tmp, mgr, id) = connected_to(api.url()).await;
    (api, tmp, mgr, id)
}

fn decoded(query: &str) -> String {
    let bytes = query.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            out.push(u8::from_str_radix(&query[i + 1..i + 3], 16).unwrap());
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

#[tokio::test]
async fn loki_is_found_through_the_service_proxy_with_its_label_scheme() {
    let (api, _tmp, mgr, id) = cluster_with_loki(LABELS_OTEL).await;
    let settings = LokiSettings {
        mode: LokiMode::Auto,
        tenant: Some("team-a".into()),
    };
    let status = status(&mgr, &id, &settings).await.unwrap();
    assert_eq!(status.source, Some(source("loki", "loki-gateway", 80)));
    assert_eq!(status.scheme, Some(LokiLabelScheme::OpenTelemetry));
    assert!(status.container_label && !status.off && !status.manual);
    let proxied: Vec<Request> = api
        .requests()
        .into_iter()
        .filter(|r| r.path.contains("/proxy"))
        .collect();
    assert!(
        proxied
            .iter()
            .all(|r| r.header("X-Scope-OrgID") == "team-a")
    );
    assert!(proxied.iter().all(|r| r.method == "GET"));
    // The result is reused for the same connection and settings.
    let before = api.requests().len();
    status_again(&mgr, &id, &settings).await;
    assert_eq!(api.requests().len(), before);
}

async fn status_again(mgr: &ClusterManager, id: &ClusterId, settings: &LokiSettings) {
    status(mgr, id, settings).await.unwrap();
}

#[tokio::test]
async fn pod_names_come_from_the_label_values_with_an_anchored_pattern() {
    let (api, _tmp, mgr, id) = cluster_with_loki(LABELS_K8S).await;
    let query = LokiNamesQuery::WorkloadPods {
        namespace: "shop".into(),
        kind: "Deployment".into(),
        name: "web".into(),
    };
    let now = now_ms();
    let range = LokiRange {
        start_ms: now - HOUR,
        end_ms: now,
    };
    let names = names(&mgr, &id, &LokiSettings::default(), &query, &range)
        .await
        .unwrap();
    assert_eq!(names.names.len(), 3);
    assert_eq!(names.names[0], "web-5f6d7c8b9d-b2c4d");
    assert!(!names.truncated);
    let sent = api
        .requests()
        .into_iter()
        .find(|r| r.path.ends_with("/label/pod/values"))
        .expect("a label values request");
    let query = decoded(&sent.query);
    assert!(
        query.starts_with(&format!(
            "query={{namespace=\"shop\", pod=~\"{}\"}}&start=",
            pod_name_pattern("Deployment", "web").replace('\\', "\\\\")
        )),
        "{query}"
    );
}

#[tokio::test]
async fn a_read_goes_through_the_proxy_and_ends() {
    use futures::StreamExt;
    let (api, _tmp, mgr, id) = cluster_with_loki(LABELS_K8S).await;
    let now = now_ms();
    let query = logs_query(LokiRange {
        start_ms: now - HOUR,
        end_ms: now,
    });
    let updates: Vec<LokiUpdate> = read_logs(&mgr, &id, &LokiSettings::default(), query)
        .await
        .unwrap()
        .collect()
        .await;
    let LokiUpdate::Entries { entries } = &updates[0] else {
        panic!("{updates:?}");
    };
    assert_eq!(entries.len(), 3);
    assert_eq!(entries[2].line, "GET /cart 200");
    assert_eq!(
        updates[1],
        LokiUpdate::Ended {
            lines: 3,
            truncated: false
        }
    );
    let sent = api
        .requests()
        .into_iter()
        .find(|r| r.path.ends_with("/query_range"))
        .unwrap();
    let query = decoded(&sent.query);
    assert!(
        query.starts_with(
            r#"query={namespace="shop", pod="web-7c9f8d6b5d-x2x4q", container="app"}&start="#
        ),
        "{query}"
    );
    assert!(query.ends_with("&limit=1000&direction=backward"), "{query}");
}

#[tokio::test]
async fn an_invalid_read_sends_nothing_and_no_loki_is_not_found() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        p if p.ends_with("/services") => Reply::json(200, EMPTY_LIST),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let before = api.requests().len();
    let mut query = logs_query(last(1));
    query.pod = "x\"}".into();
    let err = read_logs(&mgr, &id, &LokiSettings::default(), query)
        .await
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert_eq!(api.requests().len(), before);

    let status = status(&mgr, &id, &LokiSettings::default()).await.unwrap();
    assert_eq!(status.source, None);
    let now = now_ms();
    let query = logs_query(LokiRange {
        start_ms: now - HOUR,
        end_ms: now,
    });
    let err = read_logs(&mgr, &id, &LokiSettings::default(), query)
        .await
        .err()
        .unwrap();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(api.requests().iter().all(|r| !r.path.contains("/proxy")));
    let off = LokiSettings {
        mode: LokiMode::Off,
        tenant: None,
    };
    assert!(status_of(&mgr, &id, &off).await.off);
}

async fn status_of(mgr: &ClusterManager, id: &ClusterId, settings: &LokiSettings) -> LokiStatus {
    status(mgr, id, settings).await.unwrap()
}

#[tokio::test]
async fn a_loki_that_wants_a_tenant_says_so() {
    let in_loki = list(&[service("loki", "loki", &[3100])]);
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/loki/services" => Reply::json(200, in_loki.clone()),
        p if p.ends_with("/services") => Reply::json(200, EMPTY_LIST),
        p if p.ends_with("/status/buildinfo") => Reply::not_found(),
        p if p.ends_with("/proxy/ready") => Reply::json(200, "ready\n"),
        p if p.ends_with("/labels") => Reply::json(401, "no org id\n"),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let err = status(&mgr, &id, &LokiSettings::default())
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Unauthorized);
    assert!(err.message.contains("tenant"), "{}", err.message);
}
