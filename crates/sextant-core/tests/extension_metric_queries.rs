//! Extension metric queries (#318, ADR-0138) against the kind test cluster's Prometheus fixture (`scripts/test-cluster.sh
//! up --prometheus`): a template with every parameter type is filled, sent through the service proxy and answered by a
//! real Prometheus, as an instant and as a range query; a value that tries to leave its string matches nothing instead.
//! Read-only; returns early (and passes) without the cluster or the fixture.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test extension_metric_queries
//! ```

mod common;

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use k8s_openapi::api::core::v1::Service;
use kube::Api;
use serde_json::json;
use sextant_core::extensions::metric_queries::{
    MetricQuery, MetricQueryRange, MetricResultType, run_metric_query,
};
use sextant_core::metrics::{PrometheusMode, PrometheusTarget};

fn fixture_mode() -> PrometheusMode {
    PrometheusMode::Manual {
        target: PrometheusTarget::Service {
            namespace: "monitoring".into(),
            service: "prometheus-operated".into(),
            port: 9090,
            path_prefix: String::new(),
        },
    }
}

async fn has_prometheus(client: &kube::Client) -> bool {
    let services: Api<Service> = Api::namespaced(client.clone(), "monitoring");
    let found = services
        .get_opt("prometheus-operated")
        .await
        .ok()
        .flatten()
        .is_some();
    if !found {
        eprintln!("skipped: the Prometheus fixture is not installed");
    }
    found
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

fn values(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

#[tokio::test]
async fn a_filled_query_is_answered_by_a_real_prometheus() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let client = cluster.client().await;
    if !has_prometheus(&client).await {
        return;
    }
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    // Every parameter type (cAdvisor series of the fixture: `namespace`, `pod` and `job` labels): a namespace in a string,
    // a name in a regular-expression matcher, a label value, a duration.
    let query: MetricQuery = serde_json::from_value(json!({
        "id": "scrapes",
        "title": "Scrapes",
        "query": "count by (namespace) (count_over_time(container_memory_working_set_bytes{namespace=\"{{ns}}\",pod=~\"{{pod}}.*\",job!=\"{{job}}\"}[{{w}}]))",
        "params": [
            { "name": "ns", "type": "namespace" },
            { "name": "pod", "type": "name" },
            { "name": "job", "type": "labelValue" },
            { "name": "w", "type": "duration" }
        ],
        "range": { "maxHours": 1 }
    }))
    .unwrap();
    let mode = fixture_mode();
    let good = values(&[
        ("ns", "monitoring"),
        ("pod", "prometheus"),
        ("job", "none"),
        ("w", "5m"),
    ]);
    let answer = run_metric_query(&mgr, &id, &mode, &query, &good, None, now())
        .await
        .unwrap();
    assert_eq!(answer.result_type, MetricResultType::Vector);
    assert_eq!(answer.series.len(), 1, "{answer:?}");
    assert_eq!(answer.series[0].labels["namespace"], "monitoring");

    let range = MetricQueryRange {
        minutes: 30,
        step: "1m".into(),
    };
    let answer = run_metric_query(&mgr, &id, &mode, &query, &good, Some(&range), now())
        .await
        .unwrap();
    assert_eq!(answer.result_type, MetricResultType::Matrix);
    assert!(!answer.series.is_empty());
    assert!(answer.series[0].points.len() <= 31);

    // A label value that would close its string and add a matcher stays inside it: Prometheus parses the query and
    // finds no job of that name to exclude, so the answer is the same.
    let escaping = values(&[
        ("ns", "monitoring"),
        ("pod", "prometheus"),
        ("job", "x\"} or vector(1) or up{job=\""),
        ("w", "5m"),
    ]);
    let answer = run_metric_query(&mgr, &id, &mode, &query, &escaping, None, now())
        .await
        .unwrap();
    assert_eq!(answer.series.len(), 1, "{answer:?}");
    assert_eq!(answer.series[0].labels["namespace"], "monitoring");
    // A regular-expression value is matched literally: unescaped, `promethe.s.*` would match `prometheus-…`.
    let literal = values(&[
        ("ns", "monitoring"),
        ("pod", "promethe.s"),
        ("job", "none"),
        ("w", "5m"),
    ]);
    let answer = run_metric_query(&mgr, &id, &mode, &query, &literal, None, now())
        .await
        .unwrap();
    assert!(answer.series.is_empty(), "{answer:?}");
}
