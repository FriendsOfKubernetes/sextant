use serde_json::{Value, json};

use super::*;

/// The cases shared with the window (`src/resources/nodeArgs.ts`) and the k3s extension (`src/mask.ts`).
const CASES: &str = include_str!("../../../../../src/resources/masking-cases.json");

fn cases(list: &str) -> Vec<Value> {
    let all: Value = serde_json::from_str(CASES).expect("masking cases");
    all[list].as_array().expect("a list of cases").clone()
}

#[test]
fn node_arguments_are_read_and_masked_as_the_window_reads_them() {
    for case in cases("nodeArgs") {
        let name = case["name"].as_str().unwrap_or_default();
        let text = case["text"].as_str().expect("text");
        let args = node_args(text).map(|a| serde_json::to_value(a).expect("arguments"));
        assert_eq!(
            args.as_ref(),
            (!case["args"].is_null()).then_some(&case["args"]),
            "{name}"
        );
        assert_eq!(
            masked_node_args(text).as_deref(),
            case["masked"].as_str(),
            "{name}"
        );
        // What the extension gets reads as the same arguments.
        if let Some(masked) = case["masked"].as_str() {
            assert_eq!(
                node_args(masked).map(|a| serde_json::to_value(a).expect("arguments")),
                Some(case["args"].clone()),
                "{name}"
            );
        }
    }
}

#[test]
fn chart_set_values_are_masked_as_the_extension_masks_them() {
    for case in cases("set") {
        let name = case["name"].as_str().unwrap_or_default();
        assert_eq!(
            masked_set(&case["set"]),
            (!case["masked"].is_null()).then(|| case["masked"].clone()),
            "{name}"
        );
    }
}

#[test]
fn chart_values_are_masked_as_the_extension_masks_them() {
    for case in cases("values") {
        let name = case["name"].as_str().unwrap_or_default();
        let text = case["text"].as_str().expect("text");
        let masked = masked_values_content(text);
        match &case["masked"] {
            Value::Null => assert_eq!(masked, None, "{name}"),
            Value::String(empty) => assert_eq!(masked.as_deref(), Some(empty.as_str()), "{name}"),
            expected => {
                let got: Value = serde_json::from_str(&masked.expect(name)).expect("JSON");
                assert_eq!(&got, expected, "{name}");
            }
        }
    }
}

#[test]
fn a_yaml_tag_or_a_key_that_is_no_text_is_not_given() {
    assert_eq!(masked_values_content("a: !secret x\n"), None);
    assert_eq!(masked_values_content("? [a, b]\n: c\n"), None);
    assert_eq!(masked_values_content("~: c\n"), None);
    assert_eq!(masked_values_content("\"1\": a\n1: b\n"), None);
    assert_eq!(masked_values_content(".inf: x\nv: .nan\n"), None);
    let long = format!("a: \"{}\"\n", "x".repeat(MAX_VALUES_TEXT));
    assert_eq!(masked_values_content(&long), None);
    let words = format!("[\"{}\"]", "x".repeat(MAX_ARGS_TEXT));
    assert_eq!(masked_node_args(&words), None);
}

#[test]
fn names_look_secret_as_the_window_says() {
    for name in [
        "HF_TOKEN",
        "authToken",
        "AWS_ACCESS_KEY_ID",
        "db-password",
        "x.apikey",
        "vpn-auth",
        "dsn",
    ] {
        assert!(looks_secret(name), "{name}");
    }
    for name in [
        "tokenizer",
        "author",
        "monkey",
        "replicas",
        "keyboard",
        "passage",
    ] {
        assert!(!looks_secret(name), "{name}");
    }
}

fn node() -> Value {
    json!({
        "apiVersion": "v1",
        "kind": "Node",
        "metadata": {
            "name": "n",
            "annotations": {
                "k3s.io/node-args": "[\"server\",\"--token\",\"abc\"]",
                "k3s.io/node-env": "{\"K3S_TOKEN\":\"abc\"}",
                "k3s.io/node-config-hash": "H"
            }
        }
    })
}

#[test]
fn an_extension_granted_the_kind_gets_the_masked_arguments_and_never_the_environment() {
    let mut value = node();
    assert!(mask_inline_secrets(
        &mut value,
        &[KindPattern {
            group: String::new(),
            kind: "Node".into()
        }]
    ));
    let annotations = &value["metadata"]["annotations"];
    assert_eq!(
        annotations["k3s.io/node-args"],
        "[\"server\",\"--token=********\"]"
    );
    assert_eq!(annotations["k3s.io/node-env"], "");
    assert_eq!(annotations["k3s.io/node-config-hash"], "H");
    // Every path that held something is named as hidden, so the copy is never saved; the masked one as masked.
    let hidden = annotations[crate::resources::get::VALUES_HIDDEN_ANNOTATION]
        .as_str()
        .unwrap_or_default();
    assert!(
        hidden.contains("k3s.io/node-args") && hidden.contains("k3s.io/node-env"),
        "{hidden}"
    );
    assert_eq!(
        annotations[VALUES_MASKED_ANNOTATION],
        "metadata.annotations[\"k3s.io/node-args\"]"
    );
    assert!(!value.to_string().contains("abc"));
}

#[test]
fn an_extension_not_granted_the_kind_gets_what_any_extension_gets() {
    for granted in [
        vec![],
        vec![KindPattern {
            group: "helm.cattle.io".into(),
            kind: "HelmChart".into(),
        }],
    ] {
        let mut masked = node();
        let mut hidden = node();
        mask_inline_secrets(&mut masked, &granted);
        hide_inline_secrets(&mut hidden);
        assert_eq!(masked, hidden);
    }
}

#[test]
fn what_does_not_read_is_blanked_never_given() {
    let mut value = node();
    value["metadata"]["annotations"]["k3s.io/node-args"] = json!("--token abc");
    mask_inline_secrets(
        &mut value,
        &[KindPattern {
            group: String::new(),
            kind: "Node".into(),
        }],
    );
    assert_eq!(value["metadata"]["annotations"]["k3s.io/node-args"], "");
    assert!(
        value["metadata"]["annotations"]
            .get(VALUES_MASKED_ANNOTATION)
            .is_none()
    );
    assert!(!value.to_string().contains("abc"));
}

#[test]
fn a_chart_gives_its_values_and_set_masked() {
    let mut chart = json!({
        "apiVersion": "helm.cattle.io/v1",
        "kind": "HelmChart",
        "metadata": { "name": "c", "annotations": { "kubectl.kubernetes.io/last-applied-configuration": "{\"spec\":{\"set\":{\"auth.password\":\"p\"}}}" } },
        "spec": { "valuesContent": "password: hunter2\nreplicas: 2\n", "set": { "auth.password": "p", "a": "b" }, "values": { "x": 1 } }
    });
    mask_inline_secrets(
        &mut chart,
        &[KindPattern {
            group: "helm.cattle.io".into(),
            kind: "HelmChart".into(),
        }],
    );
    assert_eq!(
        chart["spec"]["valuesContent"],
        "{\"password\":\"<hidden>\",\"replicas\":2}"
    );
    assert_eq!(
        chart["spec"]["set"],
        json!({ "auth.password": "<hidden>", "a": "b" })
    );
    assert_eq!(chart["spec"]["values"], json!({ "x": 1 }));
    let annotations = &chart["metadata"]["annotations"];
    assert!(
        annotations
            .get("kubectl.kubernetes.io/last-applied-configuration")
            .is_none()
    );
    assert_eq!(
        annotations[VALUES_MASKED_ANNOTATION],
        "spec.valuesContent, spec.set"
    );
    assert!(!chart.to_string().contains("hunter2"));
    // A copy carries the marker replace and apply refuse.
    assert!(
        annotations[crate::resources::get::VALUES_HIDDEN_ANNOTATION]
            .as_str()
            .is_some()
    );
}

#[test]
fn only_nodes_and_helm_controllers_kinds_can_be_masked() {
    assert!(can_mask("", "Node"));
    assert!(can_mask("helm.cattle.io", "HelmChart"));
    assert!(can_mask("helm.cattle.io", "HelmChartConfig"));
    assert!(!can_mask("route.openshift.io", "Route"));
    assert!(!can_mask("operators.coreos.com", "InstallPlan"));
    assert!(!can_mask("", "Secret"));
}
