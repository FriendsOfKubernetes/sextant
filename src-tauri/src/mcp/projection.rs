//! Compact `list_resources` answers (#301): a namespace of full pods is 130–230 KB, past what agents' clients take, so
//! an agent may ask for `fields` (paths in the grammar of custom columns, ADR-0099) or a `summary` (a fixed set per
//! common kind) instead of whole objects. Both read the object as the agent would get it whole — after `compact`,
//! so Secret values and inline secret fields are already gone — and a path into a Secret's `data`/`stringData` is
//! refused as for custom columns.

use serde_json::{Map, Value, json};
use sextant_core::CoreError;
use sextant_core::ErrorCode;
use sextant_core::settings::custom_columns::{PathStep, is_secret_data_path, parse_field_path};

/// The most paths one call projects.
pub const MAX_FIELDS: usize = 20;
/// The longest value passed on, in characters of its JSON; a longer one is cut and marked.
pub const MAX_VALUE_CHARS: usize = 2000;

/// Parsed `fields`, checked for the kind.
pub struct Fields(Vec<(String, Vec<PathStep>)>);

/// Reads `fields` for `group/kind`: each a path of the custom-column grammar (`.status.phase`,
/// `.spec.containers[0].image`, `.metadata.labels["app.kubernetes.io/name"]`), never into a Secret's values.
pub fn parse_fields(group: &str, kind: &str, fields: &[String]) -> Result<Fields, CoreError> {
    let invalid = |message: String| CoreError::new(ErrorCode::Invalid, message);
    if fields.is_empty() {
        return Err(invalid("`fields` is empty".to_owned()));
    }
    if fields.len() > MAX_FIELDS {
        return Err(invalid(format!("at most {MAX_FIELDS} fields")));
    }
    let mut out = Vec::new();
    for field in fields {
        let field = field.trim();
        let steps = parse_field_path(field).ok_or_else(|| {
            invalid(format!(
                "field {field:?} is not a path such as .status.phase, .spec.containers[0].image or \
                 .metadata.labels[\"app\"] (no wildcards or filters)"
            ))
        })?;
        if is_secret_data_path(group, kind, &steps) {
            return Err(invalid(format!(
                "field {field:?} reads a Secret's values; get_secret_value reads one when the user allows it"
            )));
        }
        out.push((field.to_owned(), steps));
    }
    Ok(Fields(out))
}

/// The value at `steps`, `Null` when the object has none there.
fn at<'a>(value: &'a Value, steps: &[PathStep]) -> Option<&'a Value> {
    steps.iter().try_fold(value, |v, step| match step {
        PathStep::Key(key) => v.get(key),
        PathStep::Index(i) => v.get(*i),
    })
}

/// `value`, or — past [`MAX_VALUE_CHARS`] of JSON — the start of it as text, marked as cut.
fn bounded(value: Value) -> Value {
    let text = value.to_string();
    if text.chars().count() <= MAX_VALUE_CHARS {
        return value;
    }
    json!({ "cut": text.chars().take(MAX_VALUE_CHARS).collect::<String>() })
}

fn identity(obj: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(ns) = obj.pointer("/metadata/namespace").filter(|v| v.is_string()) {
        out.insert("namespace".into(), ns.clone());
    }
    out.insert(
        "name".into(),
        obj.pointer("/metadata/name")
            .cloned()
            .unwrap_or(Value::Null),
    );
    out
}

/// One object as `{namespace, name, values: {path: value}}`.
pub fn project(obj: &Value, fields: &Fields) -> Value {
    let mut out = identity(obj);
    let values: Map<String, Value> = fields
        .0
        .iter()
        .map(|(path, steps)| {
            (
                path.clone(),
                bounded(at(obj, steps).cloned().unwrap_or(Value::Null)),
            )
        })
        .collect();
    out.insert("values".into(), Value::Object(values));
    Value::Object(out)
}

fn ptr(obj: &Value, pointer: &str) -> Value {
    obj.pointer(pointer).cloned().unwrap_or(Value::Null)
}

fn conditions(obj: &Value) -> Value {
    let list: Vec<Value> = obj
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|c| {
                    let mut out = json!({ "type": ptr(c, "/type"), "status": ptr(c, "/status") });
                    if let Some(reason) = c.get("reason").filter(|r| r.is_string()) {
                        out["reason"] = reason.clone();
                    }
                    out
                })
                .collect()
        })
        .unwrap_or_default();
    Value::Array(list)
}

/// A pod's ready containers (`1/2`), restarts and the waiting or terminated reason of a container not running.
fn pod_summary(obj: &Value, out: &mut Map<String, Value>) {
    let statuses = obj
        .pointer("/status/containerStatuses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = obj
        .pointer("/spec/containers")
        .and_then(Value::as_array)
        .map_or(statuses.len(), Vec::len);
    let ready = statuses
        .iter()
        .filter(|s| s.get("ready") == Some(&Value::Bool(true)))
        .count();
    let restarts: u64 = statuses
        .iter()
        .filter_map(|s| s.get("restartCount").and_then(Value::as_u64))
        .sum();
    let reason = statuses.iter().find_map(|s| {
        s.pointer("/state/waiting/reason")
            .or_else(|| s.pointer("/state/terminated/reason"))
            .cloned()
    });
    out.insert("phase".into(), ptr(obj, "/status/phase"));
    out.insert("ready".into(), json!(format!("{ready}/{total}")));
    out.insert("restarts".into(), json!(restarts));
    if let Some(reason) = reason {
        out.insert("reason".into(), reason);
    }
    out.insert("node".into(), ptr(obj, "/spec/nodeName"));
}

fn node_summary(obj: &Value, out: &mut Map<String, Value>) {
    let ready = obj
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|c| c.get("type") == Some(&json!("Ready"))))
        .map(|c| ptr(c, "/status"))
        .unwrap_or(Value::Null);
    let roles: Vec<String> = obj
        .pointer("/metadata/labels")
        .and_then(Value::as_object)
        .map(|labels| {
            labels
                .keys()
                .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    out.insert("ready".into(), ready);
    out.insert("roles".into(), json!(roles));
    out.insert(
        "version".into(),
        ptr(obj, "/status/nodeInfo/kubeletVersion"),
    );
    out.insert(
        "unschedulable".into(),
        json!(obj.pointer("/spec/unschedulable") == Some(&Value::Bool(true))),
    );
}

/// One object as a short summary: its name, age and a fixed set of fields for common kinds (Pod, the workloads,
/// Job, Node, Service, PersistentVolumeClaim, Event); every other kind with its conditions.
pub fn summarize(group: &str, kind: &str, obj: &Value) -> Value {
    let mut out = identity(obj);
    out.insert("created".into(), ptr(obj, "/metadata/creationTimestamp"));
    let mut put = |key: &str, pointer: &str| {
        out.insert(key.into(), ptr(obj, pointer));
    };
    match (group, kind) {
        ("", "Pod") => {}
        ("apps", "Deployment" | "StatefulSet" | "ReplicaSet") => {
            put("replicas", "/spec/replicas");
            put("readyReplicas", "/status/readyReplicas");
            put("updatedReplicas", "/status/updatedReplicas");
            put("availableReplicas", "/status/availableReplicas");
        }
        ("apps", "DaemonSet") => {
            put("desired", "/status/desiredNumberScheduled");
            put("ready", "/status/numberReady");
            put("updated", "/status/updatedNumberScheduled");
            put("available", "/status/numberAvailable");
        }
        ("batch", "Job") => {
            put("completions", "/spec/completions");
            put("active", "/status/active");
            put("succeeded", "/status/succeeded");
            put("failed", "/status/failed");
        }
        ("batch", "CronJob") => {
            put("schedule", "/spec/schedule");
            put("suspend", "/spec/suspend");
            put("lastScheduleTime", "/status/lastScheduleTime");
        }
        ("", "Node") => {}
        ("", "Service") => {
            put("type", "/spec/type");
            put("clusterIP", "/spec/clusterIP");
            put("ports", "/spec/ports");
            put("selector", "/spec/selector");
        }
        ("", "PersistentVolumeClaim") => {
            put("phase", "/status/phase");
            put("capacity", "/status/capacity/storage");
            put("storageClass", "/spec/storageClassName");
            put("volume", "/spec/volumeName");
        }
        ("" | "events.k8s.io", "Event") => {
            put("type", "/type");
            put("reason", "/reason");
            put("message", "/message");
            put("object", "/involvedObject");
            put("count", "/count");
            put("lastTimestamp", "/lastTimestamp");
        }
        _ => {
            out.insert("conditions".into(), conditions(obj));
        }
    }
    match (group, kind) {
        ("", "Pod") => pod_summary(obj, &mut out),
        ("", "Node") => node_summary(obj, &mut out),
        ("apps", _) | ("batch", "Job") => {
            out.insert("conditions".into(), conditions(obj));
        }
        _ => {}
    }
    Value::Object(out.into_iter().map(|(k, v)| (k, bounded(v))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod() -> Value {
        json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "web-1", "namespace": "team-a", "creationTimestamp": "2026-10-28T10:00:00Z",
                          "labels": { "app.kubernetes.io/name": "web" } },
            "spec": { "nodeName": "node-1", "containers": [{ "name": "app", "image": "web:1" }, { "name": "proxy" }] },
            "status": { "phase": "Running", "containerStatuses": [
                { "name": "app", "ready": true, "restartCount": 2, "state": { "running": {} } },
                { "name": "proxy", "ready": false, "restartCount": 7,
                  "state": { "waiting": { "reason": "CrashLoopBackOff" } } },
            ] },
        })
    }

    #[test]
    fn fields_read_the_custom_column_grammar_and_never_a_secrets_values() {
        let fields = parse_fields(
            "",
            "Pod",
            &[
                ".status.phase".to_owned(),
                ".spec.containers[0].image".to_owned(),
                ".metadata.labels[\"app.kubernetes.io/name\"]".to_owned(),
                ".spec.missing".to_owned(),
            ],
        )
        .unwrap();
        assert_eq!(
            project(&pod(), &fields),
            json!({ "namespace": "team-a", "name": "web-1", "values": {
                ".status.phase": "Running",
                ".spec.containers[0].image": "web:1",
                ".metadata.labels[\"app.kubernetes.io/name\"]": "web",
                ".spec.missing": null,
            } })
        );
        assert!(parse_fields("", "Secret", &[".data.password".to_owned()]).is_err());
        assert!(parse_fields("", "Secret", &[".stringData".to_owned()]).is_err());
        assert!(parse_fields("", "Pod", &[".spec.containers[*].image".to_owned()]).is_err());
        assert!(parse_fields("", "Pod", &[]).is_err());
        let many: Vec<String> = (0..=MAX_FIELDS).map(|i| format!(".a{i}")).collect();
        assert!(parse_fields("", "Pod", &many).is_err());
    }

    #[test]
    fn a_long_value_is_cut_and_marked() {
        let mut obj = pod();
        obj["spec"]["big"] = json!("x".repeat(MAX_VALUE_CHARS * 2));
        let fields = parse_fields("", "Pod", &[".spec.big".to_owned()]).unwrap();
        let value = &project(&obj, &fields)["values"][".spec.big"];
        assert_eq!(
            value["cut"].as_str().unwrap().chars().count(),
            MAX_VALUE_CHARS
        );
    }

    #[test]
    fn a_pod_summary_says_what_is_wrong() {
        assert_eq!(
            summarize("", "Pod", &pod()),
            json!({ "namespace": "team-a", "name": "web-1", "created": "2026-10-28T10:00:00Z",
                    "phase": "Running", "ready": "1/2", "restarts": 9, "reason": "CrashLoopBackOff",
                    "node": "node-1" })
        );
        let deployment = json!({
            "metadata": { "name": "web", "namespace": "team-a" },
            "spec": { "replicas": 3 },
            "status": { "readyReplicas": 2, "conditions": [
                { "type": "Available", "status": "False", "reason": "MinimumReplicasUnavailable", "message": "long" },
            ] },
        });
        let out = summarize("apps", "Deployment", &deployment);
        assert_eq!(out["replicas"], 3);
        assert_eq!(out["readyReplicas"], 2);
        assert_eq!(
            out["conditions"],
            json!([{ "type": "Available", "status": "False", "reason": "MinimumReplicasUnavailable" }])
        );
        let custom = summarize(
            "example.com",
            "Widget",
            &json!({ "metadata": { "name": "w" } }),
        );
        assert_eq!(custom["conditions"], json!([]));
    }
}
