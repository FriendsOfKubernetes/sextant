//! "Set image…" (#215): the window changes the images of some containers of a Deployment, StatefulSet, DaemonSet,
//! CronJob or bare Pod, as `kubectl set image` does — a strategic-merge patch that names each container by its `name`
//! (the merge key of `containers` and `initContainers`) and carries nothing but its `image`.
//!
//! Before the patch the live object is read and every named container must be in it, in the list the change names,
//! with the image the window showed: otherwise the strategic merge would add a container with only a name and an
//! image, or overwrite a change made meanwhile. The patch carries that read's `resourceVersion`, so a change landing
//! between the read and the patch is refused (`conflict`) instead of merged. Ephemeral containers are never touched
//! (their images cannot change). A Pod a controller owns is refused: its controller would replace it or ignore the
//! change; the window offers its owner instead. Window only: agents have `patch_resource`, extensions nothing new.

use kube::api::{DynamicObject, Patch, PatchParams};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use super::dry_run::compared;
use super::get::ResolvedKind;
use super::mutate::{object_api, patch_params};
use super::{DryRunResult, KindRef, ObjectRef};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// At most this many containers change in one patch.
pub const MAX_IMAGE_CHANGES: usize = 64;
/// The longest image reference accepted (the registry's own limits are lower).
const MAX_IMAGE_LENGTH: usize = 1024;

/// One container's new image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub struct SetImageChange {
    /// The container's `name`.
    pub container: String,
    /// Whether it is in `initContainers` (else `containers`).
    pub init: bool,
    /// The image the window showed; the change is refused when the live one differs.
    pub from: String,
    /// The new image reference.
    pub image: String,
}

/// Where the pod spec is in an object of `kind`; `None` for a kind this action does not change.
pub fn pod_spec_path(kind: &KindRef) -> Option<&'static [&'static str]> {
    match (kind.group.as_str(), kind.kind.as_str()) {
        ("apps", "Deployment" | "StatefulSet" | "DaemonSet") => Some(&["spec", "template", "spec"]),
        ("batch", "CronJob") => Some(&["spec", "jobTemplate", "spec", "template", "spec"]),
        ("", "Pod") => Some(&["spec"]),
        _ => None,
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

/// The changes are well formed: some, at most [`MAX_IMAGE_CHANGES`], each container once, every image a plausible
/// reference (the window checks the full grammar; here: not empty, no spaces or control characters, bounded).
pub fn check_changes(changes: &[SetImageChange]) -> CoreResult<()> {
    if changes.is_empty() {
        return Err(invalid("no image to change"));
    }
    if changes.len() > MAX_IMAGE_CHANGES {
        return Err(invalid(format!(
            "at most {MAX_IMAGE_CHANGES} containers can change at once"
        )));
    }
    for (index, change) in changes.iter().enumerate() {
        if change.container.is_empty() {
            return Err(invalid("a container name is empty"));
        }
        let twice = changes[..index]
            .iter()
            .any(|c| c.container == change.container && c.init == change.init);
        if twice {
            return Err(invalid(format!(
                "container {} is named twice",
                change.container
            )));
        }
        let image = &change.image;
        let bad = image.is_empty()
            || image.len() > MAX_IMAGE_LENGTH
            || image.chars().any(|c| c.is_whitespace() || c.is_control());
        if bad {
            return Err(invalid(format!(
                "the image of container {} is not an image reference",
                change.container
            )));
        }
    }
    Ok(())
}

/// The strategic-merge patch: under the pod spec of `kind`, `containers` and/or `initContainers` with
/// `{name, image}` of each changed container, and `metadata.resourceVersion` when given. Nothing else.
pub fn image_patch(
    kind: &KindRef,
    changes: &[SetImageChange],
    resource_version: Option<&str>,
) -> CoreResult<Value> {
    let path = pod_spec_path(kind)
        .ok_or_else(|| invalid(format!("images of a {} cannot be set", kind.kind)))?;
    check_changes(changes)?;
    let mut spec = Map::new();
    for (list, init) in [("initContainers", true), ("containers", false)] {
        let entries: Vec<Value> = changes
            .iter()
            .filter(|c| c.init == init)
            .map(|c| json!({ "name": c.container, "image": c.image }))
            .collect();
        if !entries.is_empty() {
            spec.insert(list.to_owned(), Value::Array(entries));
        }
    }
    let mut body = Value::Object(spec);
    for key in path.iter().rev() {
        body = json!({ *key: body });
    }
    if let Some(version) = resource_version {
        body["metadata"] = json!({ "resourceVersion": version });
    }
    Ok(body)
}

/// The live object allows the changes: a Pod no controller owns, and every container in the list the change names,
/// with the image the window showed.
fn check_live(kind: &KindRef, live: &DynamicObject, changes: &[SetImageChange]) -> CoreResult<()> {
    if kind.group.is_empty() && kind.kind == "Pod" {
        let owners = live
            .metadata
            .owner_references
            .as_deref()
            .unwrap_or_default();
        if let Some(owner) = owners.iter().find(|o| o.controller == Some(true)) {
            return Err(invalid(format!(
                "this Pod is managed by {} {}: set the image there",
                owner.kind, owner.name
            )));
        }
    }
    let mut spec = &live.data;
    for key in pod_spec_path(kind).unwrap_or_default() {
        spec = &spec[*key];
    }
    for change in changes {
        let list = if change.init {
            "initContainers"
        } else {
            "containers"
        };
        let found = spec[list].as_array().and_then(|items| {
            items
                .iter()
                .find(|c| c["name"].as_str() == Some(change.container.as_str()))
        });
        let Some(container) = found else {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!("there is no container {} in {list}", change.container),
            ));
        };
        if container["image"].as_str().unwrap_or_default() != change.from {
            return Err(CoreError::new(
                ErrorCode::Conflict,
                format!(
                    "the image of container {} has changed since it was shown; reopen the dialog",
                    change.container
                ),
            ));
        }
    }
    Ok(())
}

/// The live object, checked, and the patch for it (with its `resourceVersion`).
async fn prepare(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    changes: &[SetImageChange],
) -> CoreResult<(kube::Api<DynamicObject>, ResolvedKind, DynamicObject, Value)> {
    if pod_spec_path(&r.kind).is_none() {
        return Err(invalid(format!(
            "images of a {} cannot be set",
            r.kind.kind
        )));
    }
    check_changes(changes)?;
    let (api, kind) = object_api(mgr, cluster, r).await?;
    let live = api.get(&r.name).await?;
    check_live(&r.kind, &live, changes)?;
    let body = image_patch(&r.kind, changes, live.metadata.resource_version.as_deref())?;
    Ok((api, kind, live, body))
}

/// Sets the images: one strategic-merge patch signed by Sextant's field manager, never repeated.
pub async fn set_images(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    changes: &[SetImageChange],
) -> CoreResult<()> {
    let (api, _, _, body) = prepare(mgr, cluster, r, changes).await?;
    api.patch(&r.name, &patch_params(), &Patch::Strategic(&body))
        .await?;
    Ok(())
}

/// The same patch with `dryRun=All`: the live object against what the API server would store.
pub async fn dry_run_set_images(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
    changes: &[SetImageChange],
) -> CoreResult<DryRunResult> {
    let (api, kind, live, body) = prepare(mgr, cluster, r, changes).await?;
    let params = PatchParams {
        dry_run: true,
        ..patch_params()
    };
    let after = api
        .patch(&r.name, &params, &Patch::Strategic(&body))
        .await?;
    let object = compared(r.clone(), String::new(), &kind, Some(live), after)?;
    Ok(DryRunResult {
        objects: vec![object],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

    fn kind(group: &str, kind: &str) -> KindRef {
        KindRef {
            group: group.into(),
            version: "v1".into(),
            kind: kind.into(),
        }
    }

    fn change(container: &str, init: bool, from: &str, image: &str) -> SetImageChange {
        SetImageChange {
            container: container.into(),
            init,
            from: from.into(),
            image: image.into(),
        }
    }

    #[test]
    fn the_patch_names_only_the_changed_containers_under_each_kinds_pod_spec() {
        let changes = [
            change("web", false, "nginx:1.25", "nginx:1.27"),
            change("migrate", true, "tool:1", "tool:2"),
        ];
        let lists = json!({
            "initContainers": [{ "name": "migrate", "image": "tool:2" }],
            "containers": [{ "name": "web", "image": "nginx:1.27" }]
        });
        for workload in ["Deployment", "StatefulSet", "DaemonSet"] {
            assert_eq!(
                image_patch(&kind("apps", workload), &changes, Some("41")).unwrap(),
                json!({ "metadata": { "resourceVersion": "41" }, "spec": { "template": { "spec": lists } } }),
                "{workload}"
            );
        }
        assert_eq!(
            image_patch(&kind("batch", "CronJob"), &changes, None).unwrap(),
            json!({ "spec": { "jobTemplate": { "spec": { "template": { "spec": lists } } } } })
        );
        assert_eq!(
            image_patch(&kind("", "Pod"), &changes[..1], None).unwrap(),
            json!({ "spec": { "containers": [{ "name": "web", "image": "nginx:1.27" }] } })
        );
    }

    #[test]
    fn other_kinds_and_malformed_changes_are_refused() {
        let ok = [change("web", false, "a", "b")];
        for (group, other) in [("apps", "ReplicaSet"), ("batch", "Job"), ("", "ConfigMap")] {
            let err = image_patch(&kind(group, other), &ok, None).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{other}");
        }
        let cases: Vec<Vec<SetImageChange>> = vec![
            vec![],
            vec![change("", false, "a", "b")],
            vec![change("web", false, "a", "")],
            vec![change("web", false, "a", "nginx :1")],
            vec![change("web", false, "a", "nginx\n")],
            vec![change("web", false, "a", &"x".repeat(MAX_IMAGE_LENGTH + 1))],
            vec![
                change("web", false, "a", "b"),
                change("web", false, "a", "c"),
            ],
            (0..=MAX_IMAGE_CHANGES)
                .map(|i| change(&format!("c{i}"), false, "a", "b"))
                .collect(),
        ];
        for changes in cases {
            assert_eq!(
                check_changes(&changes).unwrap_err().code,
                ErrorCode::Invalid,
                "{changes:?}"
            );
        }
    }

    fn deployment(image: &str) -> Value {
        json!({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": { "name": "web", "namespace": "ns", "resourceVersion": "41" },
            "spec": { "replicas": 2, "template": { "spec": {
                "initContainers": [{ "name": "migrate", "image": "tool:1" }],
                "containers": [{ "name": "web", "image": image }, { "name": "proxy", "image": "envoy:1" }]
            } } }
        })
    }

    fn pod(owned: bool) -> Value {
        let mut pod = json!({
            "apiVersion": "v1", "kind": "Pod",
            "metadata": { "name": "web", "namespace": "ns", "resourceVersion": "7" },
            "spec": { "containers": [{ "name": "web", "image": "nginx:1.25" }] }
        });
        if owned {
            pod["metadata"]["ownerReferences"] = json!([{
                "apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "web-abc", "uid": "u", "controller": true
            }]);
        }
        pod
    }

    fn server(
        live: Value,
        path: &'static str,
    ) -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        move |req: &Request| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(200, API_VERSIONS),
            ("GET", p) if p == path => Reply::json(200, live.to_string()),
            ("PATCH", p) if p == path => {
                let mut after = live.clone();
                if let Some(image) = after.pointer_mut("/spec/template/spec/containers/0/image") {
                    *image = json!("nginx:1.27");
                }
                Reply::json(200, after.to_string())
            }
            _ => Reply::not_found(),
        }
    }

    const DEPLOYMENT: &str = "/apis/apps/v1/namespaces/ns/deployments/web";

    fn object(group: &str, k: &str) -> ObjectRef {
        ObjectRef {
            kind: kind(group, k),
            namespace: Some("ns".into()),
            name: "web".into(),
        }
    }

    fn patches(api: &FakeApi) -> Vec<Request> {
        api.requests()
            .into_iter()
            .filter(|r| r.method == "PATCH")
            .collect()
    }

    #[tokio::test]
    async fn setting_an_image_sends_one_strategic_merge_patch_of_the_image_only() {
        let api = FakeApi::start(server(deployment("nginx:1.25"), DEPLOYMENT)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let changes = [change("web", false, "nginx:1.25", "nginx:1.27")];
        set_images(&mgr, &id, &object("apps", "Deployment"), &changes)
            .await
            .unwrap();
        let sent = patches(&api);
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].header("content-type"),
            "application/strategic-merge-patch+json"
        );
        assert!(
            sent[0].query.contains("fieldManager=sextant"),
            "{}",
            sent[0].query
        );
        assert!(!sent[0].query.contains("dryRun"), "{}", sent[0].query);
        let body: Value = serde_json::from_slice(&sent[0].body).unwrap();
        assert_eq!(
            body,
            json!({
                "metadata": { "resourceVersion": "41" },
                "spec": { "template": { "spec": { "containers": [{ "name": "web", "image": "nginx:1.27" }] } } }
            })
        );
    }

    #[tokio::test]
    async fn the_dry_run_sends_the_same_patch_with_dry_run_and_shows_both_sides() {
        let api = FakeApi::start(server(deployment("nginx:1.25"), DEPLOYMENT)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let changes = [change("web", false, "nginx:1.25", "nginx:1.27")];
        let result = dry_run_set_images(&mgr, &id, &object("apps", "Deployment"), &changes)
            .await
            .unwrap();
        let sent = patches(&api);
        assert_eq!(sent.len(), 1);
        assert!(sent[0].query.contains("dryRun=All"), "{}", sent[0].query);
        let [object] = result.objects.as_slice() else {
            panic!("{result:?}")
        };
        assert_eq!(object.change, crate::resources::DryRunChange::Update);
        let image = |side: &Option<Value>| {
            side.as_ref().unwrap()["spec"]["template"]["spec"]["containers"][0]["image"].clone()
        };
        assert_eq!(image(&object.before), json!("nginx:1.25"));
        assert_eq!(image(&object.after), json!("nginx:1.27"));
    }

    #[tokio::test]
    async fn a_missing_container_a_changed_image_or_an_owned_pod_sends_nothing() {
        let api = FakeApi::start(server(deployment("nginx:1.26"), DEPLOYMENT)).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let target = object("apps", "Deployment");
        let cases = [
            (
                change("web", false, "nginx:1.25", "nginx:1.27"),
                ErrorCode::Conflict,
            ),
            (change("sidecar", false, "x:1", "x:2"), ErrorCode::NotFound),
            // An init container is looked for among the init containers only.
            (
                change("web", true, "nginx:1.26", "nginx:1.27"),
                ErrorCode::NotFound,
            ),
        ];
        for (change, code) in cases {
            let err = set_images(&mgr, &id, &target, std::slice::from_ref(&change))
                .await
                .unwrap_err();
            assert_eq!(err.code, code, "{change:?}");
            let err = dry_run_set_images(&mgr, &id, &target, std::slice::from_ref(&change))
                .await
                .unwrap_err();
            assert_eq!(err.code, code, "{change:?}");
        }
        assert!(patches(&api).is_empty());

        let api = FakeApi::start(server(pod(true), "/api/v1/namespaces/ns/pods/web")).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let changes = [change("web", false, "nginx:1.25", "nginx:1.27")];
        let err = set_images(&mgr, &id, &object("", "Pod"), &changes)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(
            err.message.contains("ReplicaSet web-abc"),
            "{}",
            err.message
        );
        assert!(patches(&api).is_empty());
    }

    #[tokio::test]
    async fn a_bare_pod_gets_its_image_in_place() {
        let api = FakeApi::start(server(pod(false), "/api/v1/namespaces/ns/pods/web")).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let changes = [change("web", false, "nginx:1.25", "nginx:1.27")];
        set_images(&mgr, &id, &object("", "Pod"), &changes)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&patches(&api)[0].body).unwrap();
        assert_eq!(
            body,
            json!({
                "metadata": { "resourceVersion": "7" },
                "spec": { "containers": [{ "name": "web", "image": "nginx:1.27" }] }
            })
        );
    }
}
