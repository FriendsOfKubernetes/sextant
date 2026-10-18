//! What an agent gets back from `apply_yaml` / `patch_resource` with `dryRun: true` (#141): per object what the API
//! server would do (create, update, unchanged or the refusal) and the fields that would change, `path: before →
//! after`, each line clipped like the activity log. Both sides come from the core's dry run, where a Secret has no
//! values.
//!
//! A core Secret's dry run needs "Secret values" (ADR-0043, #169), and its result does not depend on whether a value
//! the call names equals the live one: the change is `create`, `write` or `refused` — never `update` or `unchanged` —
//! `data`/`stringData` are left out of the field changes, and `writtenKeys` lists the keys the call's own input names.
//! An agent with "Secret values" can read the values anyway, so this is defence in depth. What the API server says
//! apart from that (validation, the 1 MiB size limit, an admission webhook) is passed on as it is.

use serde_json::{Value, json};
use sextant_core::resources::{DryRunChange, DryRunObject, PatchType, field_changes};

use super::audit::clip;
use super::tools_read::describe;

/// At most this many changed fields per object; the rest is counted.
pub const MAX_FIELDS: usize = 50;

/// Said with every dry run, so the agent does not take it for the change itself.
pub const NOTE: &str = "Dry run: nothing was changed. The API server checked the change with dryRun=All (defaulting, \
admission webhooks and validation included); repeat the call without dryRun to make it. Secret values are never \
shown; for a Secret the result lists the keys the call names and does not say whether their values would differ.";

/// The agent's view of a dry run. `named[i]` — for a core Secret, the keys of its values the call names (from
/// [`document_keys`] or [`patch_keys`]); ignored for other kinds.
pub fn summary(objects: &[DryRunObject], named: &[Vec<String>]) -> Value {
    json!({
        "dryRun": true,
        "note": NOTE,
        "objects": objects
            .iter()
            .enumerate()
            .map(|(i, o)| object(o, named.get(i).map(Vec::as_slice).unwrap_or_default()))
            .collect::<Vec<_>>(),
    })
}

/// Keys of `data` and `stringData` an applied document names, sorted and without repeats.
pub fn document_keys(document: &Value) -> Vec<String> {
    let mut keys: Vec<String> = ["data", "stringData"]
        .iter()
        .filter_map(|field| document.get(*field).and_then(Value::as_object))
        .flat_map(|map| map.keys().cloned())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Keys of `data` and `stringData` a patch names: those of a merge patch's maps, or of a JSON patch's paths (`/data/<key>`,
/// and the keys of a value written at `/data` itself).
pub fn patch_keys(patch: &Value, patch_type: PatchType) -> Vec<String> {
    if patch_type == PatchType::Merge {
        return document_keys(patch);
    }
    let mut keys = Vec::new();
    for op in patch.as_array().into_iter().flatten() {
        for pointer in ["path", "from"] {
            let Some(path) = op.get(pointer).and_then(Value::as_str) else {
                continue;
            };
            let mut parts = path.split('/').skip(1);
            let field = parts.next().unwrap_or_default();
            if field != "data" && field != "stringData" {
                continue;
            }
            match parts.next() {
                Some(key) => keys.push(key.replace("~1", "/").replace("~0", "~")),
                None => {
                    if let Some(map) = op.get("value").and_then(Value::as_object) {
                        keys.extend(map.keys().cloned());
                    }
                }
            }
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

fn object(o: &DryRunObject, named: &[String]) -> Value {
    let secret = o.secret_keys.is_some();
    let change = if secret {
        match o.change {
            DryRunChange::Create => "create",
            DryRunChange::Failed => "refused",
            DryRunChange::Update | DryRunChange::Unchanged => "write",
        }
    } else {
        change_name(o.change)
    };
    let mut out = json!({
        "object": describe(&o.object),
        "change": change,
    });
    if !o.label.is_empty() {
        out["document"] = json!(o.label);
    }
    if let Some(error) = &o.error {
        out["error"] = json!(clip(&error.to_string()));
    }
    if let (Some(before), Some(after)) = (&o.before, &o.after) {
        let lines: Vec<String> = field_changes(before, after)
            .into_iter()
            // A Secret's values are "" on both sides anyway; the keys the call names are listed below.
            .filter(|c| {
                !(secret && (c.path.starts_with("data") || c.path.starts_with("stringData")))
            })
            .map(|c| {
                clip(&format!(
                    "{}: {} → {}",
                    c.path,
                    shown(c.before.as_ref()),
                    shown(c.after.as_ref())
                ))
            })
            .collect();
        if lines.len() > MAX_FIELDS {
            out["moreFields"] = json!(lines.len() - MAX_FIELDS);
        }
        out["fields"] = json!(lines.into_iter().take(MAX_FIELDS).collect::<Vec<_>>());
    }
    if secret {
        out["writtenKeys"] = json!(named);
    }
    out
}

fn change_name(change: DryRunChange) -> &'static str {
    match change {
        DryRunChange::Create => "create",
        DryRunChange::Update => "update",
        DryRunChange::Unchanged => "unchanged",
        DryRunChange::Failed => "refused",
    }
}

fn shown(value: Option<&Value>) -> String {
    match value {
        None => "(none)".to_owned(),
        Some(value) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use sextant_core::resources::{KindRef, ObjectRef, SecretKeyChanges};
    use sextant_core::{CoreError, ErrorCode};

    use super::*;

    fn object_ref(kind: &str) -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: kind.into(),
            },
            namespace: Some("ns".into()),
            name: "web".into(),
        }
    }

    #[test]
    fn a_summary_names_each_field_clips_long_values_and_never_shows_secret_data() {
        let long = "x".repeat(1000);
        let objects = vec![
            DryRunObject {
                object: object_ref("ConfigMap"),
                label: "document 1".into(),
                before: Some(json!({ "data": { "a": "1", "big": "" } })),
                after: Some(json!({ "data": { "a": "2", "big": long } })),
                change: DryRunChange::Update,
                secret_keys: None,
                error: None,
            },
            DryRunObject {
                object: object_ref("Secret"),
                label: String::new(),
                before: Some(json!({ "type": "Opaque", "data": { "token": "" } })),
                after: Some(
                    json!({ "type": "kubernetes.io/basic-auth", "data": { "token": "", "new": "" } }),
                ),
                change: DryRunChange::Update,
                secret_keys: Some(SecretKeyChanges {
                    added: vec!["new".into()],
                    changed: vec!["token".into()],
                    removed: vec![],
                }),
                error: None,
            },
            DryRunObject {
                object: object_ref("ConfigMap"),
                label: "document 3".into(),
                before: None,
                after: None,
                change: DryRunChange::Failed,
                secret_keys: None,
                error: Some(CoreError::new(
                    ErrorCode::Invalid,
                    "document 3 (ConfigMap web): bad",
                )),
            },
        ];
        let out = summary(&objects, &[vec![], vec!["token".into()], vec![]]);
        assert_eq!(out["dryRun"], true);
        let first = &out["objects"][0];
        assert_eq!(first["object"], "ConfigMap ns/web");
        assert_eq!(first["document"], "document 1");
        assert_eq!(first["fields"][0], r#"data.a: "1" → "2""#);
        let big = first["fields"][1].as_str().unwrap();
        assert!(big.chars().count() < 300, "{big}");
        let secret = &out["objects"][1];
        assert_eq!(
            secret["fields"],
            json!([r#"type: "Opaque" → "kubernetes.io/basic-auth""#])
        );
        assert_eq!(secret["change"], "write");
        assert_eq!(secret["writtenKeys"], json!(["token"]));
        assert!(secret.get("secretKeys").is_none());
        let refused = &out["objects"][2];
        assert_eq!(refused["change"], "refused");
        assert!(refused["error"].as_str().unwrap().contains("bad"));
        assert!(refused.get("fields").is_none());
    }

    /// A guessed value that matches and one that does not give the same answer: no oracle (ADR-0043).
    #[test]
    fn a_secret_that_would_not_change_reads_like_one_that_would() {
        let secret = |change, keys: SecretKeyChanges| DryRunObject {
            object: object_ref("Secret"),
            label: String::new(),
            before: Some(json!({ "data": { "password": "" } })),
            after: Some(json!({ "data": { "password": "" } })),
            change,
            secret_keys: Some(keys),
            error: None,
        };
        let right = secret(DryRunChange::Unchanged, SecretKeyChanges::default());
        let wrong = secret(
            DryRunChange::Update,
            SecretKeyChanges {
                changed: vec!["password".into()],
                ..SecretKeyChanges::default()
            },
        );
        let named = [vec!["password".to_owned()]];
        assert_eq!(summary(&[right], &named), summary(&[wrong], &named));
    }

    #[test]
    fn the_keys_a_call_names_come_from_its_input() {
        let doc = json!({ "data": { "b": "x", "a": "y" }, "stringData": { "a": "z", "c": "w" } });
        assert_eq!(document_keys(&doc), ["a", "b", "c"]);
        assert_eq!(
            patch_keys(&json!({ "data": { "password": "Zw==" } }), PatchType::Merge),
            ["password"]
        );
        let json_patch = json!([
            { "op": "replace", "path": "/data/pass~1word", "value": "Zw==" },
            { "op": "add", "path": "/stringData", "value": { "token": "t" } },
            { "op": "replace", "path": "/metadata/labels/a", "value": "b" }
        ]);
        assert_eq!(
            patch_keys(&json_patch, PatchType::Json),
            ["pass/word", "token"]
        );
    }
}
