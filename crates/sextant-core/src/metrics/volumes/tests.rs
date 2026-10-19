use std::time::{Duration, Instant};

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};
use crate::metrics::PrometheusTarget;

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const FORBIDDEN: &str =
    r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":403}"#;

/// A summary with a claim, a volume that is no claim, and everything else a kubelet sends besides.
fn summary(ns: &str, claim: &str, used: u64) -> String {
    format!(
        r#"{{"node":{{"nodeName":"n","cpu":{{"usageNanoCores":5}},"fs":{{"usedBytes":1}}}},
        "pods":[{{"podRef":{{"name":"p","namespace":"{ns}","uid":"u"}},
          "containers":[{{"name":"app","memory":{{"workingSetBytes":7}}}}],
          "volume":[
            {{"name":"data","capacityBytes":1000,"usedBytes":{used},"availableBytes":{avail},
              "inodes":100,"inodesUsed":96,"inodesFree":4,"pvcRef":{{"name":"{claim}","namespace":"{ns}"}}}},
            {{"name":"tmp","capacityBytes":5,"usedBytes":5}}
          ]}}]}}"#,
        avail = 1000 - used
    )
}

fn nodes(names: &[&str]) -> String {
    let items: Vec<String> = names
        .iter()
        .map(|n| format!(r#"{{"metadata":{{"name":"{n}"}}}}"#))
        .collect();
    format!(
        r#"{{"kind":"PartialObjectMetadataList","apiVersion":"meta.k8s.io/v1","metadata":{{}},"items":[{}]}}"#,
        items.join(",")
    )
}

fn node_of(req: &Request) -> Option<&str> {
    req.path
        .strip_prefix("/api/v1/nodes/")?
        .strip_suffix("/proxy/stats/summary")
}

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
fn a_summary_keeps_only_the_claims_and_their_volume_fields() {
    let volumes = parse_summary(summary("db", "data-0", 900).as_bytes()).unwrap();
    assert_eq!(
        volumes,
        vec![VolumeUsage {
            namespace: "db".into(),
            claim: "data-0".into(),
            capacity_bytes: Some(1000.0),
            used_bytes: Some(900.0),
            available_bytes: Some(100.0),
            inodes: Some(100.0),
            inodes_used: Some(96.0),
            inodes_free: Some(4.0),
        }]
    );
    assert!(parse_summary(b"<html>").is_err());
    assert_eq!(parse_summary(b"{}").unwrap(), vec![]);
}

#[test]
fn one_entry_per_claim_the_fullest_reading_and_at_most_the_cap() {
    let at = |claim: &str, used: f64| VolumeUsage {
        namespace: "db".into(),
        claim: claim.into(),
        used_bytes: Some(used),
        ..VolumeUsage::default()
    };
    let (merged, truncated) = merge(vec![at("b", 1.0), at("a", 5.0), at("a", 9.0), at("a", 2.0)]);
    assert!(!truncated);
    assert_eq!(merged, vec![at("a", 9.0), at("b", 1.0)]);

    let many: Vec<VolumeUsage> = (0..=MAX_VOLUMES)
        .map(|i| at(&format!("c{i:05}"), 1.0))
        .collect();
    let (capped, truncated) = merge(many);
    assert!(truncated);
    assert_eq!(capped.len(), MAX_VOLUMES);
}

#[test]
fn only_plain_node_names_go_into_the_path() {
    assert!(safe_node_name("ip-10-0-0-1.ec2.internal"));
    for bad in ["", "../secrets", "n/proxy", "N1", "n?x=1", "n%2F"] {
        assert!(!safe_node_name(bad), "{bad}");
    }
}

#[tokio::test]
async fn every_node_is_asked_and_a_failing_one_is_counted() {
    let api = FakeApi::start(|req: &Request| match (req.path.as_str(), node_of(req)) {
        ("/api", _) => Reply::json(200, API_VERSIONS),
        ("/api/v1/nodes", _) => Reply::json(200, nodes(&["n1", "n2", "n3"])),
        (_, Some("n1")) => Reply::json(200, summary("db", "data-0", 900)),
        (_, Some("n2")) => Reply::json(200, summary("shop", "cache", 10)),
        (_, Some(_)) => Reply::json(500, r#"{"kind":"Status","code":500}"#),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let report = volume_usage(&mgr, &id, &PrometheusMode::Off).await.unwrap();
    assert_eq!(report.source, VolumeUsageSource::Kubelet);
    assert_eq!((report.nodes, report.nodes_failed), (3, 1));
    assert!(!report.kubelet_forbidden && !report.truncated);
    let names: Vec<_> = report
        .volumes
        .iter()
        .map(|v| format!("{}/{}", v.namespace, v.claim))
        .collect();
    assert_eq!(names, ["db/data-0", "shop/cache"]);
    let list = api
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/v1/nodes")
        .unwrap();
    assert!(
        list.query.contains(&format!("limit={MAX_NODES}")),
        "{}",
        list.query
    );
}

#[tokio::test]
async fn at_most_eight_nodes_are_asked_at_once() {
    let names: Vec<String> = (0..16).map(|i| format!("n{i}")).collect();
    let listed = nodes(&names.iter().map(String::as_str).collect::<Vec<_>>());
    let api = FakeApi::start(
        move |req: &Request| match (req.path.as_str(), node_of(req)) {
            ("/api", _) => Reply::json(200, API_VERSIONS),
            ("/api/v1/nodes", _) => Reply::json(200, listed.clone()),
            (_, Some(_)) => Reply::json(200, r#"{"pods":[]}"#).after(Duration::from_millis(300)),
            _ => Reply::not_found(),
        },
    )
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let started = Instant::now();
    let report = volume_usage(&mgr, &id, &PrometheusMode::Off).await.unwrap();
    assert_eq!((report.nodes, report.nodes_failed), (16, 0));
    // 16 nodes, 8 at a time, 300 ms each: two rounds at least.
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(590), "{elapsed:?}");
    // …and in parallel: one at a time would take 4.8 s.
    assert!(elapsed < Duration::from_millis(2500), "{elapsed:?}");
}

#[tokio::test]
async fn a_summary_over_the_size_cap_is_not_read() {
    let big = format!(r#"{{"pods":[],"pad":"{}"}}"#, "x".repeat(MAX_SUMMARY_BYTES));
    let api = FakeApi::start(
        move |req: &Request| match (req.path.as_str(), node_of(req)) {
            ("/api", _) => Reply::json(200, API_VERSIONS),
            ("/api/v1/nodes", _) => Reply::json(200, nodes(&["big", "ok"])),
            (_, Some("big")) => Reply::json(200, big.clone()),
            (_, Some(_)) => Reply::json(200, summary("db", "data-0", 1)),
            _ => Reply::not_found(),
        },
    )
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let report = volume_usage(&mgr, &id, &PrometheusMode::Off).await.unwrap();
    assert_eq!((report.nodes, report.nodes_failed), (2, 1));
    assert_eq!(report.volumes.len(), 1);
}

/// The cluster's API with `nodes/proxy` forbidden, and Prometheus on the same fake server.
async fn forbidden_kubelet_with_prometheus() -> FakeApi {
    FakeApi::start(|req: &Request| match (req.path.as_str(), node_of(req)) {
        ("/api", _) => Reply::json(200, API_VERSIONS),
        ("/api/v1/nodes", _) => Reply::json(200, nodes(&["n1", "n2"])),
        (_, Some(_)) => Reply::json(403, FORBIDDEN),
        ("/api/v1/query", _) => {
            let query = decode(&req.query);
            let value = if query.contains("capacity_bytes") {
                "1000"
            } else if query.contains("used_bytes") {
                "950"
            } else if query.contains("inodes") {
                return Reply::json(400, r#"{"status":"error","error":"unknown metric"}"#);
            } else {
                "50"
            };
            Reply::json(
                200,
                format!(
                    r#"{{"status":"success","data":{{"resultType":"vector","result":[{{"metric":{{"namespace":"db","persistentvolumeclaim":"data-0"}},"value":[1,"{value}"]}}]}}}}"#
                ),
            )
        }
        _ => Reply::not_found(),
    })
    .await
}

#[tokio::test]
async fn forbidden_nodes_proxy_falls_back_to_prometheus_and_says_so() {
    let api = forbidden_kubelet_with_prometheus().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let mode = PrometheusMode::Manual {
        target: PrometheusTarget::Url {
            url: api.url().to_owned(),
        },
    };
    let report = volume_usage(&mgr, &id, &mode).await.unwrap();
    assert_eq!(report.source, VolumeUsageSource::Prometheus);
    assert!(report.kubelet_forbidden);
    assert_eq!(
        report.volumes,
        vec![VolumeUsage {
            namespace: "db".into(),
            claim: "data-0".into(),
            capacity_bytes: Some(1000.0),
            used_bytes: Some(950.0),
            available_bytes: Some(50.0),
            ..VolumeUsage::default()
        }]
    );
    let queries: Vec<String> = api
        .requests()
        .into_iter()
        .filter(|r| r.path == "/api/v1/query")
        .map(|r| decode(&r.query))
        .collect();
    assert_eq!(queries.len(), 6);
    let used = r#"query=max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_used_bytes{persistentvolumeclaim!=""})"#;
    assert!(queries.iter().any(|q| q == used), "{queries:?}");
}

#[tokio::test]
async fn one_node_refusing_keeps_the_others_readings() {
    let api = FakeApi::start(|req: &Request| match (req.path.as_str(), node_of(req)) {
        ("/api", _) => Reply::json(200, API_VERSIONS),
        ("/api/v1/nodes", _) => Reply::json(200, nodes(&["n1", "n2"])),
        (_, Some("n1")) => Reply::json(200, summary("db", "data-0", 900)),
        (_, Some(_)) => Reply::json(403, FORBIDDEN),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let report = volume_usage(&mgr, &id, &PrometheusMode::Off).await.unwrap();
    assert_eq!(report.source, VolumeUsageSource::Kubelet);
    assert!(!report.kubelet_forbidden);
    assert_eq!((report.nodes, report.nodes_failed), (2, 1));
    assert_eq!(report.volumes.len(), 1);
}

#[tokio::test]
async fn forbidden_without_prometheus_says_both() {
    let api = forbidden_kubelet_with_prometheus().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let err = volume_usage(&mgr, &id, &PrometheusMode::Off)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert!(err.message.contains("nodes/proxy"), "{}", err.message);
    assert!(
        err.message.contains("Prometheus is turned off"),
        "{}",
        err.message
    );
}
