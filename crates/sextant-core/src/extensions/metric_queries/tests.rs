use serde_json::json;

use super::*;
use crate::extensions::installed::asks_within;
use crate::extensions::parse_manifest;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};
use crate::metrics::PrometheusTarget;

fn manifest_json(queries: Value) -> Value {
    json!({
        "id": "ceph", "name": "Ceph", "version": "1.0.0", "description": "", "author": "Me",
        "sextantApi": 2, "entry": "index.html",
        "permissions": { "clusters": { "type": "all" }, "rules": [] },
        "contributes": { "metricQueries": queries }
    })
}

fn parsed(queries: Value) -> Result<ExtensionManifest, ManifestError> {
    parse_manifest(manifest_json(queries).to_string().as_bytes())
}

fn query(text: &str, params: Value) -> Value {
    json!([{ "id": "q", "title": "Q", "query": text, "params": params }])
}

fn refusal(text: &str, params: Value) -> String {
    let err = parsed(query(text, params)).unwrap_err();
    format!("{}: {}", err.path, err.message)
}

fn one(text: &str, params: Value) -> MetricQuery {
    parsed(query(text, params))
        .unwrap()
        .contributes
        .metric_queries[0]
        .clone()
}

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[test]
fn a_manifest_declares_queries_with_typed_parameters() {
    let m = parsed(json!([{
        "id": "used-bytes",
        "title": "Used capacity",
        "query": "sum(rate(ceph_osd_op_w_in_bytes{namespace=\"{{ns}}\"}[{{window}}]))",
        "params": [{ "name": "ns", "type": "namespace" }, { "name": "window", "type": "duration" }],
        "range": { "maxHours": 24 }
    }]))
    .unwrap();
    let q = &m.contributes.metric_queries[0];
    assert_eq!(q.params[1].kind, MetricParamType::Duration);
    assert_eq!(q.range, Some(MetricRange { max_hours: 24 }));
    // Without parameters and range.
    assert!(parsed(json!([{ "id": "up", "title": "Up", "query": "up" }])).is_ok());
}

#[test]
fn a_template_puts_text_only_into_strings_and_durations_only_outside() {
    let ns = json!([{ "name": "ns", "type": "namespace" }]);
    assert!(refusal("up{namespace={{ns}}}", ns.clone()).contains("goes inside a \"…\" string"));
    assert!(refusal("up{namespace='{{ns}}'}", ns.clone()).contains("only into a \"…\" string"));
    assert!(refusal("up{namespace=`{{ns}}`}", ns.clone()).contains("only into a \"…\" string"));
    let window = json!([{ "name": "w", "type": "duration" }]);
    assert!(refusal("rate(up{a=\"{{w}}\"}[5m])", window.clone()).contains("goes outside strings"));
    assert!(parsed(query("rate(up[{{w}}])", window)).is_ok());
}

#[test]
fn a_template_names_only_its_parameters_and_uses_each() {
    let ns = json!([{ "name": "ns", "type": "namespace" }]);
    assert_eq!(
        refusal("up{namespace=\"{{other}}\"}", ns.clone()),
        "contributes.metricQueries[0].query: `{{other}}` is not a parameter of this query"
    );
    assert_eq!(
        refusal("up", ns.clone()),
        "contributes.metricQueries[0].params[0]: `ns` is not used in the query"
    );
    let twice = json!([{ "name": "ns", "type": "namespace" }, { "name": "ns", "type": "name" }]);
    assert!(refusal("up{namespace=\"{{ns}}\"}", twice).contains("duplicate parameter `ns`"));
    assert!(refusal("up{a=\"{{ ns }}\"}", ns.clone()).contains("not a placeholder"));
    assert!(refusal("up{a=\"{{ns\"}", ns.clone()).contains("not closed by `}}`"));
    assert!(refusal("up{a=\"x}", json!([])).contains("a string is not closed"));
    assert!(refusal("up # {{ns}}", ns).contains("comments"));
}

#[test]
fn queries_need_api_2_and_unique_ids() {
    let mut old = manifest_json(json!([{ "id": "up", "title": "Up", "query": "up" }]));
    old["sextantApi"] = json!(1);
    let err = parse_manifest(old.to_string().as_bytes()).unwrap_err();
    assert_eq!(err.path, "contributes.metricQueries");
    let err = parsed(json!([
        { "id": "up", "title": "Up", "query": "up" },
        { "id": "up", "title": "Up again", "query": "up" }
    ]))
    .unwrap_err();
    assert_eq!(err.path, "contributes.metricQueries[1].id");
}

#[test]
fn values_are_checked_by_type_and_escaped_for_where_they_stand() {
    let q = one(
        "x{namespace=\"{{ns}}\",pod=~\"{{pod}}-.*\",l=\"{{label}}\"}[{{w}}]",
        json!([
            { "name": "ns", "type": "namespace" },
            { "name": "pod", "type": "name" },
            { "name": "label", "type": "labelValue" },
            { "name": "w", "type": "duration" }
        ]),
    );
    let filled = fill(
        &q,
        &values(&[
            ("ns", "rook-ceph"),
            ("pod", "osd.0"),
            ("label", "a\"b\\c"),
            ("w", "5m"),
        ]),
    )
    .unwrap();
    // A regular-expression matcher's value is matched literally; a quote or backslash never ends the string.
    assert_eq!(
        filled,
        r#"x{namespace="rook-ceph",pod=~"osd\\.0-.*",l="a\"b\\c"}[5m]"#
    );
    let refused = |pairs: &[(&str, &str)]| fill(&q, &values(pairs)).unwrap_err().message;
    let good = [("ns", "a"), ("pod", "b"), ("label", "c"), ("w", "5m")];
    let with = |key: &str, value: &'static str| {
        good.iter()
            .map(|(k, v)| if *k == key { (*k, value) } else { (*k, *v) })
            .collect::<Vec<_>>()
    };
    assert!(refused(&with("ns", "Rook")).contains("namespace name"));
    assert!(refused(&with("ns", "a.b")).contains("namespace name"));
    assert!(refused(&with("pod", "")).contains("object name"));
    assert!(refused(&with("label", "a\nb")).contains("control characters"));
    assert!(refused(&with("w", "5m] or vector(1)")).contains("must be one of"));
    assert!(refused(&good[..3]).contains("needs the parameter w"));
    let mut extra = good.to_vec();
    extra.push(("other", "x"));
    assert!(refused(&extra).contains("no parameter \"other\""));
    let long = "x".repeat(MAX_LABEL_VALUE_CHARS + 1);
    let mut too_long = values(&good);
    too_long.insert("label".into(), long);
    assert!(fill(&q, &too_long).is_err());
}

#[test]
fn a_range_is_allowed_only_by_the_manifest_and_within_its_bounds() {
    let mut q = one("up", json!([]));
    let range = |minutes, step: &str| MetricQueryRange {
        minutes,
        step: step.into(),
    };
    assert!(
        range_of(&q, &range(60, "1m"), 10_000)
            .unwrap_err()
            .message
            .contains("instant query")
    );
    q.range = Some(MetricRange { max_hours: 24 });
    assert_eq!(
        range_of(&q, &range(60, "1m"), 10_000).unwrap(),
        (6_400, 10_000, 60)
    );
    assert!(range_of(&q, &range(24 * 60 + 1, "1h"), 10_000).is_err());
    assert!(range_of(&q, &range(0, "1m"), 10_000).is_err());
    assert!(
        range_of(&q, &range(60, "7s"), 10_000)
            .unwrap_err()
            .message
            .contains("one of 15s")
    );
    // 24 h at 15 s are 5760 points.
    assert!(
        range_of(&q, &range(24 * 60, "15s"), 10_000)
            .unwrap_err()
            .message
            .contains("longer step")
    );
    assert!(range_of(&q, &range(24 * 60, "1m"), 10_000).is_ok());
}

#[test]
fn an_answer_keeps_labels_and_numbers_only() {
    let vector = json!({
        "resultType": "vector",
        "result": [
            { "metric": { "__name__": "up", "job": "a" }, "value": [1700000000.5, "1"] },
            { "metric": { "job": "b" }, "value": [1700000000.5, "NaN"] }
        ]
    });
    let answer = read_answer(&vector).unwrap();
    assert_eq!(answer.result_type, MetricResultType::Vector);
    assert_eq!(answer.series[0].labels["job"], "a");
    assert_eq!(answer.series[0].points, vec![(1_700_000_000.5, Some(1.0))]);
    assert_eq!(answer.series[1].points, vec![(1_700_000_000.5, None)]);
    assert!(!answer.truncated);

    let matrix = json!({
        "resultType": "matrix",
        "result": [{ "metric": {}, "values": [[1, "2.5"], [2, "+Inf"], [3, "-3"]] }]
    });
    let answer = read_answer(&matrix).unwrap();
    assert_eq!(answer.result_type, MetricResultType::Matrix);
    assert_eq!(
        answer.series[0].points,
        vec![(1.0, Some(2.5)), (2.0, None), (3.0, Some(-3.0))]
    );

    let scalar = json!({ "resultType": "scalar", "result": [5, "42"] });
    assert_eq!(
        read_answer(&scalar).unwrap().series[0].points,
        vec![(5.0, Some(42.0))]
    );
    let string = json!({ "resultType": "string", "result": [5, "x"] });
    assert!(read_answer(&string).is_err());

    let many: Vec<Value> = (0..MAX_SERIES + 3)
        .map(|i| json!({ "metric": { "i": i.to_string() }, "value": [1, "1"] }))
        .collect();
    let answer = read_answer(&json!({ "resultType": "vector", "result": many })).unwrap();
    assert_eq!(answer.series.len(), MAX_SERIES);
    assert!(answer.truncated);
}

#[test]
fn an_update_with_a_new_or_changed_query_asks_again() {
    let m = parsed(query(
        "up{namespace=\"{{ns}}\"}",
        json!([{ "name": "ns", "type": "namespace" }]),
    ))
    .unwrap();
    let agreed = m.contributes.metric_queries.clone();
    assert!(asks_within(&m, &m.permissions, None, None, Some(&agreed)));
    assert!(!asks_within(&m, &m.permissions, None, None, None));
    let mut changed = agreed.clone();
    changed[0].query = "up".into();
    assert!(!asks_within(&m, &m.permissions, None, None, Some(&changed)));
}

#[tokio::test]
async fn a_query_runs_through_the_service_proxy_with_the_filled_promql() {
    let prom = "/api/v1/namespaces/monitoring/services/prometheus-k8s:9090/proxy";
    let api = FakeApi::start(move |req: &Request| {
        let path = req.path.as_str();
        if path == "/api" {
            Reply::json(200, r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#)
        } else if path == format!("{prom}/api/v1/query") {
            Reply::json(200, r#"{"status":"success","data":{"resultType":"vector","result":[{"metric":{"namespace":"rook-ceph"},"value":[100,"7"]}]}}"#)
        } else if path == format!("{prom}/api/v1/query_range") {
            Reply::json(200, r#"{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[[40,"1"],[100,"2"]]}]}}"#)
        } else {
            Reply::not_found()
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let mode = PrometheusMode::Manual {
        target: PrometheusTarget::Service {
            namespace: "monitoring".into(),
            service: "prometheus-k8s".into(),
            port: 9090,
            path_prefix: String::new(),
        },
    };
    let mut q = one(
        "ceph_health_status{namespace=\"{{ns}}\"}",
        json!([{ "name": "ns", "type": "namespace" }]),
    );
    let ns = values(&[("ns", "rook-ceph")]);
    let answer = run_metric_query(&mgr, &id, &mode, &q, &ns, None, 100)
        .await
        .unwrap();
    assert_eq!(answer.series[0].points, vec![(100.0, Some(7.0))]);
    let sent = api.requests();
    let instant = sent
        .iter()
        .find(|r| r.path.ends_with("/api/v1/query"))
        .unwrap();
    assert!(
        instant
            .query
            .contains("query=ceph_health_status%7Bnamespace%3D%22rook-ceph%22%7D"),
        "{}",
        instant.query
    );
    assert!(instant.query.contains("&time=100&"));

    q.range = Some(MetricRange { max_hours: 1 });
    let range = MetricQueryRange {
        minutes: 1,
        step: "1m".into(),
    };
    let answer = run_metric_query(&mgr, &id, &mode, &q, &ns, Some(&range), 100)
        .await
        .unwrap();
    assert_eq!(answer.result_type, MetricResultType::Matrix);
    let sent = api.requests();
    let ranged = sent
        .iter()
        .find(|r| r.path.ends_with("/api/v1/query_range"))
        .unwrap();
    assert!(
        ranged.query.contains("&start=40&end=100&step=60&"),
        "{}",
        ranged.query
    );

    // Turned off: nothing is asked.
    let err = run_metric_query(&mgr, &id, &PrometheusMode::Off, &q, &ns, None, 100)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}
