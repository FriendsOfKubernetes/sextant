//! The two OpenShift actions of the window (#267, ADR-0120), each one POST to an `instantiate` subresource with the
//! body `oc` sends, built here from the object's name only:
//!
//! - "Rollout latest" — `oc rollout latest dc/<name>` (pkg/cli/rollout/latest.go in github.com/openshift/oc): refused
//!   for a paused DeploymentConfig and while the ReplicationController of its latest version (`<name>-<version>`,
//!   `LatestDeploymentNameForConfigAndVersion` in library-go pkg/apps/appsutil) has not terminated (its
//!   `openshift.io/deployment.phase` is neither `Complete` nor `Failed`, `IsTerminatedDeployment`); then a
//!   `DeploymentRequest {name, latest: true, force: true}` to `deploymentconfigs/<name>/instantiate`. `oc`'s fallback
//!   for servers before 1.4 (raising `latestVersion` by an update) is not copied: every OpenShift 3.4+ serves the
//!   subresource, and a refusal there is the answer.
//! - "Start build" — `oc start-build <name>` without flags (pkg/cli/startbuild/startbuild.go): a `BuildRequest` named
//!   after the BuildConfig, `triggeredBy: [{message: "Manually triggered"}]` and the empty Docker and Source strategy
//!   options `oc` always sets, to `buildconfigs/<name>/instantiate`.
//!
//! Sent once (a change is never repeated, ADR-0055). Window only: neither the MCP server nor the extension API offers
//! them. The window shows the same bodies before the user confirms (`src/features/openshift/requests.ts`; a test on
//! each side pins the text).

use k8s_openapi::api::core::v1::ReplicationController;
use kube::Api;
use kube::api::DynamicObject;
use serde_json::{Value, json};

use super::mutate::{object_api, post_params};
use super::{KindRef, ObjectRef};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

pub const APPS_GROUP: &str = "apps.openshift.io";
pub const BUILD_GROUP: &str = "build.openshift.io";
/// The RC annotation the deployer writes (`DeploymentStatusAnnotation`, apps/v1/consts.go in openshift/api).
pub const DEPLOYMENT_PHASE_ANNOTATION: &str = "openshift.io/deployment.phase";

/// What `oc rollout latest` sends for the DeploymentConfig `name`.
pub fn deployment_request(name: &str) -> Value {
    json!({
        "kind": "DeploymentRequest",
        "apiVersion": "apps.openshift.io/v1",
        "name": name,
        "latest": true,
        "force": true,
    })
}

/// What `oc start-build` without flags sends for the BuildConfig `name`.
pub fn build_request(name: &str) -> Value {
    json!({
        "kind": "BuildRequest",
        "apiVersion": "build.openshift.io/v1",
        "metadata": { "name": name },
        "triggeredBy": [{ "message": "Manually triggered" }],
        "sourceStrategyOptions": {},
        "dockerStrategyOptions": {},
    })
}

fn ensure(r: &ObjectRef, group: &str, kind: &str) -> CoreResult<()> {
    if r.kind.group == group && r.kind.kind == kind && !r.name.is_empty() {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!(
                "this action applies to a {kind} only, not to {}",
                r.kind.kind
            ),
        ))
    }
}

/// `oc rollout latest`: starts a new rollout of a DeploymentConfig; returns its new ReplicationController.
pub async fn rollout_latest(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<ObjectRef> {
    ensure(r, APPS_GROUP, "DeploymentConfig")?;
    let namespace = r.required_namespace()?.to_owned();
    let (api, _) = object_api(mgr, cluster, r).await?;
    let config = api.get(&r.name).await?;
    if config.data["spec"]["paused"] == Value::Bool(true) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "cannot deploy a paused deployment config",
        ));
    }
    let version = config.data["status"]["latestVersion"].as_i64().unwrap_or(0);
    let rcs: Api<ReplicationController> = Api::namespaced(mgr.client(cluster)?, &namespace);
    if let Some(rc) = rcs.get_opt(&format!("{}-{version}", r.name)).await? {
        let phase = rc
            .metadata
            .annotations
            .as_ref()
            .and_then(|a| a.get(DEPLOYMENT_PHASE_ANNOTATION))
            .map_or("", String::as_str);
        if phase != "Complete" && phase != "Failed" {
            return Err(CoreError::new(
                ErrorCode::Conflict,
                format!("#{version} is already in progress ({phase})."),
            ));
        }
    }
    let saved: DynamicObject = api
        .create_subresource(
            "instantiate",
            &r.name,
            &post_params(),
            &deployment_request(&r.name),
        )
        .await?;
    let latest = saved.data["status"]["latestVersion"]
        .as_i64()
        .unwrap_or(version + 1);
    Ok(ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "ReplicationController".into(),
        },
        namespace: Some(namespace),
        name: format!("{}-{latest}", r.name),
    })
}

/// `oc start-build`: starts a build of a BuildConfig; returns the new Build.
pub async fn start_build(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    r: &ObjectRef,
) -> CoreResult<ObjectRef> {
    ensure(r, BUILD_GROUP, "BuildConfig")?;
    let namespace = r.required_namespace()?.to_owned();
    let (api, kind) = object_api(mgr, cluster, r).await?;
    let build: DynamicObject = api
        .create_subresource(
            "instantiate",
            &r.name,
            &post_params(),
            &build_request(&r.name),
        )
        .await?;
    Ok(ObjectRef {
        kind: KindRef {
            group: BUILD_GROUP.into(),
            version: kind.resource.version,
            kind: "Build".into(),
        },
        namespace: Some(namespace),
        name: build.metadata.name.unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};

    const DC: &str = r#"{"apiVersion":"apps.openshift.io/v1","kind":"DeploymentConfig","metadata":{"name":"frontend","namespace":"shop","uid":"u1","resourceVersion":"5"},"spec":{"replicas":2,"paused":false},"status":{"latestVersion":3}}"#;
    const PAUSED: &str = r#"{"apiVersion":"apps.openshift.io/v1","kind":"DeploymentConfig","metadata":{"name":"paused","namespace":"shop"},"spec":{"paused":true},"status":{"latestVersion":1}}"#;
    const RUNNING: &str = r#"{"apiVersion":"apps.openshift.io/v1","kind":"DeploymentConfig","metadata":{"name":"busy","namespace":"shop"},"spec":{},"status":{"latestVersion":2}}"#;

    fn rc(name: &str, phase: &str) -> String {
        format!(
            r#"{{"apiVersion":"v1","kind":"ReplicationController","metadata":{{"name":"{name}","namespace":"shop","annotations":{{"openshift.io/deployment.phase":"{phase}"}}}},"spec":{{}}}}"#
        )
    }

    fn openshift(req: &Request) -> Reply {
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/api") => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            ("GET", "/api/v1") => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[
                {"name":"replicationcontrollers","singularName":"replicationcontroller","namespaced":true,"kind":"ReplicationController","verbs":["get","list","watch"]}]}"#,
            ),
            ("GET", "/apis") => Reply::json(
                200,
                r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[
                {"name":"apps.openshift.io","versions":[{"groupVersion":"apps.openshift.io/v1","version":"v1"}],"preferredVersion":{"groupVersion":"apps.openshift.io/v1","version":"v1"}},
                {"name":"build.openshift.io","versions":[{"groupVersion":"build.openshift.io/v1","version":"v1"}],"preferredVersion":{"groupVersion":"build.openshift.io/v1","version":"v1"}}]}"#,
            ),
            ("GET", "/apis/apps.openshift.io/v1") => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"apps.openshift.io/v1","resources":[
                {"name":"deploymentconfigs","singularName":"deploymentconfig","namespaced":true,"kind":"DeploymentConfig","verbs":["get","list","watch","create","update","patch","delete"]},
                {"name":"deploymentconfigs/instantiate","singularName":"","namespaced":true,"kind":"DeploymentRequest","verbs":["create"]}]}"#,
            ),
            ("GET", "/apis/build.openshift.io/v1") => Reply::json(
                200,
                r#"{"kind":"APIResourceList","groupVersion":"build.openshift.io/v1","resources":[
                {"name":"buildconfigs","singularName":"buildconfig","namespaced":true,"kind":"BuildConfig","verbs":["get","list","watch","create","update","patch","delete"]},
                {"name":"buildconfigs/instantiate","singularName":"","namespaced":true,"kind":"BuildRequest","verbs":["create"]},
                {"name":"builds","singularName":"build","namespaced":true,"kind":"Build","verbs":["get","list","watch"]}]}"#,
            ),
            ("GET", "/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/frontend") => {
                Reply::json(200, DC)
            }
            ("GET", "/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/paused") => {
                Reply::json(200, PAUSED)
            }
            ("GET", "/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/busy") => {
                Reply::json(200, RUNNING)
            }
            ("GET", "/api/v1/namespaces/shop/replicationcontrollers/frontend-3") => {
                Reply::json(200, rc("frontend-3", "Complete"))
            }
            ("GET", "/api/v1/namespaces/shop/replicationcontrollers/busy-2") => {
                Reply::json(200, rc("busy-2", "Running"))
            }
            (
                "POST",
                "/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/frontend/instantiate",
            ) => Reply::json(
                201,
                DC.replace(r#""latestVersion":3"#, r#""latestVersion":4"#),
            ),
            (
                "POST",
                "/apis/build.openshift.io/v1/namespaces/shop/buildconfigs/ruby/instantiate",
            ) => Reply::json(
                201,
                r#"{"apiVersion":"build.openshift.io/v1","kind":"Build","metadata":{"name":"ruby-7","namespace":"shop"},"spec":{},"status":{"phase":"New"}}"#,
            ),
            _ => Reply::not_found(),
        }
    }

    fn reference(group: &str, kind: &str, name: &str) -> ObjectRef {
        ObjectRef {
            kind: KindRef {
                group: group.into(),
                version: "v1".into(),
                kind: kind.into(),
            },
            namespace: Some("shop".into()),
            name: name.into(),
        }
    }

    fn changes(api: &FakeApi) -> Vec<Request> {
        api.requests()
            .into_iter()
            .filter(|r| r.method != "GET")
            .collect()
    }

    #[test]
    fn the_bodies_are_what_oc_sends() {
        // Kept equal to `src/features/openshift/requests.ts` (its test pins the same text).
        assert_eq!(
            serde_json::to_string(&deployment_request("frontend")).unwrap(),
            r#"{"apiVersion":"apps.openshift.io/v1","force":true,"kind":"DeploymentRequest","latest":true,"name":"frontend"}"#
        );
        assert_eq!(
            serde_json::to_string(&build_request("ruby")).unwrap(),
            r#"{"apiVersion":"build.openshift.io/v1","dockerStrategyOptions":{},"kind":"BuildRequest","metadata":{"name":"ruby"},"sourceStrategyOptions":{},"triggeredBy":[{"message":"Manually triggered"}]}"#
        );
    }

    #[tokio::test]
    async fn rollout_latest_posts_one_deployment_request_after_the_last_rollout_ended() {
        let api = FakeApi::start(openshift).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let rc = rollout_latest(
            &mgr,
            &id,
            &reference(APPS_GROUP, "DeploymentConfig", "frontend"),
        )
        .await
        .unwrap();
        assert_eq!(rc.name, "frontend-4");
        assert_eq!(rc.kind.kind, "ReplicationController");
        let sent = changes(&api);
        assert_eq!(
            sent.iter().map(Request::line).collect::<Vec<_>>(),
            [
                "POST /apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/frontend/instantiate"
            ]
        );
        let body: Value = serde_json::from_slice(&sent[0].body).unwrap();
        assert_eq!(body, deployment_request("frontend"));
        assert!(
            sent[0].query.contains("fieldManager=sextant"),
            "{}",
            sent[0].query
        );
    }

    #[tokio::test]
    async fn rollout_latest_sends_nothing_for_a_paused_config_or_one_still_rolling_out() {
        let api = FakeApi::start(openshift).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let err = rollout_latest(
            &mgr,
            &id,
            &reference(APPS_GROUP, "DeploymentConfig", "paused"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        let err = rollout_latest(
            &mgr,
            &id,
            &reference(APPS_GROUP, "DeploymentConfig", "busy"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(
            err.message.contains("#2 is already in progress (Running)"),
            "{}",
            err.message
        );
        let err = rollout_latest(&mgr, &id, &reference("apps", "Deployment", "frontend"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(changes(&api).is_empty());
    }

    #[tokio::test]
    async fn start_build_posts_one_build_request_and_names_the_new_build() {
        let api = FakeApi::start(openshift).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let build = start_build(&mgr, &id, &reference(BUILD_GROUP, "BuildConfig", "ruby"))
            .await
            .unwrap();
        assert_eq!(build.name, "ruby-7");
        assert_eq!(build.kind.kind, "Build");
        let sent = changes(&api);
        assert_eq!(
            sent.iter().map(Request::line).collect::<Vec<_>>(),
            ["POST /apis/build.openshift.io/v1/namespaces/shop/buildconfigs/ruby/instantiate"]
        );
        let body: Value = serde_json::from_slice(&sent[0].body).unwrap();
        assert_eq!(body, build_request("ruby"));
        let err = start_build(&mgr, &id, &reference(BUILD_GROUP, "Build", "ruby-6"))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert_eq!(changes(&api).len(), 1);
    }
}
