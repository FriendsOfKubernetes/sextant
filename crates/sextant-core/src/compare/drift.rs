//! Drift of a Helm release: the objects of its stored manifest (the latest revision that can be read, the same
//! decoding as the release details) next to the live objects, for the frontend to compare field by field.
//!
//! Fails closed like the upgrade preview (`helm::diff`): a document that cannot be read or has no kind, version or
//! name is only counted; a Secret (of any API version) is never sent with its values — a core/v1 Secret is compared
//! here by key names and value hashes against the live one.

use futures::{StreamExt, stream};
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::check_namespace;
use super::secrets::{SecretKeyComparison, compare_keys, value_hashes};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, with_timeout};
use crate::helm::diff::split;
use crate::helm::stored_release;
use crate::kubeconfig::ClusterId;
use crate::resources::{KindRef, ObjectRef, STEP_TIMEOUT, get, hide_secret_values, resolve_kind};

/// Objects of one manifest compared, at most; the rest are counted in `truncated`.
pub const MAX_DRIFT_OBJECTS: usize = 300;
/// Live objects read at once.
const PARALLEL: usize = 8;

/// A release's manifest against the cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmDrift {
    pub release: String,
    pub namespace: String,
    /// The revision whose manifest was read.
    pub revision: i32,
    /// The manifest's objects in manifest order.
    pub objects: Vec<DriftObject>,
    /// Documents left out because they could not be read or classified.
    pub unreadable: u32,
    /// Objects past [`MAX_DRIFT_OBJECTS`], not compared.
    pub truncated: u32,
}

/// One object of the manifest and the live object it names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DriftObject {
    /// The object, in the release's namespace when the manifest names none and the kind is namespaced.
    pub object: ObjectRef,
    /// The object as the manifest has it; a Secret without its values.
    pub rendered: Value,
    /// The live object without `status` (a Secret without its values); `None` when it does not exist or could not be
    /// read (see `error`).
    pub live: Option<Value>,
    pub error: Option<CoreError>,
    /// Only for a core/v1 Secret that exists: its keys, the manifest's on the left, the live ones on the right.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret_keys: Option<Vec<SecretKeyComparison>>,
}

/// One object of the manifest as parsed.
struct Rendered {
    kind: KindRef,
    namespace: Option<String>,
    name: String,
    value: Value,
}

fn kind_of(value: &Value) -> Option<KindRef> {
    let api_version = value.get("apiVersion")?.as_str()?;
    let kind = value.get("kind")?.as_str()?;
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));
    (!kind.is_empty() && !version.is_empty()).then(|| KindRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: kind.to_owned(),
    })
}

fn rendered(value: Value) -> Option<Rendered> {
    let kind = kind_of(&value)?;
    let field = |pointer: &str| {
        value
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let name = field("/metadata/name").filter(|n| !n.is_empty())?;
    let namespace = field("/metadata/namespace").filter(|n| !n.is_empty());
    Some(Rendered {
        kind,
        namespace,
        name,
        value,
    })
}

/// The objects of a manifest in order; a `List`'s items one by one. Counts what cannot be read in `unreadable`.
pub(crate) fn manifest_objects(
    manifest: &str,
    unreadable: &mut u32,
) -> Vec<(KindRef, Option<String>, String, Value)> {
    let mut out = Vec::new();
    for text in split(manifest) {
        let content = text
            .lines()
            .any(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'));
        if !content {
            continue;
        }
        let Ok(value) = serde_yaml::from_str::<Value>(&text) else {
            *unreadable += 1;
            continue;
        };
        if value.is_null() {
            continue;
        }
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let items = if kind.ends_with("List") || value.get("items").is_some() {
            match value.get("items").and_then(Value::as_array) {
                Some(items) => items.clone(),
                None => {
                    *unreadable += 1;
                    continue;
                }
            }
        } else {
            vec![value]
        };
        for item in items {
            match rendered(item) {
                Some(r) => out.push((r.kind, r.namespace, r.name, r.value)),
                None => *unreadable += 1,
            }
        }
    }
    out
}

fn is_secret(kind: &KindRef) -> bool {
    kind.kind == "Secret"
}

fn without_status(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.remove("status");
    }
    value
}

async fn compare_one(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    release_ns: &str,
    (kind, namespace, name, mut value): (KindRef, Option<String>, String, Value),
) -> DriftObject {
    let secret_hashes = (is_secret(&kind) && kind.group.is_empty()).then(|| value_hashes(&value));
    if is_secret(&kind) {
        hide_secret_values(&mut value);
    }
    let mut object = ObjectRef {
        kind: kind.clone(),
        namespace: namespace.clone(),
        name,
    };
    let mut drift = DriftObject {
        object: object.clone(),
        rendered: value,
        live: None,
        error: None,
        secret_keys: None,
    };
    let resolved = match resolve_kind(mgr, cluster, &kind).await {
        Ok(resolved) => resolved,
        Err(error) => {
            drift.error = Some(error);
            return drift;
        }
    };
    object.namespace = if resolved.namespaced {
        Some(namespace.unwrap_or_else(|| release_ns.to_owned()))
    } else {
        None
    };
    drift.object = object.clone();
    let read = with_timeout(
        STEP_TIMEOUT,
        "reading the object",
        get(mgr, cluster, &object),
    )
    .await;
    match read {
        Ok(live) => {
            let mut live = without_status(live);
            if is_secret(&kind) {
                hide_secret_values(&mut live);
            }
            drift.live = Some(live);
        }
        Err(error) if error.code == ErrorCode::NotFound => {}
        Err(error) => drift.error = Some(error),
    }
    if let (Some(rendered), Some(_)) = (secret_hashes, &drift.live) {
        match live_secret_hashes(mgr, cluster, &object).await {
            Ok(Some(live)) => drift.secret_keys = Some(compare_keys(&rendered, &live)),
            Ok(None) => drift.live = None,
            Err(error) => drift.error = Some(error),
        }
    }
    drift
}

async fn live_secret_hashes(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    object: &ObjectRef,
) -> CoreResult<Option<std::collections::BTreeMap<String, [u8; 32]>>> {
    let client = mgr.client(cluster)?;
    let api: Api<Secret> = Api::namespaced(client, object.namespace.as_deref().unwrap_or_default());
    let found = with_timeout(STEP_TIMEOUT, "reading the Secret", async {
        Ok(api.get_opt(&object.name).await?)
    })
    .await?;
    found
        .map(|secret| Ok(value_hashes(&serde_json::to_value(secret)?)))
        .transpose()
}

/// The latest readable revision of release `name` in `namespace` against the live objects of `cluster`.
pub async fn helm_drift(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    name: &str,
) -> CoreResult<HelmDrift> {
    check_namespace(namespace)?;
    let stored = stored_release(mgr, cluster, namespace, name, None).await?;
    let mut unreadable = 0;
    let mut objects = manifest_objects(&stored.manifest, &mut unreadable);
    let truncated = objects.len().saturating_sub(MAX_DRIFT_OBJECTS);
    objects.truncate(MAX_DRIFT_OBJECTS);
    let compared = stream::iter(objects)
        .map(|object| compare_one(mgr, cluster, namespace, object))
        .buffered(PARALLEL)
        .collect()
        .await;
    Ok(HelmDrift {
        release: name.to_owned(),
        namespace: namespace.to_owned(),
        revision: stored.version,
        objects: compared,
        unreadable,
        truncated: u32::try_from(truncated)
            .map_err(|_| CoreError::new(ErrorCode::Invalid, "the manifest has too many objects"))?,
    })
}
