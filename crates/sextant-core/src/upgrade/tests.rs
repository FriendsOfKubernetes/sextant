use std::io::Write;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::json;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

fn kind(group: &str, version: &str, kind: &str) -> KindRef {
    KindRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: kind.to_owned(),
    }
}

fn api(group: &str, version: &str, k: &str, replacement: Option<(&str, &str)>) -> ScanApi {
    ScanApi {
        api: kind(group, version, k),
        replacement: replacement.map(|(g, v)| kind(g, v, k)),
    }
}

fn request() -> Vec<ScanApi> {
    vec![
        api(
            "extensions",
            "v1beta1",
            "Ingress",
            Some(("networking.k8s.io", "v1")),
        ),
        api(
            "networking.k8s.io",
            "v1beta1",
            "Ingress",
            Some(("networking.k8s.io", "v1")),
        ),
        api(
            "policy",
            "v1beta1",
            "PodDisruptionBudget",
            Some(("policy", "v1")),
        ),
        api("policy", "v1beta1", "PodSecurityPolicy", None),
        api("batch", "v1beta1", "CronJob", Some(("batch", "v1"))),
    ]
}

/// Not a real value: what the test looks for in every answer.
const SECRET_MARK: &str = "U0VYVEFOVC1VUEdSQURFLVNFQ1JFVA";

#[test]
fn the_request_is_checked_before_anything_is_sent() {
    assert!(check_apis(&request()).is_ok());
    for bad in [
        api("apps", "", "Deployment", None),
        api("apps", "v1", "", None),
        api("apps/x", "v1", "Deployment", None),
        api("apps", "v1", "Deploy?ment", None),
        api("apps", "v1", "Deployment", Some(("a b", "v1"))),
    ] {
        let err = check_apis(std::slice::from_ref(&bad)).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{bad:?}");
    }
    let many = vec![request()[0].clone(); MAX_APIS + 1];
    assert_eq!(check_apis(&many).unwrap_err().code, ErrorCode::Invalid);
}

#[test]
fn last_applied_and_field_managers_name_the_versions_clients_used() {
    let wanted = Wanted::new(&request());
    let meta: k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta =
        serde_json::from_value(json!({
            "name": "web",
            "namespace": "shop",
            "annotations": {
                LAST_APPLIED: r#"{"apiVersion":"extensions/v1beta1","kind":"Ingress","metadata":{"name":"web"}}"#
            },
            "managedFields": [
                { "manager": "helm", "operation": "Update", "apiVersion": "networking.k8s.io/v1beta1" },
                { "manager": "kube-controller-manager", "operation": "Update", "apiVersion": "networking.k8s.io/v1" },
                { "manager": "odd", "operation": "Update", "apiVersion": "policy/v1beta1" }
            ]
        }))
        .unwrap();
    let found = usages_of_meta(&meta, "Ingress", &wanted);
    assert_eq!(
        found,
        vec![
            ApiUsage {
                api: kind("extensions", "v1beta1", "Ingress"),
                namespace: Some("shop".into()),
                name: "web".into(),
                origin: UsageOrigin::LastApplied,
            },
            ApiUsage {
                api: kind("networking.k8s.io", "v1beta1", "Ingress"),
                namespace: Some("shop".into()),
                name: "web".into(),
                origin: UsageOrigin::ManagedFields {
                    manager: "helm".into()
                },
            },
        ]
    );
}

#[test]
fn a_manifest_gives_only_version_kind_name_and_namespace_of_matching_documents() {
    let wanted = Wanted::new(&request());
    let manifest = format!(
        "---\n# Source: shop/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\ndata:\n  password: {SECRET_MARK}\n\
         ---\n# Source: shop/templates/cron.yaml\napiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: nightly\n\
         ---\napiVersion: policy/v1beta1\nkind: PodSecurityPolicy\nmetadata:\n  name: restricted\n\
         ---\napiVersion: policy/v1beta1\nkind: PodDisruptionBudget\nmetadata:\n  name: web\n  namespace: other\n\
         ---\nnot: [valid\n\
         --- # a comment after the marker\napiVersion: extensions/v1beta1\nkind: Ingress\nmetadata:\n  name: after-a-broken-one\n"
    );
    let scoped: HashSet<String> = ["PodSecurityPolicy".to_owned()].into();
    let found = manifest_usages(&manifest, &wanted, "shop", &scoped);
    assert_eq!(
        found,
        vec![
            (
                kind("batch", "v1beta1", "CronJob"),
                Some("shop".into()),
                "nightly".into()
            ),
            (
                kind("policy", "v1beta1", "PodSecurityPolicy"),
                None,
                "restricted".into()
            ),
            (
                kind("policy", "v1beta1", "PodDisruptionBudget"),
                Some("other".into()),
                "web".into()
            ),
            (
                kind("extensions", "v1beta1", "Ingress"),
                Some("shop".into()),
                "after-a-broken-one".into()
            ),
        ]
    );
}

#[test]
fn live_objects_are_listed_through_the_served_replacement_first() {
    let served = |group: &str, version: &str, k: &str, plural: &str| ResourceKind {
        kind_ref: kind(group, version, k),
        plural: plural.into(),
        namespaced: true,
        verbs: vec!["list".into(), "watch".into()],
        printer_columns: Vec::new(),
    };
    let kinds = vec![
        served("extensions", "v1beta1", "Ingress", "ingresses"),
        served("networking.k8s.io", "v1", "Ingress", "ingresses"),
        served(
            "policy",
            "v1beta1",
            "PodSecurityPolicy",
            "podsecuritypolicies",
        ),
    ];
    let targets: Vec<KindRef> = live_targets(&kinds, &request())
        .into_iter()
        .map(|k| k.kind_ref)
        .collect();
    // Ingress once, through networking.k8s.io/v1; CronJob and PodDisruptionBudget are not served at all.
    assert_eq!(
        targets,
        vec![
            kind("networking.k8s.io", "v1", "Ingress"),
            kind("policy", "v1beta1", "PodSecurityPolicy"),
        ]
    );
}

#[test]
fn image_tags_are_the_component_versions() {
    assert_eq!(
        image_tag("registry.k8s.io/kube-apiserver:v1.31.4"),
        "v1.31.4"
    );
    assert_eq!(
        image_tag("localhost:5000/kube-scheduler:v1.30.0@sha256:abc"),
        "v1.30.0"
    );
    assert_eq!(image_tag("localhost:5000/kube-scheduler"), "");
}

// --- Against the fake API server ---------------------------------------------------------------------------------

fn resource_list(gv: &str, resources: &[(&str, &str, bool, &[&str])]) -> String {
    let resources: Vec<Value> = resources
        .iter()
        .map(|(plural, kind, namespaced, verbs)| {
            json!({ "name": plural, "singularName": "", "namespaced": namespaced, "kind": kind, "verbs": verbs })
        })
        .collect();
    json!({ "kind": "APIResourceList", "groupVersion": gv, "resources": resources }).to_string()
}

fn group(name: &str, versions: &[&str]) -> Value {
    json!({
        "name": name,
        "versions": versions.iter().map(|v| json!({ "groupVersion": format!("{name}/{v}"), "version": v })).collect::<Vec<_>>(),
        "preferredVersion": { "groupVersion": format!("{name}/{}", versions[0]), "version": versions[0] },
    })
}

fn list(kind: &str, items: Vec<Value>) -> Reply {
    Reply::json(
        200,
        json!({ "apiVersion": "v1", "kind": kind, "metadata": { "resourceVersion": "1" }, "items": items })
            .to_string(),
    )
}

fn forbidden() -> Reply {
    Reply::json(
        403,
        r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"poddisruptionbudgets.policy is forbidden","reason":"Forbidden","code":403}"#,
    )
}

/// `data.release` as Kubernetes hands it back: base64 text of gzipped JSON.
fn encoded_release(manifest: &str) -> String {
    let release = json!({
        "name": "shop",
        "namespace": "shop",
        "version": 3,
        "info": { "status": "deployed", "last_deployed": "2026-10-12T10:00:00Z" },
        "chart": { "metadata": { "name": "shop", "version": "1.0.0", "appVersion": "1" } },
        "config": { "password": SECRET_MARK },
        "manifest": manifest,
    });
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(release.to_string().as_bytes()).unwrap();
    let stored = STANDARD.encode(enc.finish().unwrap());
    STANDARD.encode(stored)
}

fn release_metadata() -> Value {
    json!({
        "name": "sh.helm.release.v1.shop.v3",
        "namespace": "shop",
        "uid": "upgrade-test-shop-3",
        "resourceVersion": "7",
        "labels": { "owner": "helm", "name": "shop", "version": "3", "status": "deployed" },
    })
}

async fn cluster() -> FakeApi {
    let manifest = format!(
        "---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: creds\ndata:\n  password: {SECRET_MARK}\n\
         ---\napiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: nightly\n"
    );
    let release = encoded_release(&manifest);
    FakeApi::start(move |req: &Request| {
        let metadata_only = req.header("accept").contains("as=PartialObjectMetadataList");
        match req.path.as_str() {
            "/version" => Reply::json(
                200,
                json!({
                    "major": "1", "minor": "31", "gitVersion": "v1.31.4", "gitCommit": "x", "gitTreeState": "clean",
                    "buildDate": "2026-01-01T00:00:00Z", "goVersion": "go1.23", "compiler": "gc", "platform": "linux/amd64"
                })
                .to_string(),
            ),
            "/api" => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            "/api/v1" => Reply::json(
                200,
                resource_list(
                    "v1",
                    &[
                        ("nodes", "Node", false, &["list"]),
                        ("pods", "Pod", true, &["list"]),
                        ("secrets", "Secret", true, &["list"]),
                    ],
                ),
            ),
            "/apis" => Reply::json(
                200,
                json!({
                    "kind": "APIGroupList",
                    "apiVersion": "v1",
                    "groups": [
                        group("networking.k8s.io", &["v1", "v1beta1"]),
                        group("policy", &["v1", "v1beta1"]),
                        group("argoproj.io", &["v1alpha1"]),
                        group("kustomize.toolkit.fluxcd.io", &["v1"]),
                    ],
                })
                .to_string(),
            ),
            "/apis/networking.k8s.io/v1" | "/apis/networking.k8s.io/v1beta1" => Reply::json(
                200,
                resource_list(
                    &req.path["/apis/".len()..],
                    &[("ingresses", "Ingress", true, &["list", "watch"])],
                ),
            ),
            "/apis/policy/v1" => Reply::json(
                200,
                resource_list(
                    "policy/v1",
                    &[("poddisruptionbudgets", "PodDisruptionBudget", true, &["list"])],
                ),
            ),
            "/apis/policy/v1beta1" => Reply::json(
                200,
                resource_list(
                    "policy/v1beta1",
                    &[
                        ("poddisruptionbudgets", "PodDisruptionBudget", true, &["list"]),
                        ("podsecuritypolicies", "PodSecurityPolicy", false, &["list"]),
                    ],
                ),
            ),
            "/apis/argoproj.io/v1alpha1" => Reply::json(
                200,
                resource_list(
                    "argoproj.io/v1alpha1",
                    &[("applications", "Application", true, &["list"])],
                ),
            ),
            "/apis/kustomize.toolkit.fluxcd.io/v1" => Reply::json(
                200,
                resource_list(
                    "kustomize.toolkit.fluxcd.io/v1",
                    &[("kustomizations", "Kustomization", true, &["list"])],
                ),
            ),
            "/apis/networking.k8s.io/v1/ingresses" if metadata_only => list(
                "PartialObjectMetadataList",
                vec![json!({
                    "apiVersion": "meta.k8s.io/v1",
                    "kind": "PartialObjectMetadata",
                    "metadata": {
                        "name": "web",
                        "namespace": "shop",
                        "annotations": {
                            LAST_APPLIED: format!(r#"{{"apiVersion":"extensions/v1beta1","kind":"Ingress","metadata":{{"name":"web","annotations":{{"token":"{SECRET_MARK}"}}}}}}"#)
                        },
                        "managedFields": [
                            { "manager": "helm", "operation": "Update", "apiVersion": "networking.k8s.io/v1beta1" },
                            { "manager": "kubectl", "operation": "Apply", "apiVersion": "networking.k8s.io/v1" }
                        ]
                    }
                })],
            ),
            "/apis/policy/v1/poddisruptionbudgets" => forbidden(),
            "/apis/policy/v1beta1/podsecuritypolicies" if metadata_only => {
                list("PartialObjectMetadataList", Vec::new())
            }
            "/apis/argoproj.io/v1alpha1/applications" => list(
                "ApplicationList",
                vec![json!({
                    "apiVersion": "argoproj.io/v1alpha1",
                    "kind": "Application",
                    "metadata": { "name": "apps", "namespace": "argocd" },
                    "status": { "resources": [
                        { "group": "policy", "version": "v1beta1", "kind": "PodDisruptionBudget", "namespace": "shop", "name": "web-pdb" },
                        { "group": "apps", "version": "v1", "kind": "Deployment", "namespace": "shop", "name": "web" }
                    ] }
                })],
            ),
            "/apis/kustomize.toolkit.fluxcd.io/v1/kustomizations" => list(
                "KustomizationList",
                vec![json!({
                    "apiVersion": "kustomize.toolkit.fluxcd.io/v1",
                    "kind": "Kustomization",
                    "metadata": { "name": "infra", "namespace": "flux-system" },
                    "status": { "inventory": { "entries": [
                        { "id": "shop_web_networking.k8s.io_Ingress", "v": "v1beta1" },
                        { "id": "_restricted_policy_PodSecurityPolicy", "v": "v1beta1" },
                        { "id": "shop_web_apps_Deployment", "v": "v1" }
                    ] } }
                })],
            ),
            "/api/v1/nodes" => list(
                "NodeList",
                vec![
                    json!({
                        "apiVersion": "v1", "kind": "Node",
                        "metadata": { "name": "cp-1", "labels": { "node-role.kubernetes.io/control-plane": "" } },
                        "status": { "nodeInfo": { "kubeletVersion": "v1.31.4", "kubeProxyVersion": "v1.31.4",
                            "machineID": "", "systemUUID": "", "bootID": "", "kernelVersion": "", "osImage": "",
                            "containerRuntimeVersion": "", "operatingSystem": "linux", "architecture": "amd64" } }
                    }),
                    json!({
                        "apiVersion": "v1", "kind": "Node",
                        "metadata": { "name": "worker-1" },
                        "status": { "nodeInfo": { "kubeletVersion": "v1.28.2",
                            "machineID": "", "systemUUID": "", "bootID": "", "kernelVersion": "", "osImage": "",
                            "containerRuntimeVersion": "", "operatingSystem": "linux", "architecture": "amd64" } }
                    }),
                ],
            ),
            "/api/v1/namespaces/kube-system/pods" => list(
                "PodList",
                vec![json!({
                    "apiVersion": "v1", "kind": "Pod",
                    "metadata": { "name": "kube-apiserver-cp-1", "namespace": "kube-system",
                        "labels": { "component": "kube-apiserver", "tier": "control-plane" } },
                    "spec": { "nodeName": "cp-1", "containers": [
                        { "name": "kube-apiserver", "image": "registry.k8s.io/kube-apiserver:v1.31.4" }
                    ] }
                })],
            ),
            "/api/v1/secrets" if metadata_only => list(
                "PartialObjectMetadataList",
                vec![json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": release_metadata() })],
            ),
            "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.shop.v3" => Reply::json(
                200,
                json!({
                    "apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
                    "metadata": release_metadata(),
                    "data": { "release": release },
                })
                .to_string(),
            ),
            _ => Reply::not_found(),
        }
    })
    .await
}

fn report(scan: &UpgradeScan, source: ScanSource) -> &SourceReport {
    scan.sources.iter().find(|s| s.source == source).unwrap()
}

#[tokio::test]
async fn a_scan_reports_served_versions_usages_from_every_source_and_versions() {
    let api = cluster().await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;

    let scan = scan(&mgr, &id, request()).await.unwrap();

    assert_eq!(scan.version.as_ref().unwrap().git_version, "v1.31.4");
    assert_eq!(
        scan.served,
        vec![
            kind("networking.k8s.io", "v1beta1", "Ingress"),
            kind("policy", "v1beta1", "PodDisruptionBudget"),
            kind("policy", "v1beta1", "PodSecurityPolicy"),
        ]
    );

    let mut origins: Vec<(String, String, String)> = scan
        .usages
        .iter()
        .map(|u| {
            (
                format!("{}/{} {}", u.api.group, u.api.version, u.api.kind),
                format!("{}/{}", u.namespace.as_deref().unwrap_or("-"), u.name),
                serde_json::to_value(&u.origin).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_owned(),
            )
        })
        .collect();
    origins.sort();
    let row = |a: &str, b: &str, c: &str| (a.to_owned(), b.to_owned(), c.to_owned());
    assert_eq!(
        origins,
        vec![
            row("batch/v1beta1 CronJob", "shop/nightly", "helm"),
            row("extensions/v1beta1 Ingress", "shop/web", "lastApplied"),
            row("networking.k8s.io/v1beta1 Ingress", "shop/web", "flux"),
            row(
                "networking.k8s.io/v1beta1 Ingress",
                "shop/web",
                "managedFields"
            ),
            row(
                "policy/v1beta1 PodDisruptionBudget",
                "shop/web-pdb",
                "argoCd"
            ),
            row("policy/v1beta1 PodSecurityPolicy", "-/restricted", "flux"),
        ]
    );
    assert!(scan.usages.iter().any(|u| u.origin
        == UsageOrigin::Helm {
            release: "shop".into(),
            namespace: "shop".into(),
            revision: 3
        }));

    // A kind the user may not list is skipped, the rest of the source carries on.
    let live = report(&scan, ScanSource::Live);
    assert_eq!(live.outcome, SourceOutcome::Done);
    assert_eq!(
        live.skipped,
        vec![kind("policy", "v1", "PodDisruptionBudget")]
    );
    assert_eq!(live.error.as_ref().unwrap().code, ErrorCode::Forbidden);

    assert_eq!(scan.nodes.len(), 2);
    assert_eq!(scan.nodes[0].kubelet_version, "v1.31.4");
    assert!(scan.nodes[0].control_plane);
    assert_eq!(scan.nodes[1].kubelet_version, "v1.28.2");
    assert!(!scan.nodes[1].control_plane);
    assert_eq!(scan.components.len(), 1);
    assert_eq!(scan.components[0].component, "kube-apiserver");
    assert_eq!(scan.components[0].version, "v1.31.4");

    // Nothing of a manifest, a value or an annotation's text leaves the core.
    let text = serde_json::to_string(&scan).unwrap();
    assert!(!text.contains(SECRET_MARK), "{text}");
    assert!(!text.contains("creds"), "{text}");
    // Nothing is written.
    assert!(api.requests().iter().all(|r| r.method == "GET"));
}

#[tokio::test]
async fn tools_that_are_not_installed_are_reported_so_and_a_failed_source_does_not_fail_the_scan() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(
            200,
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
        ),
        "/api/v1" => Reply::json(200, resource_list("v1", &[])),
        "/apis" => Reply::json(
            200,
            r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#,
        ),
        "/api/v1/nodes" | "/api/v1/secrets" => forbidden(),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let scan = scan(&mgr, &id, request()).await.unwrap();
    assert!(scan.version.is_none());
    assert_eq!(
        report(&scan, ScanSource::Version).outcome,
        SourceOutcome::Failed
    );
    assert_eq!(
        report(&scan, ScanSource::ArgoCd).outcome,
        SourceOutcome::NotInstalled
    );
    assert_eq!(
        report(&scan, ScanSource::Flux).outcome,
        SourceOutcome::NotInstalled
    );
    assert_eq!(
        report(&scan, ScanSource::Nodes).outcome,
        SourceOutcome::Failed
    );
    assert_eq!(
        report(&scan, ScanSource::Helm).outcome,
        SourceOutcome::Failed
    );
    assert_eq!(report(&scan, ScanSource::Live).outcome, SourceOutcome::Done);
    assert!(scan.served.is_empty() && scan.usages.is_empty());
}

#[tokio::test]
async fn a_cluster_that_is_not_connected_is_not_found_and_bad_input_is_invalid_first() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(
            200,
            r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
        ),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, _id) = connected_to(api.url()).await;
    let nope = ClusterId("nope".to_owned());
    let err = scan(&mgr, &nope, request()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = scan(&mgr, &nope, vec![api_bad()]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
}

fn api_bad() -> ScanApi {
    api("apps", "", "Deployment", None)
}

/// `data.release` of a Secret whose gzip unpacks past `helm::MAX_RELEASE_BYTES` (a few dozen KiB packed).
fn bomb_release() -> String {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    let chunk = vec![b' '; 1 << 20];
    for _ in 0..=(helm::MAX_RELEASE_BYTES >> 20) {
        enc.write_all(&chunk).unwrap();
    }
    STANDARD.encode(STANDARD.encode(enc.finish().unwrap()))
}

fn release_meta(namespace: &str, name: &str, revision: i32, status: &str) -> Value {
    json!({
        "name": format!("sh.helm.release.v1.{name}.v{revision}"),
        "namespace": namespace,
        "uid": format!("upgrade-ns-test-{namespace}-{name}-{revision}"),
        "resourceVersion": "1",
        "labels": { "owner": "helm", "name": name, "version": revision.to_string(), "status": status },
    })
}

#[tokio::test]
async fn helm_releases_are_read_per_namespace_when_secrets_cannot_be_listed_across_the_cluster() {
    let manifest = "---\napiVersion: policy/v1beta1\nkind: PodSecurityPolicy\nmetadata:\n  name: restricted\n\
                    ---\napiVersion: batch/v1beta1\nkind: CronJob\nmetadata:\n  name: nightly\n";
    let good = encoded_release(manifest);
    let bomb = bomb_release();
    let api = FakeApi::start(move |req: &Request| {
        let metadata_only = req.header("accept").contains("as=PartialObjectMetadataList");
        let meta = |items: Vec<Value>| {
            list(
                "PartialObjectMetadataList",
                items
                    .into_iter()
                    .map(|m| json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": m }))
                    .collect(),
            )
        };
        let secret = |m: Value, data: &str| {
            Reply::json(
                200,
                json!({ "apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1", "metadata": m, "data": { "release": data } })
                    .to_string(),
            )
        };
        match req.path.as_str() {
            "/api" => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            "/api/v1" => Reply::json(200, resource_list("v1", &[])),
            "/apis" => Reply::json(200, r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#),
            "/api/v1/secrets" => forbidden(),
            "/api/v1/namespaces" if metadata_only => meta(vec![
                json!({ "name": "shop" }),
                json!({ "name": "locked" }),
            ]),
            "/api/v1/namespaces/shop/secrets" if metadata_only => meta(vec![
                release_metadata(),
                release_meta("shop", "shop", 2, "superseded"),
                release_meta("shop", "bomb", 1, "deployed"),
                release_meta("shop", "gone", 4, "uninstalled"),
            ]),
            "/api/v1/namespaces/locked/secrets" => forbidden(),
            "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.shop.v3" => {
                secret(release_metadata(), &good)
            }
            "/api/v1/namespaces/shop/secrets/sh.helm.release.v1.bomb.v1" => {
                secret(release_meta("shop", "bomb", 1, "deployed"), &bomb)
            }
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let scan = scan(&mgr, &id, request()).await.unwrap();

    let helm = report(&scan, ScanSource::Helm);
    assert_eq!(helm.outcome, SourceOutcome::Done, "{helm:?}");
    assert_eq!(
        helm.scanned, 2,
        "the uninstalled release is not read: {helm:?}"
    );
    assert_eq!(
        helm.skipped,
        vec![kind("locked", "", ""), kind("shop", "", "bomb")],
        "{helm:?}"
    );
    let found: Vec<(String, Option<String>)> = scan
        .usages
        .iter()
        .map(|u| (u.api.kind.clone(), u.namespace.clone()))
        .collect();
    // A PodSecurityPolicy has no namespace even though this cluster no longer serves the kind.
    assert_eq!(
        found,
        vec![
            ("PodSecurityPolicy".to_owned(), None),
            ("CronJob".to_owned(), Some("shop".to_owned())),
        ]
    );
    // Only the latest revision is fetched, once; the old and the uninstalled ones are not.
    assert_eq!(
        api.count("/api/v1/namespaces/shop/secrets/sh.helm.release.v1.shop.v3"),
        1
    );
    assert_eq!(
        api.count("/api/v1/namespaces/shop/secrets/sh.helm.release.v1.shop.v2"),
        0
    );
    assert_eq!(
        api.count("/api/v1/namespaces/shop/secrets/sh.helm.release.v1.gone.v4"),
        0
    );
}
