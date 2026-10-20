//! Server-side dry runs of the changes the window and the agents send (#141): the editor's save (PUT), an apply of
//! one or more documents (server-side apply) and a patch, each sent with `dryRun=All` and the same field manager as
//! the real change, so the result is what the API server would store — defaulting, mutating admission webhooks and
//! validation included. Nothing is changed in the cluster: the only other requests are reads of the live objects.
//!
//! Both sides come out as the frontend gets objects (`to_json`: no `managedFields`; a core/v1 Secret with every value
//! `""` and the hidden-values marker), so a preview never carries a Secret value. What changed in a Secret's values
//! is told by key names only ([`SecretKeyChanges`]), compared inside the core. Fields that differ on every write
//! (`resourceVersion`, `generation`; for an object that would be created also the `uid` and `creationTimestamp` the
//! server made up for the dry run) are left out of both sides.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use kube::api::{DynamicObject, Patch, PatchParams, PostParams};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::get::{ResolvedKind, resolve_document_kind, to_json};
use super::mutate::{
    ApplyTarget, FIELD_MANAGER, STEP_TIMEOUT, edited_document, in_document, object_api, patch_body,
    patch_params, plan_apply, post_params, without_managed_fields,
};
use super::{ObjectRef, PatchType, parse_documents};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, with_timeout};
use crate::kubeconfig::ClusterId;

/// Which change a dry run stands for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DryRunMode {
    /// The editor's save: a PUT of one object that carries its `resourceVersion`.
    Replace,
    /// Server-side apply of one or more documents.
    Apply,
}

/// What a change would do to each object it names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DryRunResult {
    /// In the order of the documents.
    pub objects: Vec<DryRunObject>,
}

/// One object of a dry run.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DryRunObject {
    pub object: ObjectRef,
    /// `document 2`, `document 1, item 3` for an apply; empty for the editor's object and a patch.
    pub label: String,
    /// The live object; `None` when the change would create it (or the dry run failed before it was read).
    pub before: Option<Value>,
    /// What the API server would store; `None` when the dry run of this object failed (see `error`).
    pub after: Option<Value>,
    pub change: DryRunChange,
    /// Only for a core/v1 Secret: the keys whose values would be added, changed or removed (never the values).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret_keys: Option<SecretKeyChanges>,
    /// Why the API server refused this object (validation, an admission webhook, a missing namespace, …).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<CoreError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DryRunChange {
    /// The object does not exist yet.
    Create,
    Update,
    /// The server would store exactly what is there.
    Unchanged,
    /// The server refused it.
    Failed,
}

/// Key names of a Secret's values that would change; each list sorted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretKeyChanges {
    pub added: Vec<String>,
    pub changed: Vec<String>,
    pub removed: Vec<String>,
}

impl SecretKeyChanges {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.changed.is_empty() && self.removed.is_empty()
    }
}

/// Dry run of [`super::replace_yaml`] (`mode` `Replace`) or [`super::apply_yaml`] (`Apply`) of `yaml`.
///
/// A text that cannot be read, a kind the cluster does not serve, a missing `resourceVersion` or a Secret without its
/// values is an error of the whole call, as for the real change. For the editor's object a refusal of the server (a
/// conflict, validation) is an error too; for an apply each document gets its own `error`, so one refused document
/// does not hide what the others would do.
pub async fn dry_run_yaml(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
    mode: DryRunMode,
) -> CoreResult<DryRunResult> {
    match mode {
        DryRunMode::Replace => {
            let object = dry_run_replace(mgr, cluster, yaml).await?;
            Ok(DryRunResult {
                objects: vec![object],
            })
        }
        DryRunMode::Apply => {
            let targets = plan_apply(mgr, cluster, parse_documents(yaml)?).await?;
            dry_run_planned(mgr, cluster, targets).await
        }
    }
}

async fn dry_run_replace(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    yaml: &str,
) -> CoreResult<DryRunObject> {
    let doc = edited_document(yaml)?;
    let client = mgr.client(cluster)?;
    let kind = resolve_document_kind(mgr, cluster, doc.kind_ref()).await?;
    let namespace = kind
        .namespaced
        .then(|| doc.namespace_or(&client).to_owned());
    let api = kind.api(client.clone(), namespace.as_deref());
    let object = ObjectRef {
        kind: doc.kind_ref().clone(),
        namespace,
        name: doc.name().to_owned(),
    };
    // The very body `replace_yaml` sends (managedFields included, if the text has them): the preview is of the save.
    let obj: DynamicObject = serde_json::from_value(doc.value().clone())?;
    let before = api.get_opt(&object.name).await?;
    let params = PostParams {
        dry_run: true,
        ..post_params()
    };
    let after = api.replace(&object.name, &params, &obj).await?;
    compared(object, String::new(), &kind, before, after)
}

/// Dry run of [`super::apply_planned`]: each document is read live and server-side applied with `dryRun=All`, each
/// request limited to [`STEP_TIMEOUT`].
pub async fn dry_run_planned(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    targets: Vec<ApplyTarget>,
) -> CoreResult<DryRunResult> {
    dry_run_within(mgr, cluster, targets, STEP_TIMEOUT).await
}

async fn dry_run_within(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    targets: Vec<ApplyTarget>,
    step: Duration,
) -> CoreResult<DryRunResult> {
    let client = mgr.client(cluster)?;
    let params = PatchParams::apply(FIELD_MANAGER).dry_run();
    let mut objects = Vec::with_capacity(targets.len());
    for ApplyTarget { doc, kind, object } in targets {
        let label = doc.label().to_owned();
        let mut body = doc.value().clone();
        without_managed_fields(&mut body);
        let api = kind.api(client.clone(), object.namespace.as_deref());
        let sent = with_timeout(step, "the dry run", async {
            let before = api.get_opt(&object.name).await?;
            let after = api
                .patch(&object.name, &params, &Patch::Apply(&body))
                .await?;
            Ok::<_, CoreError>((before, after))
        })
        .await;
        let shown = object.clone();
        let result = match sent {
            Ok((before, after)) => compared(object, label.clone(), &kind, before, after),
            Err(err) => Err(err),
        };
        objects.push(match result {
            Ok(done) => done,
            Err(err) => DryRunObject {
                object: shown,
                label,
                before: None,
                after: None,
                change: DryRunChange::Failed,
                secret_keys: None,
                error: Some(in_document(&doc, err)),
            },
        });
    }
    Ok(DryRunResult { objects })
}

/// Dry run of [`super::patch`]: the same body checks, the live object, then the patch with `dryRun=All`. A refusal of
/// the server is an error of the call.
pub async fn dry_run_patch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    patch: &Value,
    patch_type: PatchType,
) -> CoreResult<DryRunObject> {
    let body = patch_body(patch, patch_type)?;
    let (api, kind) = object_api(mgr, cluster, r).await?;
    let before = api.get_opt(&r.name).await?;
    let params = PatchParams {
        dry_run: true,
        ..patch_params()
    };
    let after = api.patch(&r.name, &params, &body).await?;
    compared(r.clone(), String::new(), &kind, before, after)
}

/// Both sides as the frontend gets objects, without the fields every write changes, and how they differ.
pub(super) fn compared(
    object: ObjectRef,
    label: String,
    kind: &ResolvedKind,
    before: Option<DynamicObject>,
    after: DynamicObject,
) -> CoreResult<DryRunObject> {
    let secret = kind.resource.group.is_empty() && kind.resource.kind == "Secret";
    let secret_keys = secret.then(|| {
        secret_key_changes(
            before.as_ref().map(|o| secret_values(&o.data)),
            &secret_values(&after.data),
        )
    });
    let creates = before.is_none();
    let mut before = before.map(|o| to_json(o, &kind.resource)).transpose()?;
    let mut after = to_json(after, &kind.resource)?;
    if let Some(before) = before.as_mut() {
        without_noise(before, false);
    }
    without_noise(&mut after, creates);
    let change = match &before {
        None => DryRunChange::Create,
        Some(before) if *before != after || secret_keys.as_ref().is_some_and(|k| !k.is_empty()) => {
            DryRunChange::Update
        }
        Some(_) => DryRunChange::Unchanged,
    };
    Ok(DryRunObject {
        object,
        label,
        before,
        after: Some(after),
        change,
        secret_keys,
        error: None,
    })
}

/// Removes the fields that differ on every write; for an object that would be created also the ones the server made
/// up for the dry run.
fn without_noise(value: &mut Value, created: bool) {
    let Some(meta) = value.get_mut("metadata").and_then(Value::as_object_mut) else {
        return;
    };
    for field in ["managedFields", "resourceVersion", "generation"] {
        meta.remove(field);
    }
    if created {
        meta.remove("uid");
        meta.remove("creationTimestamp");
    }
}

/// The values of a Secret by key, as base64 of their bytes (`data` decoded and `stringData` encoded, so the same value
/// written either way is the same; `stringData` wins, as on the server); never leaves the core.
pub(crate) fn secret_values(fields: &Value) -> BTreeMap<String, String> {
    use base64::Engine as _;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut values = BTreeMap::new();
    if let Some(map) = fields.get("data").and_then(Value::as_object) {
        for (key, value) in map {
            let text = value.as_str().unwrap_or_default();
            let canonical = engine
                .decode(text.trim())
                .map(|bytes| engine.encode(bytes))
                .unwrap_or_else(|_| format!("raw:{text}"));
            values.insert(key.clone(), canonical);
        }
    }
    if let Some(map) = fields.get("stringData").and_then(Value::as_object) {
        for (key, value) in map {
            let text = match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
            values.insert(key.clone(), engine.encode(text.as_bytes()));
        }
    }
    values
}

/// Which keys `after` adds, changes or removes relative to `before` (`None`: a new Secret, every key is added).
pub(crate) fn secret_key_changes(
    before: Option<BTreeMap<String, String>>,
    after: &BTreeMap<String, String>,
) -> SecretKeyChanges {
    let before = before.unwrap_or_default();
    let mut changes = SecretKeyChanges::default();
    for (key, value) in after {
        match before.get(key) {
            None => changes.added.push(key.clone()),
            Some(old) if old != value => changes.changed.push(key.clone()),
            Some(_) => {}
        }
    }
    changes.removed = before
        .keys()
        .filter(|key| !after.contains_key(*key))
        .cloned()
        .collect();
    changes
}

/// One field that differs between two objects: its path (`spec.replicas`, `metadata.labels["app.kubernetes.io/name"]`,
/// `spec.containers[0].image`) and the value on each side (`None`: missing there).
#[derive(Debug, Clone, PartialEq)]
pub struct FieldChange {
    pub path: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}

/// The fields that differ between `before` and `after`, in path order. Objects are compared key by key; lists of the
/// same length item by item, other lists as a whole.
pub fn field_changes(before: &Value, after: &Value) -> Vec<FieldChange> {
    let mut changes = Vec::new();
    walk(String::new(), Some(before), Some(after), &mut changes);
    changes
}

fn walk(path: String, before: Option<&Value>, after: Option<&Value>, out: &mut Vec<FieldChange>) {
    match (before, after) {
        (Some(a), Some(b)) if a == b => {}
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            let keys: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
            for key in keys {
                walk(child(&path, key), a.get(key), b.get(key), out);
            }
        }
        (Some(Value::Array(a)), Some(Value::Array(b))) if a.len() == b.len() => {
            for (index, (x, y)) in a.iter().zip(b).enumerate() {
                walk(format!("{path}[{index}]"), Some(x), Some(y), out);
            }
        }
        (None, None) => {}
        (a, b) => out.push(FieldChange {
            path: if path.is_empty() { ".".into() } else { path },
            before: a.cloned(),
            after: b.cloned(),
        }),
    }
}

fn child(path: &str, key: &str) -> String {
    let plain = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    match (path.is_empty(), plain) {
        (true, true) => key.to_owned(),
        (false, true) => format!("{path}.{key}"),
        (_, false) => format!("{path}[{}]", Value::String(key.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::error::ErrorCode;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use crate::resources::KindRef;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
        {"name":"configmaps","singularName":"configmap","namespaced":true,"kind":"ConfigMap","verbs":["get","patch","update"]},
        {"name":"secrets","singularName":"secret","namespaced":true,"kind":"Secret","verbs":["get","patch","update"]}]}"#;
    const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;

    /// Live: ConfigMap `ns/web` (`mode: a`) and Secret `ns/creds` (`token` = "old-secret", `gone` = "x"); ConfigMap
    /// `ns/new` does not exist; ConfigMap `ns/bad` is refused by a webhook. Every write answers as the server would
    /// store it after defaulting (a label added), with the values the test expects.
    fn answer(req: &Request) -> Reply {
        let live_cm = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"web","namespace":"ns","uid":"u1","resourceVersion":"7","creationTimestamp":"2026-01-01T00:00:00Z","managedFields":[{"manager":"kubectl"}]},"data":{"mode":"a"}}"#;
        let stored_cm = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"web","namespace":"ns","uid":"u1","resourceVersion":"8","creationTimestamp":"2026-01-01T00:00:00Z","labels":{"defaulted":"yes"},"managedFields":[{"manager":"sextant"}]},"data":{"mode":"b"}}"#;
        let new_cm = r#"{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"new","namespace":"ns","uid":"made-up","resourceVersion":"1","creationTimestamp":"2026-10-18T00:00:00Z"},"data":{"x":"1"}}"#;
        // b2xkLXNlY3JldA== is "old-secret", bmV3LXNlY3JldA== is "new-secret".
        let live_secret = r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"creds","namespace":"ns","resourceVersion":"3","annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":{\"token\":\"b2xkLXNlY3JldA==\"}}"}},"type":"Opaque","data":{"token":"b2xkLXNlY3JldA==","gone":"eA=="}}"#;
        let stored_secret = r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"creds","namespace":"ns","resourceVersion":"4"},"type":"Opaque","data":{"token":"bmV3LXNlY3JldA==","extra":"eQ=="}}"#;
        let refused = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"admission webhook \"policy.example.com\" denied the request: no","reason":"Forbidden","code":403}"#;
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", "/api/v1") => Reply::json(200, CORE_RESOURCES),
            ("GET", "/apis") => Reply::json(200, API_GROUPS),
            ("GET", "/api/v1/namespaces/ns/configmaps/web") => Reply::json(200, live_cm),
            ("GET", "/api/v1/namespaces/ns/secrets/creds") => Reply::json(200, live_secret),
            ("PUT" | "PATCH", "/api/v1/namespaces/ns/configmaps/web") => {
                Reply::json(200, stored_cm)
            }
            ("PATCH", "/api/v1/namespaces/ns/configmaps/new") => Reply::json(201, new_cm),
            ("PATCH", "/api/v1/namespaces/ns/configmaps/bad") => Reply::json(403, refused),
            ("PUT" | "PATCH", "/api/v1/namespaces/ns/secrets/creds") => {
                Reply::json(200, stored_secret)
            }
            _ => Reply::not_found(),
        }
    }

    fn writes(api: &FakeApi) -> Vec<Request> {
        api.requests()
            .into_iter()
            .filter(|r| r.method != "GET")
            .collect()
    }

    /// Every write is a dry run signed by Sextant's field manager.
    fn assert_only_dry_runs(api: &FakeApi) {
        let writes = writes(api);
        assert!(!writes.is_empty());
        for w in &writes {
            let query: Vec<&str> = w.query.split('&').collect();
            assert!(query.contains(&"dryRun=All"), "{} ?{}", w.line(), w.query);
            assert!(
                query.contains(&"fieldManager=sextant"),
                "{} ?{}",
                w.line(),
                w.query
            );
        }
    }

    const CM_EDIT: &str = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\n  namespace: ns\n  resourceVersion: \"7\"\ndata:\n  mode: b\n";

    #[tokio::test]
    async fn the_editors_dry_run_sends_one_dry_put_and_shows_live_against_stored_without_noise() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let result = dry_run_yaml(&mgr, &id, CM_EDIT, DryRunMode::Replace)
            .await
            .unwrap();
        assert_only_dry_runs(&api);
        let lines: Vec<String> = writes(&api).iter().map(Request::line).collect();
        assert_eq!(lines, ["PUT /api/v1/namespaces/ns/configmaps/web"]);

        let [object] = result.objects.as_slice() else {
            panic!("{result:?}")
        };
        assert_eq!(object.change, DryRunChange::Update);
        let before = object.before.as_ref().unwrap();
        let after = object.after.as_ref().unwrap();
        for side in [before, after] {
            let meta = &side["metadata"];
            assert!(meta.get("managedFields").is_none(), "{side}");
            assert!(meta.get("resourceVersion").is_none(), "{side}");
            assert_eq!(meta["uid"], "u1");
        }
        let changes: Vec<String> = field_changes(before, after)
            .into_iter()
            .map(|c| c.path)
            .collect();
        assert_eq!(changes, ["data.mode", "metadata.labels"]);
    }

    /// The preview of a save sends the very body the save sends (managedFields too, if the text has them).
    #[tokio::test]
    async fn the_editors_dry_run_sends_the_body_of_the_save() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let edit = CM_EDIT.replace(
            "  resourceVersion: \"7\"\n",
            "  resourceVersion: \"7\"\n  managedFields:\n  - manager: kubectl\n",
        );
        dry_run_yaml(&mgr, &id, &edit, DryRunMode::Replace)
            .await
            .unwrap();
        super::super::replace_yaml(&mgr, &id, &edit).await.unwrap();
        let puts: Vec<Request> = writes(&api)
            .into_iter()
            .filter(|r| r.method == "PUT")
            .collect();
        let [preview, save] = puts.as_slice() else {
            panic!("{puts:?}")
        };
        assert!(preview.query.contains("dryRun=All"));
        assert!(!save.query.contains("dryRun"));
        assert_eq!(preview.body, save.body);
    }

    #[tokio::test]
    async fn an_apply_dry_run_previews_every_document_and_keeps_a_refusal_with_its_document() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let yaml = "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: web, namespace: ns}\ndata: {mode: b}\n---\n\
                    apiVersion: v1\nkind: ConfigMap\nmetadata: {name: bad, namespace: ns}\n---\n\
                    apiVersion: v1\nkind: ConfigMap\nmetadata: {name: new, namespace: ns}\ndata: {x: \"1\"}\n";
        let result = dry_run_yaml(&mgr, &id, yaml, DryRunMode::Apply)
            .await
            .unwrap();
        assert_only_dry_runs(&api);
        let changes: Vec<DryRunChange> = result.objects.iter().map(|o| o.change).collect();
        assert_eq!(
            changes,
            [
                DryRunChange::Update,
                DryRunChange::Failed,
                DryRunChange::Create
            ]
        );
        let refused = result.objects[1].error.as_ref().unwrap();
        assert_eq!(refused.code, ErrorCode::Forbidden, "{refused}");
        assert!(
            refused
                .message
                .starts_with("document 2 (ConfigMap bad): admission webhook"),
            "{refused}"
        );
        assert_eq!(result.objects[1].object.namespace.as_deref(), Some("ns"));
        let created = &result.objects[2];
        assert!(created.before.is_none());
        let meta = &created.after.as_ref().unwrap()["metadata"];
        assert!(meta.get("uid").is_none() && meta.get("creationTimestamp").is_none());
        assert_eq!(created.label, "document 3");
    }

    #[tokio::test]
    async fn a_secrets_dry_run_carries_no_value_and_names_only_the_changed_keys() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let edit = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\n  namespace: ns\n  resourceVersion: \"3\"\n\
                    type: Opaque\ndata:\n  token: bmV3LXNlY3JldA==\n  extra: eQ==\n";
        for mode in [DryRunMode::Replace, DryRunMode::Apply] {
            let result = dry_run_yaml(&mgr, &id, edit, mode).await.unwrap();
            let text = serde_json::to_string(&result).unwrap();
            for value in ["bmV3LXNlY3JldA==", "b2xkLXNlY3JldA==", "eQ==", "eA=="] {
                assert!(!text.contains(value), "{mode:?} leaked {value}: {text}");
            }
            let object = &result.objects[0];
            for side in [
                object.before.as_ref().unwrap(),
                object.after.as_ref().unwrap(),
            ] {
                assert_eq!(side["data"]["token"], "");
                assert_eq!(
                    side["metadata"]["annotations"][super::super::get::VALUES_HIDDEN_ANNOTATION],
                    "true"
                );
                assert!(super::super::get::ensure_values_present(side).is_err());
            }
            assert_eq!(object.change, DryRunChange::Update);
            assert_eq!(
                object.secret_keys,
                Some(SecretKeyChanges {
                    added: vec!["extra".into()],
                    changed: vec!["token".into()],
                    removed: vec!["gone".into()],
                })
            );
        }
        assert_only_dry_runs(&api);
    }

    #[tokio::test]
    async fn a_patch_dry_run_sends_the_patch_as_a_dry_run_only() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let r = ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "ConfigMap".into(),
            },
            namespace: Some("ns".into()),
            name: "web".into(),
        };
        let object = dry_run_patch(
            &mgr,
            &id,
            &r,
            &json!({ "data": { "mode": "b" } }),
            PatchType::Merge,
        )
        .await
        .unwrap();
        assert_eq!(object.change, DryRunChange::Update);
        assert_only_dry_runs(&api);
        let hidden = dry_run_patch(
            &mgr,
            &id,
            &r,
            &json!({ "metadata": { "annotations": { "sextant.dev/values-hidden": "true" } } }),
            PatchType::Merge,
        )
        .await
        .unwrap_err();
        assert_eq!(hidden.code, ErrorCode::Invalid);
    }

    #[tokio::test]
    async fn the_editors_dry_run_needs_the_resource_version_and_sends_nothing_without_it() {
        let api = FakeApi::start(answer).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = dry_run_yaml(
            &mgr,
            &id,
            &CM_EDIT.replace("  resourceVersion: \"7\"\n", ""),
            DryRunMode::Replace,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(writes(&api).is_empty());
    }

    #[test]
    fn field_changes_name_paths_and_both_sides() {
        let before = json!({ "spec": { "replicas": 2, "containers": [{ "image": "a" }], "ports": [1] },
                             "metadata": { "labels": { "app.kubernetes.io/name": "x" } } });
        let after = json!({ "spec": { "replicas": 3, "containers": [{ "image": "b" }], "ports": [1, 2] },
                            "metadata": { "labels": {} } });
        let changes = field_changes(&before, &after);
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "metadata.labels[\"app.kubernetes.io/name\"]",
                "spec.containers[0].image",
                "spec.ports",
                "spec.replicas"
            ]
        );
        assert_eq!(changes[0].after, None);
        assert_eq!(changes[3].before, Some(json!(2)));
        assert!(field_changes(&before, &before).is_empty());
    }
}
