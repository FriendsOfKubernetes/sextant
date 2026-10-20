//! VictoriaMetrics as a metrics source (#226) against the kind test cluster brought up with both
//! `scripts/test-cluster.sh up --prometheus --victoria-metrics`: vmagent scrapes what the Prometheus fixture scrapes and
//! writes to a single-node VictoriaMetrics and to a VictoriaMetrics cluster, so every fixed query family (current
//! usage, charts, right-sizing history, volume stats, request metrics, traffic edges) is asked of Prometheus, of
//! vmsingle and of vmselect, and the answers are compared within the tolerances the engines' differences need
//! (separate scrapes, `rate` without extrapolation, `-search.latencyOffset`; ADR-0102). Auto-detection is checked as a
//! ServiceAccount that sees only the `victoria-metrics` namespace. Read-only; returns early (and passes) without the
//! cluster or the fixtures.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test victoria_metrics -- --nocapture
//! ```

mod common;

use std::collections::BTreeMap;
use std::path::Path;

use k8s_openapi::api::core::v1::{Secret, Service};
use kube::Api;
use serde_json::Value;
use sextant_core::metrics::{
    self, ChartTarget, HistoryScope, HistoryWindow, MAX_TRAFFIC_NAMESPACES, MetricsSourceKind,
    PrometheusMode, PrometheusTarget, RequestSourceKind, RequestTarget, TrafficWindow, UsageSource,
    VMSELECT_PATH_PREFIX, VolumeUsageSource,
};
use sextant_core::{ClusterId, ClusterManager, ClusterSettings};

const NAMESPACE: &str = "victoria-metrics";
const SINGLE: &str = "vm-victoria-metrics-single-server";
const CLAIM: &str = "vm-data";

fn prometheus() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: "monitoring".into(),
        service: "prometheus-operated".into(),
        port: 9090,
        path_prefix: String::new(),
    }
}

fn vmsingle() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: NAMESPACE.into(),
        service: SINGLE.into(),
        port: 8428,
        path_prefix: String::new(),
    }
}

fn vmselect() -> PrometheusTarget {
    PrometheusTarget::Service {
        namespace: NAMESPACE.into(),
        service: "vmselect-vm".into(),
        port: 8481,
        path_prefix: VMSELECT_PATH_PREFIX.into(),
    }
}

fn proxy(target: &PrometheusTarget) -> String {
    let PrometheusTarget::Service {
        namespace,
        service,
        port,
        path_prefix,
    } = target
    else {
        unreachable!()
    };
    format!("/api/v1/namespaces/{namespace}/services/{service}:{port}/proxy{path_prefix}")
}

/// Both fixtures are installed; otherwise a note and `false`.
async fn has_fixtures(client: &kube::Client) -> bool {
    let found = |ns: &'static str, name: &'static str| {
        let api: Api<Service> = Api::namespaced(client.clone(), ns);
        async move { api.get_opt(name).await.ok().flatten().is_some() }
    };
    let ok = found("monitoring", "prometheus-operated").await && found(NAMESPACE, SINGLE).await;
    if !ok {
        eprintln!(
            "skipped: the fixtures are not installed (scripts/test-cluster.sh up --prometheus --victoria-metrics)"
        );
    }
    ok
}

fn settings(target: &PrometheusTarget) -> ClusterSettings {
    ClusterSettings {
        prometheus: manual(target),
        usage_source: UsageSource::Prometheus,
        ..Default::default()
    }
}

fn manual(target: &PrometheusTarget) -> PrometheusMode {
    PrometheusMode::Manual {
        target: target.clone(),
    }
}

/// A kubeconfig of the fixture's `vm-reader` ServiceAccount: it may list Services and use the service proxy in
/// `victoria-metrics` only.
async fn reader_kubeconfig(admin: &Path, client: &kube::Client, dir: &Path) -> std::path::PathBuf {
    let secrets: Api<Secret> = Api::namespaced(client.clone(), NAMESPACE);
    let mut token = None;
    for _ in 0..60 {
        token = secrets
            .get_opt("vm-reader-token")
            .await
            .unwrap()
            .and_then(|s| s.data)
            .and_then(|d| d.get("token").cloned());
        if token.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    let token = String::from_utf8(token.expect("a token for vm-reader").0).unwrap();
    let kubeconfig = kube::config::Kubeconfig::read_from(admin).unwrap();
    let cluster = kubeconfig.clusters[0].cluster.clone().unwrap();
    let yaml = format!(
        "apiVersion: v1\nkind: Config\nclusters:\n  - name: vm\n    cluster:\n      server: {}\n      certificate-authority-data: {}\nusers:\n  - name: vm-reader\n    user:\n      token: {token}\ncontexts:\n  - name: vm-reader\n    context:\n      cluster: vm\n      user: vm-reader\n      namespace: {NAMESPACE}\ncurrent-context: vm-reader\n",
        cluster.server.unwrap(),
        cluster.certificate_authority_data.unwrap(),
    );
    let path = dir.join("kubeconfig-vm-reader");
    std::fs::write(&path, yaml).unwrap();
    path
}

#[tokio::test]
async fn auto_detection_finds_victoria_metrics_where_no_prometheus_is_visible() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_fixtures(&client).await {
        return;
    }
    // As admin both are visible: Prometheus first, as before.
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let status =
        metrics::metrics_status(&mgr, &id, &PrometheusMode::Auto, &UsageSource::Auto).await;
    assert_eq!(status.prometheus, Some(prometheus()));
    assert_eq!(status.prometheus_kind, Some(MetricsSourceKind::Prometheus));
    let manual_cluster =
        metrics::metrics_status(&mgr, &id, &manual(&vmselect()), &UsageSource::Prometheus).await;
    assert_eq!(manual_cluster.prometheus, Some(vmselect()));
    assert_eq!(
        manual_cluster.prometheus_kind,
        Some(MetricsSourceKind::VictoriaMetricsCluster)
    );
    let kubelet = metrics::volume_usage(&mgr, &id, &PrometheusMode::Auto)
        .await
        .unwrap();
    assert_eq!(kubelet.source, VolumeUsageSource::Kubelet);

    // As vm-reader only VictoriaMetrics is: single-node before vmselect.
    let dir = tempfile::tempdir().unwrap();
    let reader = reader_kubeconfig(&cluster.kubeconfig, &client, dir.path()).await;
    let (_tmp, mgr, id) = common::connected(&reader).await;
    let status =
        metrics::metrics_status(&mgr, &id, &PrometheusMode::Auto, &UsageSource::Auto).await;
    assert_eq!(status.prometheus, Some(vmsingle()));
    assert_eq!(
        status.prometheus_kind,
        Some(MetricsSourceKind::VictoriaMetricsSingle)
    );
    // Current usage from it: metrics-server is served but not readable as vm-reader, so `auto` falls back.
    let auto = ClusterSettings::default();
    let pods = metrics::pod_usage(&mgr, &id, &auto, Some(vec!["kube-system".into()]))
        .await
        .unwrap();
    assert!(
        pods.iter().any(|p| p.name.starts_with("coredns-")),
        "{pods:?}"
    );

    // Volume usage falls back to it (no nodes/proxy) and agrees with the kubelet's summary.
    let fallback = metrics::volume_usage(&mgr, &id, &PrometheusMode::Auto)
        .await
        .unwrap();
    assert_eq!(fallback.source, VolumeUsageSource::Prometheus);
    assert!(fallback.kubelet_forbidden);
    let claim = |report: &metrics::VolumeUsageReport| {
        report
            .volumes
            .iter()
            .find(|v| v.namespace == NAMESPACE && v.claim == CLAIM)
            .cloned()
            .unwrap_or_else(|| panic!("no {CLAIM} in {report:?}"))
    };
    let (vm, kubelet) = (claim(&fallback), claim(&kubelet));
    eprintln!("volume {CLAIM}: VictoriaMetrics {vm:?}\n  kubelet {kubelet:?}");
    assert_eq!(vm.capacity_bytes, kubelet.capacity_bytes);
    assert_eq!(vm.inodes, kubelet.inodes);
    let (a, b) = (
        vm.available_bytes.unwrap(),
        kubelet.available_bytes.unwrap(),
    );
    assert!(relative(a, b) < 0.02, "available {a} vs {b}");
}

/// |a − b| relative to the larger of the two (0 when both are 0).
fn relative(a: f64, b: f64) -> f64 {
    let scale = a.abs().max(b.abs());
    if scale == 0.0 {
        0.0
    } else {
        (a - b).abs() / scale
    }
}

/// The largest and the median relative difference over pairs, and how many pairs.
fn spread(pairs: &[(f64, f64)]) -> (f64, f64, usize) {
    let mut d: Vec<f64> = pairs.iter().map(|(a, b)| relative(*a, *b)).collect();
    d.sort_by(f64::total_cmp);
    let median = d.get(d.len() / 2).copied().unwrap_or(0.0);
    (d.last().copied().unwrap_or(0.0), median, d.len())
}

/// Every family against one VictoriaMetrics target; prints what differs and by how much.
async fn compare(
    mgr: &ClusterManager,
    id: &ClusterId,
    client: &kube::Client,
    vm: &PrometheusTarget,
) {
    let name = metrics::source_kind(vm).map_or("?".into(), |k| format!("{k:?}"));
    let kube_system = Some(vec!["kube-system".to_owned()]);

    // Current pod and node usage.
    let p = metrics::pod_usage(mgr, id, &settings(&prometheus()), kube_system.clone())
        .await
        .unwrap();
    let v = metrics::pod_usage(mgr, id, &settings(vm), kube_system.clone())
        .await
        .unwrap();
    let by_pod = |list: &[metrics::PodUsage]| -> BTreeMap<String, metrics::Usage> {
        list.iter().map(|p| (p.name.clone(), p.usage)).collect()
    };
    let (p, v) = (by_pod(&p), by_pod(&v));
    let common: Vec<&String> = p.keys().filter(|k| v.contains_key(*k)).collect();
    assert!(common.len() >= 5, "{name}: pods {p:?} vs {v:?}");
    assert!(common.len() * 10 >= p.len() * 9, "{name}: {p:?} vs {v:?}");
    let memory: Vec<_> = common
        .iter()
        .map(|k| (p[*k].memory_bytes, v[*k].memory_bytes))
        .collect();
    let cpu: Vec<_> = common
        .iter()
        .filter(|k| p[**k].cpu_millicores >= 5.0)
        .map(|k| (p[*k].cpu_millicores, v[*k].cpu_millicores))
        .collect();
    let (memory_max, memory_median, n) = spread(&memory);
    let (cpu_max, cpu_median, m) = spread(&cpu);
    eprintln!(
        "{name} pod usage: {n} pods, memory max {:.1}% median {:.1}%; cpu (≥5m, {m} pods) max {:.1}% median {:.1}%",
        memory_max * 100.0,
        memory_median * 100.0,
        cpu_max * 100.0,
        cpu_median * 100.0
    );
    // CPU is a 2-minute rate: VictoriaMetrics evaluates it 30 s earlier (`-search.latencyOffset`), over another
    // window of a noisy counter, and without extrapolation.
    assert!(memory_median < 0.05, "{name}: memory {memory:?}");
    assert!(cpu_median < 0.5, "{name}: cpu {cpu:?}");

    let p = metrics::node_usage(mgr, id, &settings(&prometheus()))
        .await
        .unwrap();
    let v = metrics::node_usage(mgr, id, &settings(vm)).await.unwrap();
    assert_eq!(p.len(), v.len(), "{name}: nodes {p:?} vs {v:?}");
    for (a, b) in p.iter().zip(&v) {
        assert_eq!(a.name, b.name);
        let (memory, cpu) = (
            relative(a.usage.memory_bytes, b.usage.memory_bytes),
            relative(a.usage.cpu_millicores, b.usage.cpu_millicores),
        );
        eprintln!(
            "{name} node {}: memory {:.1}%, cpu {:.1}%",
            a.name,
            memory * 100.0,
            cpu * 100.0
        );
        assert!(memory < 0.05 && cpu < 0.5, "{name}: {a:?} vs {b:?}");
    }

    // Charts of the last hour: the same metrics, the points of the same times close.
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client.clone(), "kube-system");
    let coredns = pods
        .list(&kube::api::ListParams::default().labels("k8s-app=kube-dns"))
        .await
        .unwrap()
        .items[0]
        .metadata
        .name
        .clone()
        .unwrap();
    let node = metrics::node_usage(mgr, id, &settings(vm)).await.unwrap()[0]
        .name
        .clone();
    let charts = [
        ChartTarget::Cluster,
        ChartTarget::Node { name: node },
        ChartTarget::Pod {
            namespace: "kube-system".into(),
            name: coredns,
        },
        ChartTarget::Workload {
            namespace: "kube-system".into(),
            kind: "Deployment".into(),
            name: "coredns".into(),
        },
    ];
    for chart in charts {
        let p = metrics::query_charts(mgr, id, &prometheus(), chart.clone(), 3600)
            .await
            .unwrap();
        let v = metrics::query_charts(mgr, id, vm, chart.clone(), 3600)
            .await
            .unwrap();
        let metrics_of =
            |s: &[metrics::Series]| s.iter().map(|s| s.metric.clone()).collect::<Vec<_>>();
        assert_eq!(metrics_of(&p), metrics_of(&v), "{name} {chart:?}");
        for (a, b) in p.iter().zip(&v) {
            let at: BTreeMap<i64, f64> = b.points.iter().copied().collect();
            // The newest minute is left out: VictoriaMetrics answers it from 30 s ago (`-search.latencyOffset`).
            let last = a.points.last().map_or(0, |p| p.0) - 60;
            let pairs: Vec<(f64, f64)> = a
                .points
                .iter()
                .filter(|(t, _)| *t <= last)
                .filter_map(|(t, x)| at.get(t).map(|y| (*x, *y)))
                .collect();
            let (max, median, n) = spread(&pairs);
            eprintln!(
                "{name} chart {:?} {}: {n} common points of {}/{}, max {:.1}% median {:.1}%",
                chart,
                a.metric,
                a.points.len(),
                b.points.len(),
                max * 100.0,
                median * 100.0
            );
            assert!(n >= 1, "{name} {chart:?} {}: no common points", a.metric);
            let bound = if a.metric == "cpu" { 0.25 } else { 0.05 };
            assert!(median < bound, "{name} {chart:?} {}: {pairs:?}", a.metric);
        }
    }

    // Right-sizing history over a day, compared where both have the same coverage.
    let scope = HistoryScope::Namespaces {
        namespaces: kube_system.clone(),
    };
    let p = metrics::usage_history(mgr, id, &prometheus(), scope.clone(), HistoryWindow::Day)
        .await
        .unwrap();
    let v = metrics::usage_history(mgr, id, vm, scope, HistoryWindow::Day)
        .await
        .unwrap();
    assert!(v.coverage_known && v.live_known, "{name}: {v:?}");
    let key = |c: &metrics::ContainerHistory| (c.pod.clone(), c.container.clone());
    let at: BTreeMap<_, _> = v.containers.iter().map(|c| (key(c), c)).collect();
    let (mut memory, mut cpu, mut seen, mut common, mut other) =
        (Vec::new(), Vec::new(), Vec::new(), 0, 0);
    for a in &p.containers {
        let Some(b) = at.get(&key(a)) else {
            continue;
        };
        common += 1;
        // Compared only where both have the same history: `first_seen` is a subquery step (10 minutes) apart at
        // most, and VictoriaMetrics' steps end 30 s earlier.
        let (Some(fa), Some(fb)) = (a.first_seen, b.first_seen) else {
            other += 1;
            continue;
        };
        seen.push((fa - fb).abs());
        if (fa - fb).abs() > 900 {
            other += 1;
            continue;
        }
        if let (Some(x), Some(y)) = (a.memory_max_bytes, b.memory_max_bytes) {
            memory.push((x, y));
        }
        if let (Some(x), Some(y)) = (a.cpu_p95_millicores, b.cpu_p95_millicores)
            && x >= 5.0
        {
            cpu.push((x, y));
        }
    }
    assert!(
        common * 10 >= p.containers.len() * 9,
        "{name}: {p:?}\n{v:?}"
    );
    seen.sort_unstable();
    let (memory_max, memory_median, n) = spread(&memory);
    let (cpu_max, cpu_median, m) = spread(&cpu);
    eprintln!(
        "{name} history: {common} containers in both ({other} with other coverage), first seen apart by median {} s max {} s; memory peak max {:.1}% median {:.1}% ({n}); cpu p95 (≥5m) max {:.1}% median {:.1}% ({m})",
        seen.get(seen.len() / 2).copied().unwrap_or(0),
        seen.last().copied().unwrap_or(0),
        memory_max * 100.0,
        memory_median * 100.0,
        cpu_max * 100.0,
        cpu_median * 100.0
    );
    assert!(memory_median < 0.05, "{name}: {memory:?}");
    assert!(cpu_median < 0.25, "{name}: {cpu:?}");

    // Request metrics and traffic: the fixture has no source, so the answers are empty — and every query is accepted.
    let coredns = RequestTarget::Workload {
        namespace: "kube-system".into(),
        kind: "Deployment".into(),
        name: "coredns".into(),
    };
    let p = metrics::request_health(mgr, id, &manual(&prometheus()), coredns.clone())
        .await
        .unwrap();
    let v = metrics::request_health(mgr, id, &manual(vm), coredns.clone())
        .await
        .unwrap();
    assert!(v.failed.is_empty() && v.throttling_known, "{name}: {v:?}");
    assert_eq!(p.sources, v.sources, "{name}");
    assert_eq!(p.golden.len(), v.golden.len(), "{name}");
    assert_eq!(
        p.throttling.len(),
        v.throttling.len(),
        "{name}: {p:?} vs {v:?}"
    );
    for window in [TrafficWindow::Minutes5, TrafficWindow::Hour1] {
        let namespaces = vec!["kube-system".to_owned(), NAMESPACE.to_owned()];
        let p = metrics::traffic_graph(mgr, id, &manual(&prometheus()), namespaces.clone(), window)
            .await
            .unwrap();
        let v = metrics::traffic_graph(mgr, id, &manual(vm), namespaces, window)
            .await
            .unwrap();
        assert!(v.failed.is_empty(), "{name}: {v:?}");
        assert_eq!(p.edges.len(), v.edges.len(), "{name}");
    }
    let base = proxy(vm);
    let mut asked = 0;
    let pod = RequestTarget::Pod {
        namespace: "kube-system".into(),
        name: "coredns-0".into(),
    };
    let all: Vec<String> = (0..MAX_TRAFFIC_NAMESPACES)
        .map(|i| format!("namespace-{i}"))
        .collect();
    for kind in RequestSourceKind::ALL {
        for target in [coredns.clone(), pod.clone()] {
            let (instant, range) =
                metrics::request_queries(kind, &target, &["kube-dns".into()], true).unwrap();
            accepted(
                client,
                &base,
                &format!("api/v1/query?query={}", encode(&instant)),
                &instant,
            )
            .await;
            let path = format!(
                "api/v1/query_range?query={}&start=1760000000&end=1760003600&step=60",
                encode(&range)
            );
            accepted(client, &base, &path, &range).await;
            asked += 2;
        }
        for window in [TrafficWindow::Minutes5, TrafficWindow::Hour1] {
            for query in metrics::traffic_queries(kind, &all, window, true) {
                accepted(
                    client,
                    &base,
                    &format!("api/v1/query?query={}", encode(&query)),
                    &query,
                )
                .await;
                asked += 1;
            }
        }
    }
    eprintln!("{name}: {asked} request and traffic queries accepted");

    // Volume stats: the same claims and fill levels as Prometheus (both read the kubelet's series).
    for metric in [
        "kubelet_volume_stats_capacity_bytes",
        "kubelet_volume_stats_available_bytes",
        "kubelet_volume_stats_inodes_free",
    ] {
        let query = format!(
            r#"max by (namespace, persistentvolumeclaim) ({metric}{{persistentvolumeclaim!=""}})"#
        );
        let path = format!("api/v1/query?query={}", encode(&query));
        let a = values(&ask(client, &proxy(&prometheus()), &path).await);
        let b = values(&ask(client, &base, &path).await);
        assert_eq!(
            a.keys().collect::<Vec<_>>(),
            b.keys().collect::<Vec<_>>(),
            "{name} {metric}"
        );
        assert!(
            a.contains_key(&format!("{NAMESPACE}/{CLAIM}")),
            "{name} {metric}: {a:?}"
        );
        for (k, x) in &a {
            let d = relative(*x, b[k]);
            eprintln!("{name} {metric} {k}: {:.2}%", d * 100.0);
            assert!(d < 0.02, "{name} {metric} {k}: {x} vs {}", b[k]);
        }
    }
}

#[tokio::test]
async fn every_query_family_agrees_with_prometheus() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_fixtures(&client).await {
        return;
    }
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    for vm in [vmsingle(), vmselect()] {
        compare(&mgr, &id, &client, &vm).await;
    }
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn ask(client: &kube::Client, base: &str, path: &str) -> Value {
    let request = http::Request::get(format!("{base}/{path}"))
        .body(Vec::new())
        .unwrap();
    let text = client.request_text(request).await.unwrap();
    serde_json::from_str(&text).unwrap()
}

async fn accepted(client: &kube::Client, base: &str, path: &str, query: &str) {
    let answer = ask(client, base, path).await;
    assert_eq!(answer["status"], "success", "{base}: {query}\n{answer}");
}

/// `namespace/claim` → value of an instant answer.
fn values(answer: &Value) -> BTreeMap<String, f64> {
    answer["data"]["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                format!(
                    "{}/{}",
                    r["metric"]["namespace"].as_str().unwrap(),
                    r["metric"]["persistentvolumeclaim"].as_str().unwrap()
                ),
                r["value"][1].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect()
}

/// The request and traffic fixtures (`metrics/traffic/testdata/*.json`, `metrics/requests/testdata/hubble-*.json`):
/// each lists synthetic counters (`series`: a constant `rate`) and what a real Prometheus answered to every fixed
/// query over them (`queries`). Their series are imported into the fixture's empty `vm-replay` (each file a day apart,
/// so files with the same series do not mix) and every query is asked again of it: VictoriaMetrics must give the same
/// series with the same values.
#[tokio::test]
async fn the_recorded_prometheus_answers_of_the_request_and_traffic_queries() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_fixtures(&client).await {
        return;
    }
    let base = format!("/api/v1/namespaces/{NAMESPACE}/services/vm-replay:8428/proxy");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/metrics");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for (dir, prefix) in [("traffic/testdata", ""), ("requests/testdata", "hubble-")] {
        for entry in std::fs::read_dir(root.join(dir)).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name.starts_with(prefix) && name.ends_with(".json") {
                files.push(path);
            }
        }
    }
    files.sort();
    assert_eq!(files.len(), 9);
    let (mut compared, mut series) = (0, 0);
    for (i, file) in files.iter().enumerate() {
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
        let recorded_at = fixture["time"].as_i64().unwrap();
        let at = recorded_at + 86_400 * (i as i64 + 1);
        // Two hours of samples every 15 s, each counter growing at its rate.
        let mut body = String::new();
        for series in fixture["series"].as_array().unwrap() {
            let labels: Vec<String> = series["labels"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| format!("{k}=\"{}\"", v.as_str().unwrap()))
                .collect();
            let rate = series["rate"].as_f64().unwrap();
            for step in 0..=480 {
                let t = at - 7200 + step * 15;
                body.push_str(&format!(
                    "{}{{{}}} {} {}\n",
                    series["metric"].as_str().unwrap(),
                    labels.join(","),
                    rate * (step * 15) as f64,
                    t * 1000
                ));
            }
        }
        let request = http::Request::post(format!("{base}/api/v1/import/prometheus"))
            .body(body.into_bytes())
            .unwrap();
        client.request_text(request).await.unwrap();
        let flush = http::Request::get(format!("{base}/internal/force_flush"))
            .body(Vec::new())
            .unwrap();
        client.request_text(flush).await.unwrap();

        for query in fixture["queries"].as_array().unwrap() {
            let promql = query["promql"].as_str().unwrap();
            let path = format!("api/v1/query?query={}&time={at}", encode(promql));
            let mut answer = ask(&client, &base, &path).await;
            for _ in 0..20 {
                if answer["data"]["result"]
                    .as_array()
                    .is_some_and(|r| !r.is_empty())
                    || query["data"]["result"]
                        .as_array()
                        .is_some_and(Vec::is_empty)
                {
                    break;
                }
                // Imported samples become searchable within a second or so.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                answer = ask(&client, &base, &path).await;
            }
            assert_eq!(answer["status"], "success", "{file:?}: {promql}\n{answer}");
            let (want, got) = (by_labels(&query["data"]), by_labels(&answer["data"]));
            assert_eq!(
                want.keys().collect::<Vec<_>>(),
                got.keys().collect::<Vec<_>>(),
                "{file:?}: {promql}"
            );
            for (labels, x) in &want {
                let y = got[labels];
                assert!(
                    (x.is_nan() && y.is_nan()) || relative(*x, y) < 1e-6,
                    "{file:?}: {promql}\n{labels}: Prometheus {x}, VictoriaMetrics {y}"
                );
            }
            compared += 1;
            series += want.len();
        }
    }
    eprintln!("{compared} recorded answers ({series} series) matched by VictoriaMetrics");
    // Traffic: Beyla 4, Hubble 3 × 4, Istio 12, Linkerd 11; requests: the Hubble golden query of 3 fixtures.
    assert_eq!(compared, 42);
    assert!(series >= 42, "{series}");
}

/// Labels (as one sorted text) → value of an instant answer.
fn by_labels(data: &Value) -> BTreeMap<String, f64> {
    data["result"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let labels: BTreeMap<String, String> =
                serde_json::from_value(r["metric"].clone()).unwrap();
            let labels: Vec<String> = labels.iter().map(|(k, v)| format!("{k}={v}")).collect();
            (
                labels.join(","),
                r["value"][1].as_str().unwrap().parse().unwrap(),
            )
        })
        .collect()
}
