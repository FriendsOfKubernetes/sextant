use super::*;

fn workload(kind: &str, name: &str) -> RequestTarget {
    RequestTarget::Workload {
        namespace: "shop".into(),
        kind: kind.into(),
        name: name.into(),
    }
}

fn pod(name: &str) -> RequestTarget {
    RequestTarget::Pod {
        namespace: "shop".into(),
        name: name.into(),
    }
}

const SAFE: &str = "[bcdfghjklmnpqrstvwxz2456789]";

#[test]
fn every_source_names_the_workload_by_its_own_labels() {
    let web = workload("Deployment", "web");
    let one = |kind| request_selectors(kind, &web, &["web".into()]);
    assert_eq!(
        one(RequestSourceKind::Istio),
        [
            r#"reporter="destination",destination_workload_namespace="shop",destination_workload="web""#
        ]
    );
    assert_eq!(
        one(RequestSourceKind::Linkerd),
        [format!(
            r#"direction="inbound",namespace="shop",pod=~"web-{SAFE}{{6,10}}-{SAFE}{{5}}""#
        )]
    );
    assert_eq!(
        one(RequestSourceKind::Beyla),
        [format!(
            r#"k8s_namespace_name="shop",k8s_pod_name=~"web-{SAFE}{{6,10}}-{SAFE}{{5}}""#
        )]
    );
    // Hubble's selector names the callee only: which side's report counts is the query's ([`Sides`]).
    assert_eq!(
        one(RequestSourceKind::Hubble),
        [r#"destination_namespace="shop",destination_workload="web""#]
    );
    // The metric's own labels; renamed by a ServiceMonitor without `honorLabels`; the namespace alone renamed by a
    // PodMonitor (its targets have no `service` label).
    assert_eq!(
        one(RequestSourceKind::IngressNginx),
        [
            r#"namespace="shop",service=~"web""#,
            r#"exported_namespace="shop",exported_service=~"web""#,
            r#"exported_namespace="shop",service=~"web""#
        ]
    );
    // Without a Service selecting the pods, ingress-nginx cannot name them.
    assert!(request_selectors(RequestSourceKind::IngressNginx, &web, &[]).is_empty());

    let db = request_selectors(
        RequestSourceKind::Linkerd,
        &workload("StatefulSet", "db"),
        &[],
    );
    assert_eq!(
        db,
        [r#"direction="inbound",namespace="shop",pod=~"db-[0-9]+""#]
    );
    let p = pod("web-0");
    assert_eq!(
        request_selectors(RequestSourceKind::Istio, &p, &[]),
        [r#"reporter="destination",destination_workload_namespace="shop",pod="web-0""#]
    );
    assert_eq!(
        request_selectors(RequestSourceKind::Hubble, &p, &[]),
        [r#"destination_namespace="shop",destination_pod="web-0""#]
    );
    assert_eq!(
        request_selectors(RequestSourceKind::Beyla, &p, &[]),
        [r#"k8s_namespace_name="shop",k8s_pod_name="web-0""#]
    );
}

#[test]
fn names_are_escaped_even_past_validation() {
    // Validation refuses such names first (`validate_target`); the selectors still escape them.
    let odd = RequestTarget::Workload {
        namespace: "a\"b".into(),
        kind: "Deployment".into(),
        name: "x\"} or vector(1) #".into(),
    };
    let istio = request_selectors(RequestSourceKind::Istio, &odd, &[]);
    assert!(
        istio[0].ends_with(
            r#"destination_workload_namespace="a\"b",destination_workload="x\"} or vector(1) #""#
        ),
        "{istio:?}"
    );
    let linkerd = request_selectors(RequestSourceKind::Linkerd, &odd, &[]);
    assert!(
        linkerd[0].contains(r#"pod=~"x\"\\} or vector\\(1\\) #-"#),
        "{linkerd:?}"
    );
    let nginx = request_selectors(
        RequestSourceKind::IngressNginx,
        &pod("p"),
        &["a.b".into(), "c\"d".into()],
    );
    assert_eq!(nginx[0], r#"namespace="shop",service=~"a\\.b|c\"d""#);
    let regex_pod = request_selectors(RequestSourceKind::Beyla, &pod("p\\q"), &[]);
    assert_eq!(
        regex_pod,
        [r#"k8s_namespace_name="shop",k8s_pod_name="p\\q""#]
    );
}

#[test]
fn the_queries_are_fixed() {
    let sel = ["SEL".to_owned()];
    assert_eq!(
        series_query(RequestSourceKind::Linkerd, &sel),
        r#"label_replace((sum(rate(response_total{SEL}[5m]))), "m", "rate", "", "") or label_replace((((sum(rate(response_total{SEL,classification="failure"}[5m]))) or vector(0))), "m", "errors", "", "")"#
    );
    let istio = golden_query(RequestSourceKind::Istio, &sel, true);
    for part in [
        r#"label_replace((sum(rate(istio_requests_total{SEL}[5m]))), "m", "rate", "", "")"#,
        r#"((sum(rate(istio_requests_total{SEL,response_code=~"5.."}[5m]))) or vector(0)) + ((sum(rate(istio_requests_total{SEL,response_code!~"5..",grpc_response_status!~"|0"}[5m]))) or vector(0))"#,
        r#"label_replace(histogram_quantile(0.5, sum by (le) (rate(istio_request_duration_milliseconds_bucket{SEL}[5m]))), "m", "p50", "", "")"#,
        r#""m", "p95""#,
        r#"histogram_quantile(0.99, "#,
    ] {
        assert!(istio.contains(part), "{part}\n{istio}");
    }
    // Without the histogram no quantile is asked.
    assert!(!golden_query(RequestSourceKind::Istio, &sel, false).contains("histogram_quantile"));
    let beyla = golden_query(RequestSourceKind::Beyla, &sel, true);
    assert!(beyla.contains(
        r#"{__name__=~"http_server_request_duration_seconds_count|rpc_server_duration_seconds_count",SEL}"#
    ));
    assert!(beyla.contains(r#"{__name__=~"http_server_request_duration_seconds_bucket|rpc_server_duration_seconds_bucket",SEL}"#));
    // Two alternatives: each asked, the first with series wins.
    let nginx = series_query(
        RequestSourceKind::IngressNginx,
        &["A".to_owned(), "B".to_owned()],
    );
    assert!(nginx.starts_with(
        r#"label_replace((sum(rate(nginx_ingress_controller_requests{A}[5m])) or sum(rate(nginx_ingress_controller_requests{B}[5m]))), "m", "rate""#
    ));
    assert_eq!(
        throttling_query(&HistoryScope::Pod {
            namespace: "shop".into(),
            name: "web-0".into()
        })
        .unwrap(),
        r#"sum by (container) (increase(container_cpu_cfs_throttled_periods_total{container!="",container!="POD",pod!="",namespace="shop",pod="web-0"}[1h])) / sum by (container) (increase(container_cpu_cfs_periods_total{container!="",container!="POD",pod!="",namespace="shop",pod="web-0"}[1h]))"#
    );
}

/// The metric names a query reads: `name{` and the names of a `__name__` regex.
fn metric_names(query: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for (i, _) in query.match_indices('{') {
        let before = &query[..i];
        let start = before
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map_or(0, |p| p + 1);
        if start < i {
            out.insert(before[start..].to_owned());
        }
    }
    for (i, _) in query.match_indices(r#"__name__=~""#) {
        let rest = &query[i + 11..];
        let end = rest.find('"').unwrap();
        out.extend(rest[..end].split('|').map(str::to_owned));
    }
    out
}

#[test]
fn hubble_counts_the_callees_report_and_the_callers_only_where_the_callee_has_none() {
    let sel = [r#"destination_namespace="shop",destination_workload="web""#.to_owned()];
    let pair = HUBBLE_SIDES.pair;
    let query = series_query(RequestSourceKind::Hubble, &sel);
    let callee = format!(
        r#"sum by ({pair}) (rate(hubble_http_requests_total{{{},reporter!="client"}}[5m]))"#,
        sel[0]
    );
    let caller = format!(
        r#"(sum by ({pair}) (rate(hubble_http_requests_total{{{},reporter="client"}}[5m])) unless on({pair}) {callee})"#,
        sel[0]
    );
    assert!(
        query.contains(&format!("sum({callee} or {caller})")),
        "{query}"
    );
    // Errors of the caller's report count only where the callee has no report at all (not merely no errors).
    assert!(
        query.contains(&format!(
            r#"(sum by ({pair}) (rate(hubble_http_requests_total{{{},reporter="client",status=~"5.."}}[5m])) unless on({pair}) {callee})"#,
            sel[0]
        )),
        "{query}"
    );
    let golden = golden_query(RequestSourceKind::Hubble, &sel, true);
    assert!(golden.contains(&format!(r#"sum by (le) (sum by (le,{pair}) (rate(hubble_http_request_duration_seconds_bucket{{{},reporter!="client"}}[5m]))"#, sel[0])), "{golden}");
    assert!(
        golden.contains(&format!(" unless on({pair}) {callee}")),
        "{golden}"
    );
}

#[test]
fn each_source_reads_only_its_own_metrics() {
    for kind in RequestSourceKind::ALL {
        // Caretta (#236) has no request metrics: no selector, so no query is ever built for it.
        if kind.required_metrics().is_empty() {
            let pod = RequestTarget::Pod {
                namespace: "shop".into(),
                name: "web-0".into(),
            };
            assert!(request_selectors(kind, &pod, &[]).is_empty(), "{kind:?}");
            continue;
        }
        let sel = ["x=\"y\"".to_owned()];
        let mut read = metric_names(&golden_query(kind, &sel, true));
        read.extend(metric_names(&series_query(kind, &sel)));
        let shape = shape(kind);
        let allowed: BTreeSet<String> = shape
            .count
            .iter()
            .chain(shape.bucket)
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(read, allowed, "{kind:?}");
        let known = RequestSourceKind::known_metrics();
        assert!(read.iter().all(|n| known.contains(&n.as_str())), "{kind:?}");
    }
}

#[test]
fn a_source_needs_its_metrics() {
    let names = |list: &[&str]| {
        list.iter()
            .map(|s| (*s).to_owned())
            .collect::<BTreeSet<_>>()
    };
    // `response_total` alone is not Linkerd.
    assert!(sources_in(&names(&["response_total"]), RequestVia::Cluster).is_empty());
    let found = sources_in(
        &names(&[
            "response_total",
            "response_latency_ms_bucket",
            "rpc_server_duration_seconds_count",
            "istio_requests_total",
        ]),
        RequestVia::Cluster,
    );
    let kinds: Vec<(RequestSourceKind, bool)> = found.iter().map(|s| (s.kind, s.latency)).collect();
    assert_eq!(
        kinds,
        [
            (RequestSourceKind::Istio, false),
            (RequestSourceKind::Linkerd, true),
            (RequestSourceKind::Beyla, false)
        ]
    );
}
