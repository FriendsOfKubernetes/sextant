//! Two stored revisions of a release side by side (#209): the user-supplied values (YAML, keys in order), the rendered
//! manifest object by object, and the notes. Read from the release Secrets with the same bounded decoding as the
//! release details ([`super::MAX_RELEASE_BYTES`]); nothing is asked of `helm` or the cluster's objects.
//!
//! The manifest is cut the way the drift view cuts it (`compare::manifest_objects`): a document that cannot be read or
//! has no kind, version or name is only counted. A Secret (of any API version) is sent without its values; a core/v1
//! Secret's values are compared here by key names and SHA-256 (`compare::compare_keys`), and only `{key, onLeft,
//! onRight, equal}` leaves the core. Values and the rest of the manifest go out as the release details send them
//! today; the window hides them until "Show", as it does there.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{HelmRelease, StoredRelease, check_release_name, stored_release, values_to_yaml};
use crate::cluster::ClusterManager;
use crate::compare::{SecretKeyComparison, compare_keys, manifest_objects, value_hashes};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::resources::{KindRef, ObjectRef, hide_secret_values};

/// Objects of the two manifests compared, at most; the rest are counted in `truncated`.
pub const MAX_REVISION_OBJECTS: usize = 500;

/// Two revisions of one release, `left` the one picked first (by default the previous revision).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRevisionDiff {
    pub release: String,
    pub namespace: String,
    pub left: HelmRelease,
    pub right: HelmRelease,
    /// User-supplied values of each side as YAML, keys in order (empty when there are none).
    pub left_values: String,
    pub right_values: String,
    pub left_notes: String,
    pub right_notes: String,
    /// Every object of either manifest, ordered by kind, namespace and name.
    pub objects: Vec<RevisionObject>,
    /// Documents left out (on either side) because they could not be read or classified.
    pub unreadable: u32,
    /// Objects past [`MAX_REVISION_OBJECTS`], not compared.
    pub truncated: u32,
}

/// One object of either manifest: as each side has it (`None` where that side has no such object).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RevisionObject {
    /// The object as the newer side names it (the older side's when only it has the object); the namespace is the
    /// manifest's, `None` when the manifest names none.
    pub object: ObjectRef,
    /// A Secret without its values.
    pub left: Option<Value>,
    pub right: Option<Value>,
    /// Only for a core/v1 Secret: its keys, the left side's against the right side's.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub secret_keys: Option<Vec<SecretKeyComparison>>,
}

/// Group, kind, namespace and name: the same object across revisions, whatever API version each side used.
type Key = (String, String, String, String);

struct Side {
    kind: KindRef,
    namespace: Option<String>,
    name: String,
    value: Value,
}

fn is_secret(kind: &KindRef) -> bool {
    kind.kind == "Secret"
}

fn objects_of(manifest: &str, unreadable: &mut u32) -> BTreeMap<Key, Side> {
    manifest_objects(manifest, unreadable)
        .into_iter()
        .map(|(kind, namespace, name, value)| {
            let key = (
                kind.group.clone(),
                kind.kind.clone(),
                namespace.clone().unwrap_or_default(),
                name.clone(),
            );
            (
                key,
                Side {
                    kind,
                    namespace,
                    name,
                    value,
                },
            )
        })
        .collect()
}

/// A Secret's values hashed (core/v1 only) and then hidden; any other object as it is.
fn shown(side: Option<Side>) -> (Option<Side>, Option<BTreeMap<String, [u8; 32]>>) {
    match side {
        Some(mut side) if is_secret(&side.kind) => {
            let hashes = side
                .kind
                .group
                .is_empty()
                .then(|| value_hashes(&side.value));
            hide_secret_values(&mut side.value);
            (Some(side), hashes)
        }
        other => (other, None),
    }
}

/// The diff of two stored releases' manifests, object by object.
pub fn manifest_objects_diff(left: &str, right: &str) -> (Vec<RevisionObject>, u32, u32) {
    let mut unreadable = 0;
    let mut a = objects_of(left, &mut unreadable);
    let mut b = objects_of(right, &mut unreadable);
    let mut keys: Vec<Key> = a.keys().chain(b.keys()).cloned().collect();
    keys.sort();
    keys.dedup();
    let truncated = keys.len().saturating_sub(MAX_REVISION_OBJECTS);
    keys.truncate(MAX_REVISION_OBJECTS);
    let objects = keys
        .into_iter()
        .map(|key| {
            let (l, left_hashes) = shown(a.remove(&key));
            let (r, right_hashes) = shown(b.remove(&key));
            let named = r
                .as_ref()
                .or(l.as_ref())
                .expect("a key comes from one of the sides");
            let object = ObjectRef {
                kind: named.kind.clone(),
                namespace: named.namespace.clone(),
                name: named.name.clone(),
            };
            let secret_keys = (left_hashes.is_some() || right_hashes.is_some()).then(|| {
                compare_keys(
                    &left_hashes.unwrap_or_default(),
                    &right_hashes.unwrap_or_default(),
                )
            });
            RevisionObject {
                object,
                left: l.map(|s| s.value),
                right: r.map(|s| s.value),
                secret_keys,
            }
        })
        .collect();
    (
        objects,
        unreadable,
        u32::try_from(truncated).unwrap_or(u32::MAX),
    )
}

/// Two decoded revisions compared.
pub fn revision_diff(left: &StoredRelease, right: &StoredRelease) -> CoreResult<HelmRevisionDiff> {
    let (objects, unreadable, truncated) = manifest_objects_diff(&left.manifest, &right.manifest);
    Ok(HelmRevisionDiff {
        release: right.name.clone(),
        namespace: right.namespace.clone(),
        left: left.summary(),
        right: right.summary(),
        left_values: values_to_yaml(&left.config)?,
        right_values: values_to_yaml(&right.config)?,
        left_notes: left.info.notes.clone(),
        right_notes: right.info.notes.clone(),
        objects,
        unreadable,
        truncated,
    })
}

/// Revisions `left` and `right` of release `name` in `ns`, compared. Each is read and decoded on its own (at most
/// [`super::MAX_RELEASE_BYTES`] unpacked); a revision that does not exist is `notFound`.
pub async fn compare_revisions(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    name: &str,
    left: i32,
    right: i32,
) -> CoreResult<HelmRevisionDiff> {
    check_release_name(name)?;
    crate::compare::check_namespace(ns)?;
    if left < 1 || right < 1 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a revision number starts at 1",
        ));
    }
    let a = stored_release(mgr, cluster, ns, name, Some(left)).await?;
    let b = if right == left {
        a.clone()
    } else {
        stored_release(mgr, cluster, ns, name, Some(right)).await?
    };
    let mut diff = revision_diff(&a, &b)?;
    // A release Secret may omit them; the request says which release it is.
    diff.release = name.to_owned();
    diff.namespace = ns.to_owned();
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use base64::Engine as _;
    use serde_json::json;

    use super::*;
    use crate::helm::decode_release;

    /// A revision as Helm stores it: base64 text of gzipped release JSON.
    fn stored(version: i32, config: Value, manifest: &str, notes: &str) -> StoredRelease {
        let release = json!({
            "name": "web", "namespace": "apps", "version": version,
            "info": { "status": "deployed", "last_deployed": "2026-10-11T22:19:14Z", "notes": notes },
            "chart": { "metadata": { "name": "nginx", "version": format!("15.{version}.0"), "appVersion": "1.25" } },
            "config": config,
            "manifest": manifest,
        });
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all(&serde_json::to_vec(&release).unwrap())
            .unwrap();
        let data = base64::engine::general_purpose::STANDARD.encode(enc.finish().unwrap());
        decode_release(data.as_bytes()).unwrap()
    }

    const OLD: &str = "---
# Source: nginx/templates/cm.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: web
data:
  mode: old
---
apiVersion: v1
kind: Secret
metadata:
  name: web-auth
data:
  password: c2VjcmV0LW9uZQ==
  token: dG9rZW4=
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1
---
apiVersion: batch/v1
kind: Job
metadata:
  name: migrate
---
kind: [not yaml
";

    const NEW: &str = "---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
---
apiVersion: v1
kind: Secret
metadata:
  name: web-auth
stringData:
  password: secret-two
  token: token
  extra: added-value
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web
data:
  mode: old
---
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: apps
";

    #[test]
    fn two_revisions_are_compared_object_by_object_with_values_and_notes() {
        let left = stored(
            1,
            json!({ "zeta": 1, "alpha": { "b": 2, "a": 1 } }),
            OLD,
            "Old notes.\n",
        );
        let right = stored(
            2,
            json!({ "alpha": { "a": 1 }, "zeta": 2 }),
            NEW,
            "New notes.\n",
        );
        let diff = revision_diff(&left, &right).unwrap();
        assert_eq!((diff.left.revision, diff.right.revision), (1, 2));
        assert_eq!(
            (
                diff.left.chart_version.as_str(),
                diff.right.chart_version.as_str()
            ),
            ("15.1.0", "15.2.0")
        );
        // Keys in order, whatever order the user gave.
        assert_eq!(diff.left_values, "alpha:\n  a: 1\n  b: 2\nzeta: 1\n");
        assert_eq!(diff.right_values, "alpha:\n  a: 1\nzeta: 2\n");
        assert_eq!(
            (diff.left_notes.as_str(), diff.right_notes.as_str()),
            ("Old notes.\n", "New notes.\n")
        );
        assert_eq!(diff.unreadable, 1);
        assert_eq!(diff.truncated, 0);
        let names: Vec<String> = diff
            .objects
            .iter()
            .map(|o| format!("{}/{}", o.object.kind.kind, o.object.name))
            .collect();
        // Kind (with group) order: core ConfigMap, Secret, Service, then apps Deployment and batch Job.
        assert_eq!(
            names,
            [
                "ConfigMap/web",
                "Secret/web-auth",
                "Service/web",
                "Deployment/web",
                "Job/migrate"
            ]
        );
        let by = |kind: &str| {
            diff.objects
                .iter()
                .find(|o| o.object.kind.kind == kind)
                .unwrap()
        };
        assert_eq!(by("ConfigMap").left, by("ConfigMap").right);
        assert!(by("Service").left.is_none() && by("Service").right.is_some());
        assert_eq!(by("Service").object.namespace.as_deref(), Some("apps"));
        assert!(by("Job").right.is_none() && by("Job").left.is_some());
        assert_eq!(
            by("Deployment").right.as_ref().unwrap()["spec"]["replicas"],
            3
        );
        assert!(by("Deployment").secret_keys.is_none());
    }

    #[test]
    fn a_secret_of_a_revision_is_compared_by_keys_and_never_sent_with_its_values() {
        let left = stored(1, json!({}), OLD, "");
        let right = stored(2, json!({}), NEW, "");
        let diff = revision_diff(&left, &right).unwrap();
        let secret = diff
            .objects
            .iter()
            .find(|o| o.object.kind.kind == "Secret")
            .unwrap();
        let keys = secret.secret_keys.as_ref().unwrap();
        let state: Vec<(&str, bool, bool, bool)> = keys
            .iter()
            .map(|k| (k.key.as_str(), k.on_left, k.on_right, k.equal))
            .collect();
        // `data` (base64) and `stringData` (plain) hash the same value the same.
        assert_eq!(
            state,
            [
                ("extra", false, true, false),
                ("password", true, true, false),
                ("token", true, true, true)
            ]
        );
        let text = serde_json::to_string(&diff).unwrap();
        for value in [
            "c2VjcmV0LW9uZQ",
            "secret-one",
            "secret-two",
            "dG9rZW4",
            "added-value",
        ] {
            assert!(!text.contains(value), "{value} leaked: {text}");
        }
        assert!(text.contains("sextant.dev/values-hidden"), "{text}");
    }

    #[test]
    fn a_secret_only_on_one_side_lists_its_keys_on_that_side() {
        let (objects, _, _) = manifest_objects_diff(OLD, "");
        let secret = objects
            .iter()
            .find(|o| o.object.kind.kind == "Secret")
            .unwrap();
        assert!(secret.right.is_none());
        let keys = secret.secret_keys.as_ref().unwrap();
        assert!(
            keys.iter().all(|k| k.on_left && !k.on_right && !k.equal),
            "{keys:?}"
        );
        assert!(
            !serde_json::to_string(&objects)
                .unwrap()
                .contains("c2VjcmV0LW9uZQ")
        );
    }

    #[test]
    fn objects_past_the_limit_are_counted_not_compared() {
        let many: String = (0..MAX_REVISION_OBJECTS + 7)
            .map(|i| {
                format!("---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm-{i:04}\n")
            })
            .collect();
        let (objects, unreadable, truncated) = manifest_objects_diff("", &many);
        assert_eq!(objects.len(), MAX_REVISION_OBJECTS);
        assert_eq!((unreadable, truncated), (0, 7));
    }
}
