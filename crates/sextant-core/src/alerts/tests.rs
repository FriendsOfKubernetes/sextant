//! Alerts (#264): reading the answers of Prometheus, vmalert and Alertmanager (fixtures shaped as their APIs document
//! them), cleaning texts, merging, the fixed requests, and detection and the report against the fake API server.

use std::collections::HashMap;

use super::read::{
    alertmanager_alerts, clean_text, clip, merge, prometheus_alerts, safe_uri, silences,
};
use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const PROMETHEUS: &str = include_str!("testdata/prometheus-alerts.json");
const VMALERT: &str = include_str!("testdata/vmalert-alerts.json");
const AM_ALERTS: &str = include_str!("testdata/alertmanager-alerts.json");
const AM_SILENCES: &str = include_str!("testdata/alertmanager-silences.json");

fn ok() -> http::StatusCode {
    http::StatusCode::OK
}

fn by_name<'a>(alerts: &'a [Alert], name: &str) -> &'a Alert {
    alerts
        .iter()
        .find(|a| a.name == name)
        .unwrap_or_else(|| panic!("{name}"))
}

#[test]
fn uris_lose_credentials_query_and_fragment_as_the_window_cleans_them() {
    let cases = [
        ("https://user:pw@host/a?b=c#d", "https://host/a", true),
        ("https://host/a", "https://host/a", false),
        ("s3://bucket/key?X-Amz-Signature=1", "s3://bucket/key", true),
        ("user:pass@host/path", "host/path", true),
        ("  ", "", false),
    ];
    for (input, text, hidden) in cases {
        match safe_uri(input) {
            Some((t, h)) => assert_eq!((t.as_str(), h), (text, hidden), "{input}"),
            None => assert_eq!(text, "", "{input}"),
        }
    }
    assert_eq!(
        clean_text("see https://a:b@x.io/p?q=1 and u:p@db:5432/x now"),
        "see https://x.io/p and db:5432/x now"
    );
    assert_eq!(clip("ééé", 4), "…");
    assert_eq!(clip("abcdef", 5), "ab…");
    assert_eq!(clip("abc", 5), "abc");
}

/// The cases `src/resources/uri.ts` passes too (`src/resources/uri.test.ts`).
const URI_CASES: &str = include_str!("../../../../src/resources/uri-cases.json");

#[test]
fn the_cleaners_pass_the_cases_shared_with_the_window() {
    let cases: serde_json::Value = serde_json::from_str(URI_CASES).unwrap();
    let mut failed = Vec::new();
    for case in cases["uri"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let want = case["text"]
            .as_str()
            .map(|t| (t.to_owned(), case["hidden"].as_bool().unwrap()));
        let got = safe_uri(input);
        if got != want {
            failed.push(format!("safe_uri({input:?}) = {got:?}, want {want:?}"));
        }
    }
    for case in cases["text"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let got = clean_text(input);
        if got != case["output"].as_str().unwrap() {
            failed.push(format!("clean_text({input:?}) = {got:?}"));
        }
    }
    assert!(failed.is_empty(), "{failed:#?}");
}

#[test]
fn prometheus_alerts_keep_firing_and_pending_with_clean_texts_and_http_links_only() {
    let alerts = prometheus_alerts(ok(), PROMETHEUS.as_bytes()).unwrap();
    // The inactive one and the element that is no alert are left out.
    assert_eq!(alerts.len(), 4, "{alerts:#?}");
    let crash = by_name(&alerts, "KubePodCrashLooping");
    assert_eq!(crash.state, AlertState::Firing);
    assert_eq!(crash.severity.as_deref(), Some("warning"));
    assert_eq!(crash.labels["pod"], "api-7d9c8b6f5d-x2x4q");
    assert_eq!(crash.origin, AlertOrigin::Prometheus);
    assert!(crash.id.starts_with('p'));
    let description = crash.description.as_deref().unwrap();
    assert!(
        description.contains("https://grafana.example.com/d/abc for details"),
        "{description}"
    );
    assert!(!description.contains("s3cret") && !description.contains("token"));
    assert_eq!(crash.links.len(), 1);
    assert_eq!(crash.links[0].key, "runbook_url");
    assert!(!crash.links[0].cleaned);

    let pending = by_name(&alerts, "KubeDeploymentReplicasMismatch");
    assert_eq!(pending.state, AlertState::Pending);
    // `javascript:` is no link; it stays a plain text annotation.
    assert_eq!(pending.links.len(), 1);
    assert_eq!(
        pending.annotations,
        vec![("dashboard".to_owned(), "javascript:alert(1)".to_owned())]
    );

    let node = by_name(&alerts, "KubeNodeNotReady");
    assert_eq!(
        node.summary.as_deref(),
        Some("worker-2 has been unready for more than 15 minutes.")
    );
    assert_eq!(node.links[0].url, "https://grafana.example.com/d/nodes");
    assert!(node.links[0].cleaned);
}

#[test]
fn vmalert_alerts_read_alike_and_a_zero_time_says_nothing() {
    let alerts = prometheus_alerts(ok(), VMALERT.as_bytes()).unwrap();
    assert_eq!(alerts.len(), 2);
    let disk = by_name(&alerts, "DiskRunningFull");
    assert_eq!(disk.labels["persistentvolumeclaim"], "data-pg-0");
    let named = by_name(&alerts, "NoAlertname");
    assert_eq!(named.active_at, None);
}

#[test]
fn error_answers_say_what_prometheus_said() {
    let refused = br#"{"status":"error","errorType":"bad_data","error":"no"}"#;
    let err = prometheus_alerts(http::StatusCode::BAD_REQUEST, refused).unwrap_err();
    assert!(err.message.contains("no"), "{err:?}");
    let err = prometheus_alerts(ok(), b"<html>").unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let err = prometheus_alerts(ok(), br#"{"status":"success","data":{"groups":[]}}"#).unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
}

#[test]
fn alertmanager_states_are_read_from_the_status() {
    let alerts = alertmanager_alerts(AM_ALERTS.as_bytes()).unwrap();
    assert_eq!(alerts.len(), 4);
    let state = |n: &str| by_name(&alerts, n).state;
    assert_eq!(state("KubePodCrashLooping"), AlertState::Firing);
    assert_eq!(state("TargetDown"), AlertState::Silenced);
    assert_eq!(state("CPUThrottlingHigh"), AlertState::Inhibited);
    assert_eq!(state("Watchdog"), AlertState::Firing);
    let target = by_name(&alerts, "TargetDown");
    assert_eq!(
        target.silenced_by,
        vec!["5f1c0a2e-0d7b-4e43-9a77-3e7e1a3b8c11".to_owned()]
    );
    assert_eq!(
        by_name(&alerts, "KubePodCrashLooping").id,
        "1a2b3c4d5e6f7081"
    );
    assert!(alertmanager_alerts(b"{}").is_err());
}

#[test]
fn silences_keep_active_and_pending_and_count_the_expired() {
    let (list, expired) = silences(AM_SILENCES.as_bytes()).unwrap();
    assert_eq!(expired, 1);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].state, SilenceState::Active);
    assert_eq!(list[0].matchers[1].value, "shop|cart");
    assert!(list[0].matchers[1].is_regex);
    let comment = list[0].comment.as_deref().unwrap();
    assert!(
        !comment.contains("hunter2") && !comment.contains("ticket"),
        "{comment}"
    );
    // No `isEqual` (Alertmanager before 0.22) is an equality.
    assert!(list[1].matchers[0].is_equal);
}

#[test]
fn prometheus_firing_alerts_that_alertmanager_holds_are_shown_once() {
    let held = alertmanager_alerts(AM_ALERTS.as_bytes()).unwrap();
    let prometheus = prometheus_alerts(ok(), PROMETHEUS.as_bytes()).unwrap();
    let merged = merge(Some(held), prometheus.clone());
    let names: Vec<(&str, AlertState, AlertOrigin)> = merged
        .iter()
        .map(|a| (a.name.as_str(), a.state, a.origin))
        .collect();
    // KubePodCrashLooping: Alertmanager's copy (with the external label) covers Prometheus'. Critical first, `none` last.
    assert_eq!(
        names,
        vec![
            (
                "KubeNodeNotReady",
                AlertState::Firing,
                AlertOrigin::Prometheus
            ),
            (
                "KubeDeploymentReplicasMismatch",
                AlertState::Pending,
                AlertOrigin::Prometheus
            ),
            (
                "KubePodCrashLooping",
                AlertState::Firing,
                AlertOrigin::Alertmanager
            ),
            (
                "TargetDown",
                AlertState::Silenced,
                AlertOrigin::Alertmanager
            ),
            (
                "CPUThrottlingHigh",
                AlertState::Inhibited,
                AlertOrigin::Alertmanager
            ),
            ("Watchdog", AlertState::Firing, AlertOrigin::Alertmanager),
            ("my-alert", AlertState::Firing, AlertOrigin::Prometheus),
        ]
    );
    // Without an Alertmanager every alert of Prometheus is shown.
    assert_eq!(merge(None, prometheus).len(), 4);
}

#[test]
fn known_alertmanager_names_and_manual_addresses() {
    assert_eq!(known("alertmanager-operated").map(|k| k.0), Some(0));
    assert_eq!(
        known("kps-kube-prometheus-stack-alertmanager").map(|k| k.0),
        Some(2)
    );
    assert_eq!(known("vmalertmanager-vmks").map(|k| k.0), Some(10));
    assert_eq!(known("alertmanager-headless"), None);
    let target = |ns: &str, svc: &str, port: u16, prefix: &str| AlertmanagerTarget {
        namespace: ns.into(),
        service: svc.into(),
        port,
        path_prefix: prefix.into(),
    };
    assert!(validate_target(&target("monitoring", "alertmanager-operated", 9093, "")).is_ok());
    assert!(validate_target(&target("monitoring", "am", 9093, "/alertmanager/")).is_ok());
    for bad in [
        target("Mon", "am", 9093, ""),
        target("monitoring", "1am", 9093, ""),
        target("monitoring", "am", 0, ""),
        target("monitoring", "am", 9093, "/../api"),
        target("monitoring", "am", 9093, "/a?b"),
        target("monitoring", "am", 9093, "a"),
        target("monitoring", "am", 9093, "/%2e"),
    ] {
        assert!(validate_target(&bad).is_err(), "{bad:?}");
    }
    let t = target("monitoring", "am", 9093, "/alertmanager/");
    assert_eq!(
        alertmanager::request_uri(&t, alertmanager::ALERTS_QUERY),
        "/api/v1/namespaces/monitoring/services/am:9093/proxy/alertmanager/api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true"
    );
}

fn service_list(names: &[(&str, u16)]) -> String {
    let items: Vec<serde_json::Value> = names
        .iter()
        .map(|(name, port)| serde_json::json!({"metadata": {"name": name}, "spec": {"ports": [{"port": port}]}}))
        .collect();
    serde_json::json!({"kind": "ServiceList", "apiVersion": "v1", "metadata": {}, "items": items})
        .to_string()
}

/// A cluster with kube-prometheus-stack's Alertmanager in `monitoring` and the alert APIs answering the fixtures;
/// `/vm` stands for a VictoriaMetrics without `-vmalert.proxyURL`.
async fn fake_cluster() -> FakeApi {
    let lists: HashMap<&str, String> = HashMap::from([(
        "/api/v1/namespaces/monitoring/services",
        service_list(&[
            ("alertmanager-operated", 9093),
            ("prometheus-operated", 9090),
        ]),
    )]);
    FakeApi::start(move |req: &Request| {
        let am = "/api/v1/namespaces/monitoring/services/alertmanager-operated:9093/proxy";
        let prom = "/api/v1/namespaces/monitoring/services/prometheus-operated:9090/proxy";
        let vm = "/api/v1/namespaces/vm/services/vmsingle-vm:8428/proxy";
        let path = req.path.as_str();
        if path == "/api" {
            Reply::json(200, r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#)
        } else if let Some(list) = lists.get(path) {
            Reply::json(200, list.clone())
        } else if path.ends_with("/services") {
            Reply::json(200, service_list(&[]))
        } else if path == format!("{am}/api/v2/alerts") && req.query.contains("active=false") {
            Reply::json(200, "[]")
        } else if path == format!("{am}/api/v2/alerts") {
            Reply::json(200, AM_ALERTS)
        } else if path == format!("{am}/api/v2/silences") {
            Reply::json(200, AM_SILENCES)
        } else if path == format!("{prom}/api/v1/alerts") {
            Reply::json(200, PROMETHEUS)
        } else if path == format!("{vm}/vmalert/api/v1/alerts") {
            Reply::json(400, r#"{"status":"error","msg":"the '-vmalert.proxyURL' command-line must be configured"}"#)
        } else {
            Reply::not_found()
        }
    })
    .await
}

fn prometheus_at(namespace: &str, service: &str, port: u16) -> PrometheusMode {
    PrometheusMode::Manual {
        target: PrometheusTarget::Service {
            namespace: namespace.into(),
            service: service.into(),
            port,
            path_prefix: String::new(),
        },
    }
}

#[tokio::test]
async fn the_report_merges_both_sources_found_through_the_service_proxy() {
    let api = fake_cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let prometheus = prometheus_at("monitoring", "prometheus-operated", 9090);
    let got = report(&mgr, &id, &prometheus, &AlertmanagerMode::Auto)
        .await
        .unwrap();
    assert_eq!(got.alertmanager.status, AlertSourceStatus::Ok);
    assert_eq!(
        got.alertmanager.target.as_deref(),
        Some("monitoring/alertmanager-operated:9093")
    );
    assert_eq!(got.prometheus.status, AlertSourceStatus::Ok);
    assert_eq!(got.prometheus.kind, Some(MetricsSourceKind::Prometheus));
    assert_eq!(got.alerts.len(), 7);
    assert_eq!((got.silences.len(), got.expired_silences), (2, 1));
    assert!(!got.truncated);
    // Detection is kept: a second report lists no Service again.
    let lists = api.count("/api/v1/namespaces/monitoring/services");
    report(&mgr, &id, &prometheus, &AlertmanagerMode::Auto)
        .await
        .unwrap();
    assert_eq!(api.count("/api/v1/namespaces/monitoring/services"), lists);
    // Every request was a GET of a fixed path.
    assert!(api.requests().iter().all(|r| r.method == "GET"));
}

#[tokio::test]
async fn off_not_found_not_available_and_a_bad_manual_address() {
    let api = fake_cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let got = report(&mgr, &id, &PrometheusMode::Off, &AlertmanagerMode::Off)
        .await
        .unwrap();
    assert_eq!(got.prometheus.status, AlertSourceStatus::Off);
    assert_eq!(got.alertmanager.status, AlertSourceStatus::Off);
    assert!(got.alerts.is_empty());

    let vm = prometheus_at("vm", "vmsingle-vm", 8428);
    let bad = AlertmanagerMode::Manual {
        target: AlertmanagerTarget {
            namespace: "monitoring".into(),
            service: "am".into(),
            port: 9093,
            path_prefix: "/../x".into(),
        },
    };
    let got = report(&mgr, &id, &vm, &bad).await.unwrap();
    assert_eq!(got.prometheus.status, AlertSourceStatus::NotAvailable);
    assert_eq!(
        got.prometheus.kind,
        Some(MetricsSourceKind::VictoriaMetricsSingle)
    );
    assert_eq!(got.alertmanager.status, AlertSourceStatus::Failed);
    assert_eq!(
        got.alertmanager.error.as_ref().map(|e| e.code),
        Some(ErrorCode::Invalid)
    );
    assert!(!api.requests().iter().any(|r| r.path.contains("/am:9093/")));
}

#[test]
fn the_cluster_setting_reads_leniently_and_round_trips() {
    use crate::settings::ClusterSettings;
    let manual = serde_json::json!({"alertmanager": {"mode": "manual", "target": {
        "namespace": "obs", "service": "am", "port": 9093, "pathPrefix": "/am"}}});
    let read: ClusterSettings = serde_json::from_value(manual.clone()).unwrap();
    assert_eq!(
        read.alertmanager,
        Some(AlertmanagerMode::Manual {
            target: AlertmanagerTarget {
                namespace: "obs".into(),
                service: "am".into(),
                port: 9093,
                path_prefix: "/am".into(),
            }
        })
    );
    assert_eq!(
        serde_json::to_value(&read).unwrap()["alertmanager"],
        manual["alertmanager"]
    );
    // A value this version cannot read is automatic, and the other settings stay.
    let odd: ClusterSettings = serde_json::from_value(
        serde_json::json!({"alertmanager": {"mode": "url", "url": "http://x"}, "color": "red"}),
    )
    .unwrap();
    assert_eq!(
        (odd.alertmanager, odd.color.as_deref()),
        (None, Some("red"))
    );
    let none: ClusterSettings = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(
        serde_json::to_value(&none)
            .unwrap()
            .get("alertmanager")
            .is_none()
    );
}

#[test]
fn every_shown_label_value_and_matcher_is_cleaned_not_only_clipped() {
    let answer = r#"{"status":"success","data":{"alerts":[{"state":"firing","activeAt":"2026-10-24T08:00:00Z",
        "labels":{"alertname":"Leaky","severity":"warning","target":"https://ops:hunter2@db.example.com/x?token=s3cr3t",
        "https://u:pw@h/k":"v","dsn":"user:pass@db:5432/app"},"annotations":{}}]}}"#;
    let alerts = prometheus_alerts(ok(), answer.as_bytes()).unwrap();
    let shown = serde_json::to_string(&alerts).unwrap();
    for secret in ["hunter2", "s3cr3t", "pw@", "user:pass"] {
        assert!(!shown.contains(secret), "{secret} in {shown}");
    }
    assert_eq!(alerts[0].labels["target"], "https://db.example.com/x");
    assert_eq!(alerts[0].labels["dsn"], "db:5432/app");

    let silence = r#"[{"id":"s1","status":{"state":"active"},"createdBy":"bob","comment":"c",
        "startsAt":"2026-10-24T08:00:00Z","endsAt":"2026-10-24T09:00:00Z",
        "matchers":[{"name":"instance","value":"https://ops:hunter2@db.example.com/?sig=1","isRegex":false,"isEqual":true}]}]"#;
    let (list, _) = silences(silence.as_bytes()).unwrap();
    assert_eq!(list[0].matchers[0].value, "https://db.example.com/");
}

#[test]
fn alerts_with_identical_labels_get_unique_ids() {
    // Two rule groups of Prometheus with the same rule: two alerts, the same labels.
    let twice = r#"{"status":"success","data":{"alerts":[
        {"state":"firing","labels":{"alertname":"Twin","namespace":"shop"},"annotations":{"summary":"one"}},
        {"state":"firing","labels":{"alertname":"Twin","namespace":"shop"},"annotations":{"summary":"two"}}]}}"#;
    let merged = merge(None, prometheus_alerts(ok(), twice.as_bytes()).unwrap());
    assert_eq!(merged.len(), 2);
    assert_ne!(merged[0].id, merged[1].id);
    assert_eq!(merged[1].id, format!("{}-2", merged[0].id));
    // vmalert says which group and rule an alert is from: the ids differ by them, the same on every poll.
    let groups = r#"{"status":"success","data":{"alerts":[
        {"state":"firing","group_id":"1","rule_id":"10","labels":{"alertname":"Twin"},"annotations":{}},
        {"state":"firing","group_id":"2","rule_id":"20","labels":{"alertname":"Twin"},"annotations":{}}]}}"#;
    let read = prometheus_alerts(ok(), groups.as_bytes()).unwrap();
    assert_ne!(read[0].id, read[1].id);
    assert_eq!(read, prometheus_alerts(ok(), groups.as_bytes()).unwrap());
}

#[test]
fn a_found_alertmanager_is_kept_longer_than_not_finding_one() {
    assert_eq!(detect_ttl(true), Duration::from_secs(300));
    assert!(detect_ttl(false) < detect_ttl(true));
}

#[tokio::test]
async fn detection_lists_at_most_a_hundred_services_and_probes_at_most_four() {
    let names = [
        ("alertmanager-operated", 9093),
        ("alertmanager-main", 9093),
        ("a-alertmanager", 9093),
        ("b-alertmanager", 9093),
        ("c-alertmanager", 9093),
        ("alertmanager", 9093),
        ("vmalertmanager-vm", 9093),
    ];
    let list = service_list(&names);
    let api = FakeApi::start(move |req: &Request| {
        let path = req.path.as_str();
        if path == "/api" {
            Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            )
        } else if path == "/api/v1/namespaces/monitoring/services" {
            Reply::json(200, list.clone())
        } else if path.ends_with("/services") {
            Reply::json(200, service_list(&[]))
        } else {
            // No candidate answers as an Alertmanager (a 404 is not retried, so each request is one probe).
            Reply::not_found()
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let got = report(&mgr, &id, &PrometheusMode::Off, &AlertmanagerMode::Auto)
        .await
        .unwrap();
    assert_eq!(got.alertmanager.status, AlertSourceStatus::NotFound);
    let requests = api.requests();
    let probes = requests
        .iter()
        .filter(|r| r.path.ends_with("/api/v2/alerts"))
        .count();
    assert_eq!(probes, MAX_PROBES);
    let lists: Vec<_> = requests
        .iter()
        .filter(|r| r.path.ends_with("/services"))
        .collect();
    assert!(!lists.is_empty());
    assert!(
        lists.iter().all(|r| r.query.contains("limit=100")),
        "{:?}",
        lists.iter().map(|r| &r.query).collect::<Vec<_>>()
    );
}
