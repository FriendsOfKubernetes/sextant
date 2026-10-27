//! Secret material some kinds carry inline, outside a core Secret (ADR-0120, ADR-0121, ADR-0123): a Route's private
//! key, a BuildConfig's webhook secrets, a HelmChart's values, an InstallPlan's manifests, a k3s/RKE2 node's arguments
//! and environment. The core hides a core Secret's values in every object it hands out (`get::to_json`); these fields
//! it cannot hide there, since the window's YAML view and editor need the object as it is. So they are hidden where
//! an object leaves for someone the user did not show it to:
//!
//! - an agent's object reads and writes (`get_resource` keeps them only with "Secret values", like a Secret's values;
//!   `list_resources`, `patch_resource` and dry runs never) and an extension's (`resources.get|list|watch|patch`,
//!   never: an extension gets no Secret value from those either);
//! - the change timeline: the window never keeps or shows their values (`src/resources/inlineSecrets.ts`, the
//!   projection of `src/features/timeline/model.ts`), and [`crate::timeline::save`] and the agents' recent changes drop
//!   any value recorded under them.
//!
//! [`INLINE_SECRETS`] is the one table, equal to `src/resources/inline-secrets.json` (a test on each side), each entry
//! with the upstream type it is read from. A hidden value becomes `""` (a map's values each `""`, the keys stay), the
//! last-applied manifest goes (it repeats them) and [`VALUES_HIDDEN_ANNOTATION`] names the hidden paths: an object
//! carrying it is refused by replace and apply, so a hidden copy is never saved over the real one.

use serde_json::{Map, Value};

use super::get::{LAST_APPLIED_ANNOTATION, VALUES_HIDDEN_ANNOTATION};
use super::{WatchObject, WatchUpdate};

/// The secret paths of one kind (any version). A path is field names from the object's root; `*` is every item of a
/// list (or every value of a map).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InlineSecretKind {
    pub group: &'static str,
    pub kind: &'static str,
    pub paths: &'static [&'static [&'static str]],
}

/// Every kind with secret material inline. Kept equal to `kinds` of `src/resources/inline-secrets.json`.
pub const INLINE_SECRETS: &[InlineSecretKind] = &[
    // openshift/api route/v1/types.go `TLSConfig.Key` ("key provides key file contents"). `certificate`,
    // `caCertificate` and `destinationCACertificate` are certificates, public by nature, and stay.
    InlineSecretKind {
        group: "route.openshift.io",
        kind: "Route",
        paths: &[&["spec", "tls", "key"]],
    },
    // openshift/api build/v1/types.go `BuildTriggerPolicy` (`github`, `generic`, `gitlab`, `bitbucket`, each a
    // `WebHookTrigger`) and `WebHookTrigger.Secret`, the deprecated inline webhook secret (`secretReference` names a
    // Secret instead and stays).
    InlineSecretKind {
        group: "build.openshift.io",
        kind: "BuildConfig",
        paths: &[
            &["spec", "triggers", "*", "github", "secret"],
            &["spec", "triggers", "*", "generic", "secret"],
            &["spec", "triggers", "*", "gitlab", "secret"],
            &["spec", "triggers", "*", "bitbucket", "secret"],
        ],
    },
    // k3s-io/helm-controller pkg/apis/helm.cattle.io/v1/types.go `HelmChartSpec.ValuesContent` (YAML a person
    // wrote) and `HelmChartSpec.Set` (`--set key=value`); either may hold a password.
    InlineSecretKind {
        group: "helm.cattle.io",
        kind: "HelmChart",
        paths: &[&["spec", "valuesContent"], &["spec", "set"]],
    },
    // The same file, `HelmChartConfigSpec.ValuesContent`: values merged into a bundled chart's.
    InlineSecretKind {
        group: "helm.cattle.io",
        kind: "HelmChartConfig",
        paths: &[&["spec", "valuesContent"]],
    },
    // operator-framework/api pkg/operators/v1alpha1/installplan_types.go `InstallPlanStatus.Plan` → `Step.Resource`
    // → `StepResource.Manifest`: the JSON of every object the plan creates, a Secret's data included. Every manifest
    // is hidden, not only a Secret's: the objects themselves can be read, a Secret's without its values.
    InlineSecretKind {
        group: "operators.coreos.com",
        kind: "InstallPlan",
        paths: &[&["status", "plan", "*", "resource", "manifest"]],
    },
    // k3s-io/k3s pkg/nodeconfig/nodeconfig.go `NodeArgsAnnotation` / `NodeEnvAnnotation` (`version.Program +
    // ".io/node-args"`, `".io/node-env"`; RKE2 builds the same code with the program `rke2`): the server's flags and
    // `K3S_*` environment, which hold the join token and the datastore endpoint (older releases did not mask them).
    InlineSecretKind {
        group: "",
        kind: "Node",
        paths: &[
            &["metadata", "annotations", "k3s.io/node-args"],
            &["metadata", "annotations", "rke2.io/node-args"],
            &["metadata", "annotations", "k3s.io/node-env"],
            &["metadata", "annotations", "rke2.io/node-env"],
        ],
    },
];

/// The secret paths of `group`/`kind`; empty for a kind without any.
pub fn inline_secret_paths(group: &str, kind: &str) -> &'static [&'static [&'static str]] {
    INLINE_SECRETS
        .iter()
        .find(|k| k.group == group && k.kind == kind)
        .map_or(&[], |k| k.paths)
}

/// Whether objects of `group`/`kind` carry secret material inline.
pub fn has_inline_secrets(group: &str, kind: &str) -> bool {
    !inline_secret_paths(group, kind).is_empty()
}

/// The group and kind of an object as JSON (`apiVersion` `route.openshift.io/v1` → `route.openshift.io`, `v1` → ``).
fn group_kind(value: &Value) -> Option<(&str, &str)> {
    let api_version = value.get("apiVersion")?.as_str()?;
    let kind = value.get("kind")?.as_str()?;
    let group = api_version.rsplit_once('/').map_or("", |(group, _)| group);
    Some((group, kind))
}

/// Hides the inline secret material of an object as JSON (see the module): every value at one of its kind's paths
/// becomes `""` (a map's values each `""`), the last-applied annotation goes and [`VALUES_HIDDEN_ANNOTATION`] names
/// what was hidden. Returns whether anything changed; an object of another kind is left as it is.
pub fn hide_inline_secrets(value: &mut Value) -> bool {
    hide(value, true)
}

/// [`hide_inline_secrets`] without the marker: for two versions of an object that are only compared (a dry run's
/// sides), where Sextant's own annotation would read as a change.
pub fn blank_inline_secrets(value: &mut Value) -> bool {
    hide(value, false)
}

fn hide(value: &mut Value, marked: bool) -> bool {
    let Some((group, kind)) = group_kind(value) else {
        return false;
    };
    let paths = inline_secret_paths(group, kind);
    if paths.is_empty() {
        return false;
    }
    let mut hidden = Vec::new();
    for path in paths {
        if blank_at(value, path) {
            hidden.push(shown_path(path));
        }
    }
    let annotations = value
        .pointer_mut("/metadata/annotations")
        .and_then(Value::as_object_mut);
    let last_applied = annotations
        .and_then(|a| a.remove(LAST_APPLIED_ANNOTATION))
        .is_some();
    if hidden.is_empty() && !last_applied {
        return false;
    }
    if hidden.is_empty() {
        hidden.push(LAST_APPLIED_ANNOTATION.to_owned());
    }
    if marked {
        mark(value, &hidden.join(", "));
    }
    true
}

/// A watch update with [`hide_inline_secrets`] applied to every object it carries (an extension's
/// `resources.watch`). Objects of a kind without inline secrets are passed on as they are, still shared.
pub fn hide_in_watch_update(update: WatchUpdate) -> WatchUpdate {
    let hide_all = |items: Vec<WatchObject>| -> Vec<WatchObject> {
        items
            .into_iter()
            .filter_map(|item| {
                let mut value = item.to_value();
                if !hide_inline_secrets(&mut value) {
                    return Some(item);
                }
                // A JSON value always serializes; were it not to, the object is left out, never sent as it was.
                WatchObject::new(&value).ok()
            })
            .collect()
    };
    match update {
        WatchUpdate::Snapshot { items } => WatchUpdate::Snapshot {
            items: hide_all(items),
        },
        WatchUpdate::Delta { upserted, deleted } => WatchUpdate::Delta {
            upserted: hide_all(upserted),
            deleted,
        },
        WatchUpdate::SnapshotPart { items } => WatchUpdate::SnapshotPart {
            items: hide_all(items),
        },
        WatchUpdate::SnapshotEnd { items, deleted } => WatchUpdate::SnapshotEnd {
            items: hide_all(items),
            deleted,
        },
        other => other,
    }
}

/// `spec.triggers[*].github.secret`, `metadata.annotations["k3s.io/node-args"]`.
fn shown_path(path: &[&str]) -> String {
    let mut out = String::new();
    for segment in path {
        if *segment == "*" {
            out.push_str("[*]");
        } else if segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            if !out.is_empty() {
                out.push('.');
            }
            out.push_str(segment);
        } else {
            out.push('[');
            out.push_str(&Value::String((*segment).to_owned()).to_string());
            out.push(']');
        }
    }
    out
}

/// Blanks what is at `path` under `value`; whether a non-empty value was there.
fn blank_at(value: &mut Value, path: &[&str]) -> bool {
    let Some((first, rest)) = path.split_first() else {
        return blank(value);
    };
    match (value, *first) {
        (Value::Array(items), "*") => items
            .iter_mut()
            .fold(false, |found, item| blank_at(item, rest) | found),
        (Value::Object(map), "*") => map
            .values_mut()
            .fold(false, |found, item| blank_at(item, rest) | found),
        (Value::Object(map), key) => map.get_mut(key).is_some_and(|child| blank_at(child, rest)),
        _ => false,
    }
}

/// A value as `""`, a map's values each as `""` (its keys stay, as a Secret's do); whether it held anything.
fn blank(value: &mut Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(text) if text.is_empty() => false,
        Value::Object(map) => {
            let mut found = false;
            for v in map.values_mut() {
                found |= !matches!(v, Value::Null) && v.as_str() != Some("");
                *v = Value::String(String::new());
            }
            found
        }
        other => {
            *other = Value::String(String::new());
            true
        }
    }
}

fn mark(value: &mut Value, hidden: &str) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    let meta = map
        .entry("metadata")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(meta) = meta.as_object_mut() else {
        return;
    };
    let annotations = meta
        .entry("annotations")
        .or_insert_with(|| Value::Object(Map::new()));
    if !annotations.is_object() {
        *annotations = Value::Object(Map::new());
    }
    if let Some(annotations) = annotations.as_object_mut() {
        annotations.insert(
            VALUES_HIDDEN_ANNOTATION.into(),
            Value::String(hidden.to_owned()),
        );
    }
}

/// The segments of a recorded-change path as the window's timeline writes them (`spec.triggers[0].github.secret`,
/// `metadata.annotations["k3s.io/node-args"]`, `spec.template.spec.containers[web].image`): plain names after `.`,
/// JSON strings and list positions or item names in `[]`. `None` when it does not read as one.
fn path_segments(path: &str) -> Option<Vec<String>> {
    let mut out = Vec::new();
    let mut rest = path;
    while !rest.is_empty() {
        if let Some(inner) = rest.strip_prefix('[') {
            if inner.starts_with('"') {
                // A JSON string up to its closing quote, then `]`.
                let mut stream = serde_json::Deserializer::from_str(inner).into_iter::<String>();
                let key = stream.next()?.ok()?;
                let used = stream.byte_offset();
                out.push(key);
                rest = inner[used..].strip_prefix(']')?;
            } else {
                let end = inner.find(']')?;
                out.push(inner[..end].to_owned());
                rest = &inner[end + 1..];
            }
        } else {
            let plain = rest.strip_prefix('.').unwrap_or(rest);
            let end = plain.find(['.', '[']).unwrap_or(plain.len());
            if end == 0 {
                return None;
            }
            out.push(plain[..end].to_owned());
            rest = &plain[end..];
        }
    }
    Some(out)
}

/// Whether a recorded change at `path` of an object of `group`/`kind` is, holds or lies under one of its secret
/// paths: its values must not be kept or shown. A path that does not read is taken as one.
pub fn is_inline_secret_path(group: &str, kind: &str, path: &str) -> bool {
    let paths = inline_secret_paths(group, kind);
    if paths.is_empty() {
        return false;
    }
    let Some(segments) = path_segments(path) else {
        return true;
    };
    paths.iter().any(|secret| {
        secret
            .iter()
            .zip(&segments)
            .all(|(want, got)| *want == "*" || want == got)
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// The table and the cases `src/resources/inlineSecrets.ts` passes too (`src/resources/inlineSecrets.test.ts`).
    const SHARED: &str = include_str!("../../../../src/resources/inline-secrets.json");

    #[test]
    fn the_table_is_the_one_the_window_has() {
        let shared: Value = serde_json::from_str(SHARED).unwrap();
        let ours: Vec<Value> = INLINE_SECRETS
            .iter()
            .map(|k| json!({ "group": k.group, "kind": k.kind, "paths": k.paths }))
            .collect();
        assert_eq!(Value::Array(ours), shared["kinds"]);
    }

    #[test]
    fn recorded_paths_are_told_as_the_window_tells_them() {
        let shared: Value = serde_json::from_str(SHARED).unwrap();
        let mut failed = Vec::new();
        for case in shared["paths"].as_array().unwrap() {
            let (group, kind, path) = (
                case["group"].as_str().unwrap(),
                case["kind"].as_str().unwrap(),
                case["path"].as_str().unwrap(),
            );
            let want = case["secret"].as_bool().unwrap();
            if is_inline_secret_path(group, kind, path) != want {
                failed.push(format!("{group}/{kind} {path}: want {want}"));
            }
        }
        assert!(failed.is_empty(), "{failed:#?}");
        // A path that does not read is taken as secret, only for a kind of the table.
        assert!(is_inline_secret_path(
            "route.openshift.io",
            "Route",
            "spec..x"
        ));
        assert!(!is_inline_secret_path("apps", "Deployment", "spec..x"));
    }

    #[test]
    fn a_routes_key_is_hidden_and_its_certificates_stay() {
        let mut route = json!({
            "apiVersion": "route.openshift.io/v1",
            "kind": "Route",
            "metadata": { "name": "web", "annotations": {
                LAST_APPLIED_ANNOTATION: "{\"spec\":{\"tls\":{\"key\":\"-----BEGIN PRIVATE KEY-----\"}}}",
                "team": "a",
            } },
            "spec": { "host": "web.example.com", "tls": {
                "termination": "edge",
                "key": "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
                "certificate": "-----BEGIN CERTIFICATE-----",
                "caCertificate": "-----BEGIN CERTIFICATE-----ca",
                "destinationCACertificate": "-----BEGIN CERTIFICATE-----dest",
            } },
        });

        assert!(hide_inline_secrets(&mut route));

        assert_eq!(route["spec"]["tls"]["key"], "");
        assert_eq!(
            route["spec"]["tls"]["certificate"],
            "-----BEGIN CERTIFICATE-----"
        );
        assert_eq!(
            route["spec"]["tls"]["caCertificate"],
            "-----BEGIN CERTIFICATE-----ca"
        );
        assert_eq!(
            route["spec"]["tls"]["destinationCACertificate"],
            "-----BEGIN CERTIFICATE-----dest"
        );
        let annotations = &route["metadata"]["annotations"];
        assert!(annotations.get(LAST_APPLIED_ANNOTATION).is_none());
        assert_eq!(annotations["team"], "a");
        assert_eq!(annotations[VALUES_HIDDEN_ANNOTATION], "spec.tls.key");
        assert!(!route.to_string().contains("PRIVATE KEY"));
        // Hidden again: nothing left to hide.
        assert!(!hide_inline_secrets(&mut route));
    }

    #[test]
    fn every_table_path_is_hidden() {
        let mut config = json!({
            "apiVersion": "build.openshift.io/v1",
            "kind": "BuildConfig",
            "metadata": { "name": "app" },
            "spec": { "triggers": [
                { "type": "GitHub", "github": { "secret": "gh-s3cret" } },
                { "type": "Generic", "generic": { "secret": "gen-s3cret", "allowEnv": true } },
                { "type": "GitLab", "gitlab": { "secretReference": { "name": "hook" } } },
                { "type": "Bitbucket", "bitbucket": { "secret": "bb-s3cret" } },
                { "type": "ConfigChange" },
            ] },
        });
        assert!(hide_inline_secrets(&mut config));
        assert!(!config.to_string().contains("s3cret"), "{config}");
        assert_eq!(config["spec"]["triggers"][1]["generic"]["allowEnv"], true);
        assert_eq!(
            config["spec"]["triggers"][2]["gitlab"]["secretReference"]["name"],
            "hook"
        );
        assert_eq!(
            config["metadata"]["annotations"][VALUES_HIDDEN_ANNOTATION],
            "spec.triggers[*].github.secret, spec.triggers[*].generic.secret, spec.triggers[*].bitbucket.secret"
        );

        let mut chart = json!({
            "apiVersion": "helm.cattle.io/v1",
            "kind": "HelmChart",
            "metadata": { "name": "traefik", "namespace": "kube-system" },
            "spec": {
                "chart": "traefik",
                "valuesContent": "auth:\n  password: s3cret\n",
                "set": { "global.password": "s3cret", "replicas": 2 },
            },
        });
        assert!(hide_inline_secrets(&mut chart));
        assert!(!chart.to_string().contains("s3cret"), "{chart}");
        assert_eq!(chart["spec"]["chart"], "traefik");
        assert_eq!(
            chart["spec"]["set"],
            json!({ "global.password": "", "replicas": "" })
        );

        let mut plan = json!({
            "apiVersion": "operators.coreos.com/v1alpha1",
            "kind": "InstallPlan",
            "metadata": { "name": "install-abc", "namespace": "operators" },
            "spec": { "approved": false },
            "status": { "plan": [
                { "resolving": "etcd.v0.9.4", "status": "Created", "resource": {
                    "kind": "Secret", "name": "etcd-webhook",
                    "manifest": "{\"kind\":\"Secret\",\"data\":{\"tls.key\":\"czNjcmV0\"}}",
                } },
                { "resolving": "etcd.v0.9.4", "status": "Present", "resource": { "kind": "ServiceAccount", "name": "etcd" } },
            ] },
        });
        assert!(hide_inline_secrets(&mut plan));
        assert!(!plan.to_string().contains("czNjcmV0"), "{plan}");
        assert_eq!(
            plan["status"]["plan"][0]["resource"]["name"],
            "etcd-webhook"
        );

        let mut node = json!({
            "apiVersion": "v1",
            "kind": "Node",
            "metadata": { "name": "server-0", "annotations": {
                "k3s.io/node-args": "[\"server\",\"--token\",\"K10s3cret\"]",
                "k3s.io/node-env": "{\"K3S_TOKEN\":\"K10s3cret\"}",
                "k3s.io/node-config-hash": "ABC",
            } },
        });
        assert!(hide_inline_secrets(&mut node));
        assert!(!node.to_string().contains("s3cret"), "{node}");
        assert_eq!(
            node["metadata"]["annotations"]["k3s.io/node-config-hash"],
            "ABC"
        );
    }

    #[test]
    fn other_kinds_and_objects_without_the_fields_are_left_alone() {
        let deployment = json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "d", "annotations": { LAST_APPLIED_ANNOTATION: "{}" } },
            "spec": { "tls": { "key": "k" } },
        });
        let mut copy = deployment.clone();
        assert!(!hide_inline_secrets(&mut copy));
        assert_eq!(copy, deployment);

        // The same kind name of another group is another kind.
        let other = json!({ "apiVersion": "example.com/v1", "kind": "Route", "spec": { "tls": { "key": "k" } } });
        let mut copy = other.clone();
        assert!(!hide_inline_secrets(&mut copy));
        assert_eq!(copy, other);

        let plain = json!({
            "apiVersion": "route.openshift.io/v1", "kind": "Route",
            "metadata": { "name": "web" }, "spec": { "host": "web.example.com" },
        });
        let mut copy = plain.clone();
        assert!(!hide_inline_secrets(&mut copy));
        assert_eq!(copy, plain);

        // A last-applied manifest alone still goes (it may repeat the fields), and says so.
        let mut applied = json!({
            "apiVersion": "v1", "kind": "Node",
            "metadata": { "name": "n", "annotations": { LAST_APPLIED_ANNOTATION: "{}" } },
        });
        assert!(hide_inline_secrets(&mut applied));
        assert_eq!(
            applied["metadata"]["annotations"],
            json!({ VALUES_HIDDEN_ANNOTATION: LAST_APPLIED_ANNOTATION })
        );
    }

    #[test]
    fn a_watch_update_carries_hidden_objects_and_shares_the_others() {
        let route = WatchObject::new(&json!({
            "apiVersion": "route.openshift.io/v1", "kind": "Route",
            "metadata": { "name": "web", "uid": "u1" },
            "spec": { "tls": { "key": "private" } },
        }))
        .unwrap();
        let plain = WatchObject::new(&json!({
            "apiVersion": "route.openshift.io/v1", "kind": "Route",
            "metadata": { "name": "other", "uid": "u2" },
            "spec": { "host": "x" },
        }))
        .unwrap();
        let WatchUpdate::Snapshot { items } = hide_in_watch_update(WatchUpdate::Snapshot {
            items: vec![route.clone(), plain.clone()],
        }) else {
            panic!("a snapshot stays a snapshot");
        };
        assert!(!items[0].json().contains("private"), "{}", items[0].json());
        assert_eq!(items[0].to_value()["spec"]["tls"]["key"], "");
        assert!(items[1].same(&plain));
        let WatchUpdate::Delta { upserted, deleted } = hide_in_watch_update(WatchUpdate::Delta {
            upserted: vec![route],
            deleted: vec!["u3".into()],
        }) else {
            panic!("a delta stays a delta");
        };
        assert!(!upserted[0].json().contains("private"));
        assert_eq!(deleted, ["u3"]);
        assert_eq!(
            hide_in_watch_update(WatchUpdate::Reconnecting),
            WatchUpdate::Reconnecting
        );
    }

    #[test]
    fn blanking_for_a_comparison_adds_no_marker() {
        let mut route = json!({
            "apiVersion": "route.openshift.io/v1", "kind": "Route",
            "metadata": { "name": "web" },
            "spec": { "tls": { "key": "k" } },
        });
        assert!(blank_inline_secrets(&mut route));
        assert_eq!(route["spec"]["tls"]["key"], "");
        assert!(route["metadata"].get("annotations").is_none());
    }

    #[test]
    fn a_hidden_copy_is_never_saved_back() {
        let mut route = json!({
            "apiVersion": "route.openshift.io/v1", "kind": "Route",
            "metadata": { "name": "web", "namespace": "a" },
            "spec": { "tls": { "key": "k" } },
        });
        assert!(hide_inline_secrets(&mut route));
        assert!(super::super::get::ensure_values_present(&route).is_err());
    }
}
