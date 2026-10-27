use serde_json::json;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

fn kind(group: &str, version: &str, k: &str) -> KindRef {
    KindRef {
        group: group.to_owned(),
        version: version.to_owned(),
        kind: k.to_owned(),
    }
}

fn deployment_ref(ns: &str, name: &str) -> ObjectRef {
    ObjectRef {
        kind: kind("apps", "v1", "Deployment"),
        namespace: Some(ns.to_owned()),
        name: name.to_owned(),
    }
}

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

fn forbidden() -> Reply {
    Reply::json(
        403,
        r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"configmaps is forbidden","reason":"Forbidden","code":403}"#,
    )
}

fn web_metadata() -> serde_json::Value {
    json!({
        "name": "web", "namespace": "shop", "uid": "u-web", "resourceVersion": "42",
        "creationTimestamp": "2026-01-01T00:00:00Z",
        "annotations": { "meta.helm.sh/release-name": "shop", "meta.helm.sh/release-namespace": "shop" },
        "managedFields": [
            { "manager": "helm", "operation": "Update", "apiVersion": "apps/v1", "time": "2026-03-01T10:00:00Z",
              "fieldsType": "FieldsV1", "fieldsV1": { "f:spec": {} } },
            { "manager": "kubectl-edit", "operation": "Update", "apiVersion": "apps/v1", "time": "2026-03-02T10:00:00Z",
              "fieldsType": "FieldsV1", "fieldsV1": { "f:spec": { "f:replicas": {} } } },
            { "manager": "kube-controller-manager", "operation": "Update", "subresource": "status",
              "apiVersion": "apps/v1", "time": "2026-03-03T10:00:00Z", "fieldsType": "FieldsV1", "fieldsV1": {} }
        ]
    })
}

#[test]
fn requests_are_checked_before_anything_is_sent() {
    assert!(check_refs(&[deployment_ref("shop", "web")]).is_ok());
    for bad in [
        deployment_ref("Shop", "web"),
        deployment_ref("shop", ""),
        deployment_ref("shop", "a/b"),
        ObjectRef {
            kind: kind("apps/x", "v1", "Deployment"),
            namespace: Some("shop".into()),
            name: "web".into(),
        },
    ] {
        assert_eq!(
            check_refs(std::slice::from_ref(&bad)).unwrap_err().code,
            ErrorCode::Invalid,
            "{bad:?}"
        );
    }
    let many = vec![deployment_ref("shop", "web"); MAX_REFS + 1];
    assert_eq!(check_refs(&many).unwrap_err().code, ErrorCode::Invalid);

    let deployments = [kind("apps", "v1", "Deployment")];
    assert!(check_history_request(&["shop".into()], &deployments).is_ok());
    assert!(check_history_request(&[], &deployments).is_err());
    assert!(check_history_request(&["a b".into()], &deployments).is_err());
    let namespaces: Vec<String> = (0..=MAX_NAMESPACES).map(|i| format!("ns{i}")).collect();
    assert!(check_history_request(&namespaces, &deployments).is_err());
    assert!(check_history_request(&["shop".into()], &[kind("apps", "", "Deployment")]).is_err());
}

#[tokio::test]
async fn managers_come_from_a_metadata_read_of_each_object() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/apis/apps/v1/namespaces/shop/deployments/web" => Reply::json(
            200,
            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": web_metadata() })
                .to_string(),
        ),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let found = managers(
        &mgr,
        &id,
        vec![
            deployment_ref("shop", "web"),
            deployment_ref("shop", "gone"),
        ],
    )
    .await
    .unwrap();
    assert_eq!(found.len(), 2);
    assert_eq!(found[0].uid.as_deref(), Some("u-web"));
    assert_eq!(found[0].resource_version.as_deref(), Some("42"));
    let names: Vec<_> = found[0]
        .managers
        .iter()
        .map(|m| m.manager.as_str())
        .collect();
    assert_eq!(names, ["helm", "kubectl-edit", "kube-controller-manager"]);
    assert_eq!(found[0].managers[2].subresource.as_deref(), Some("status"));
    assert_eq!(
        found[0].managers[1].time.as_deref(),
        Some("2026-03-02T10:00:00Z")
    );
    assert_eq!(found[1].error.as_ref().unwrap().code, ErrorCode::NotFound);
    // Metadata only: the request asks for PartialObjectMetadata.
    let get = api
        .requests()
        .into_iter()
        .find(|r| r.path.ends_with("/deployments/web"))
        .unwrap();
    assert!(
        get.header("accept").contains("PartialObjectMetadata"),
        "{}",
        get.head
    );
}

#[tokio::test]
async fn history_lists_managers_revisions_and_helm_releases_newest_first() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/apis/apps/v1/namespaces/shop/deployments" => Reply::json(
            200,
            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {},
                    "items": [{ "metadata": web_metadata() }] })
            .to_string(),
        ),
        "/apis/apps/v1/namespaces/shop/replicasets" => Reply::json(
            200,
            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {},
                    "items": [{ "metadata": {
                        "name": "web-5d4f", "namespace": "shop", "uid": "u-rs",
                        "creationTimestamp": "2026-03-02T10:00:01Z",
                        "annotations": { "deployment.kubernetes.io/revision": "7", "kubernetes.io/change-cause": "bump" },
                        "ownerReferences": [{ "apiVersion": "apps/v1", "kind": "Deployment", "name": "web",
                                              "uid": "u-web", "controller": true }],
                        "managedFields": [{ "manager": "kube-controller-manager", "operation": "Update",
                                            "time": "2026-03-05T00:00:00Z" }]
                    } }] })
            .to_string(),
        ),
        "/api/v1/namespaces/shop/configmaps" => forbidden(),
        "/api/v1/namespaces/shop/secrets" => {
            assert!(req.query.contains("owner%3Dhelm") || req.query.contains("owner=helm"), "{}", req.query);
            Reply::json(
                200,
                json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {},
                        "items": [{ "metadata": {
                            "name": "sh.helm.release.v1.shop.v3", "namespace": "shop",
                            "creationTimestamp": "2026-02-01T00:00:00Z",
                            "labels": { "owner": "helm", "name": "shop", "version": "3", "status": "deployed",
                                        "modifiedAt": "1772272800" }
                        } }] })
                .to_string(),
            )
        }
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let found = history(
        &mgr,
        &id,
        vec!["shop".into()],
        vec![
            kind("apps", "v1", "Deployment"),
            kind("apps", "v1", "ReplicaSet"),
            kind("", "v1", "ConfigMap"),
        ],
        true,
    )
    .await
    .unwrap();
    let summary: Vec<(HistorySource, &str, &str)> = found
        .entries
        .iter()
        .map(|e| {
            (
                e.source,
                e.object.name.as_str(),
                e.manager.as_deref().unwrap_or(""),
            )
        })
        .collect();
    // The status write is left out; the ReplicaSet gives its revision, not its managers.
    assert_eq!(
        summary,
        [
            (HistorySource::Revision, "web-5d4f", ""),
            (HistorySource::FieldManager, "web", "kubectl-edit"),
            (HistorySource::FieldManager, "web", "helm"),
            (HistorySource::HelmRevision, "shop", ""),
        ]
    );
    let revision = &found.entries[0];
    assert_eq!(revision.revision, Some(7));
    assert_eq!(revision.change_cause.as_deref(), Some("bump"));
    assert_eq!(revision.owner.as_ref().unwrap().name, "web");
    let helm = &found.entries[3];
    assert_eq!(helm.revision, Some(3));
    assert_eq!(helm.status.as_deref(), Some("deployed"));
    assert_eq!(helm.time, "2026-02-28T10:00:00Z");
    let configmaps = found
        .reports
        .iter()
        .find(|r| r.what == "ConfigMap")
        .unwrap();
    assert_eq!(
        configmaps.error.as_ref().unwrap().code,
        ErrorCode::Forbidden
    );
    assert!(
        found
            .reports
            .iter()
            .filter(|r| r.what != "ConfigMap")
            .all(|r| r.error.is_none())
    );
    // Release Secrets are read by metadata only: their data never comes.
    let secrets = api
        .requests()
        .into_iter()
        .find(|r| r.path.ends_with("/secrets"))
        .unwrap();
    assert!(
        secrets
            .header("accept")
            .contains("PartialObjectMetadataList")
    );
}

#[test]
fn a_saved_timeline_never_holds_a_value_of_an_inline_secret_path() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("timeline");
    let cluster = ClusterId("c1".into());
    let doc = json!({
        "version": 1, "cluster": "c1",
        "entries": [
            { "kind": { "group": "route.openshift.io", "version": "v1", "kind": "Route" },
              "changes": [
                  { "path": "spec.tls.key", "op": "changed", "before": "old-key", "after": "new-key" },
                  { "path": "spec.tls", "op": "added", "after": "{\"key\":\"added-key\"}" },
                  { "path": "spec.host", "op": "changed", "before": "a.example.com", "after": "b.example.com" }
              ] },
            { "kind": { "group": "", "version": "v1", "kind": "Node" },
              "changes": [
                  { "path": "metadata.annotations[\"k3s.io/node-args\"]", "op": "changed",
                    "before": "[\"--token\",\"tok-1\"]", "after": "[\"--token\",\"tok-2\"]" },
                  { "op": "changed", "before": "no-path", "after": "no-path-2" },
                  { "path": "spec.unschedulable", "op": "added", "after": "true" }
              ] }
        ]
    });
    save(&dir, &cluster, Some(&doc.to_string())).unwrap();
    let on_disk = std::fs::read_to_string(saved_path(&dir, &cluster)).unwrap();
    for secret in [
        "old-key",
        "new-key",
        "added-key",
        "tok-1",
        "tok-2",
        "no-path",
    ] {
        assert!(!on_disk.contains(secret), "{secret}: {on_disk}");
    }
    let read: Value = serde_json::from_str(&load(&dir, &cluster).unwrap().unwrap()).unwrap();
    assert_eq!(
        read["entries"][0]["changes"][0],
        json!({ "path": "spec.tls.key", "op": "changed" })
    );
    assert_eq!(read["entries"][0]["changes"][2]["after"], "b.example.com");
    assert_eq!(read["entries"][1]["changes"][2]["after"], "true");
}

#[test]
fn a_saved_timeline_round_trips_and_never_holds_a_secret_value() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("timeline");
    let cluster = ClusterId("c1".into());
    assert_eq!(load(&dir, &cluster).unwrap(), None);
    let doc = json!({
        "version": 1, "cluster": "c1",
        "entries": [
            { "kind": { "group": "", "version": "v1", "kind": "Secret" },
              "changes": [{ "path": "data.token", "op": "changed", "before": "old", "after": "new" }] },
            { "kind": { "group": "apps", "version": "v1", "kind": "Deployment" },
              "changes": [{ "path": "spec.replicas", "op": "changed", "before": "2", "after": "3" }] }
        ]
    });
    save(&dir, &cluster, Some(&doc.to_string())).unwrap();
    let read: Value = serde_json::from_str(&load(&dir, &cluster).unwrap().unwrap()).unwrap();
    assert_eq!(
        read["entries"][0]["changes"][0],
        json!({ "path": "data.token", "op": "changed" })
    );
    assert_eq!(read["entries"][1]["changes"][0]["after"], "3");
    let on_disk = std::fs::read_to_string(saved_path(&dir, &cluster)).unwrap();
    assert!(
        !on_disk.contains("old") && !on_disk.contains("new"),
        "{on_disk}"
    );
    // The file name does not come from the id.
    assert!(
        !saved_path(&dir, &ClusterId("../x".into()))
            .to_string_lossy()
            .contains("..")
    );

    // Another cluster's document, a wrong shape and too much are refused and leave the file as it was.
    let other = json!({ "version": 1, "cluster": "c2", "entries": [] }).to_string();
    assert_eq!(
        save(&dir, &cluster, Some(&other)).unwrap_err().code,
        ErrorCode::Invalid
    );
    assert_eq!(
        save(&dir, &cluster, Some("[]")).unwrap_err().code,
        ErrorCode::Invalid
    );
    let big = format!(
        r#"{{"version":1,"cluster":"c1","entries":["{}"]}}"#,
        "x".repeat(MAX_SAVED_BYTES)
    );
    assert_eq!(
        save(&dir, &cluster, Some(&big)).unwrap_err().code,
        ErrorCode::Invalid
    );
    assert!(load(&dir, &cluster).unwrap().is_some());
    // Another cluster never reads it.
    std::fs::copy(
        saved_path(&dir, &cluster),
        saved_path(&dir, &ClusterId("c2".into())),
    )
    .unwrap();
    assert_eq!(load(&dir, &ClusterId("c2".into())).unwrap(), None);

    save(&dir, &cluster, None).unwrap();
    assert_eq!(load(&dir, &cluster).unwrap(), None);
    save(&dir, &cluster, None).unwrap();
    assert!(
        std::fs::read_dir(&dir).unwrap().all(|e| !e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("tmp"))
    );
}

#[tokio::test]
async fn an_objects_history_has_its_managers_and_its_helm_release() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/shop/configmaps/settings" => Reply::json(
            200,
            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadata", "metadata": {
                "name": "settings", "namespace": "shop", "uid": "u-cm",
                "annotations": { "meta.helm.sh/release-name": "shop" },
                "managedFields": [{ "manager": "helm", "operation": "Update", "time": "2026-03-01T10:00:00Z" }]
            } })
            .to_string(),
        ),
        "/api/v1/namespaces/shop/secrets" => Reply::json(
            200,
            json!({ "apiVersion": "meta.k8s.io/v1", "kind": "PartialObjectMetadataList", "metadata": {},
                    "items": [
                        { "metadata": { "name": "sh.helm.release.v1.shop.v2", "namespace": "shop",
                                        "creationTimestamp": "2026-03-01T09:59:59Z",
                                        "labels": { "owner": "helm", "name": "shop", "version": "2", "status": "deployed" } } },
                        { "metadata": { "name": "sh.helm.release.v1.other.v1", "namespace": "shop",
                                        "creationTimestamp": "2026-03-01T00:00:00Z",
                                        "labels": { "owner": "helm", "name": "other", "version": "1", "status": "deployed" } } }
                    ] })
            .to_string(),
        ),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let object = ObjectRef {
        kind: kind("", "v1", "ConfigMap"),
        namespace: Some("shop".into()),
        name: "settings".into(),
    };
    let found = object_history(&mgr, &id, object).await.unwrap();
    let summary: Vec<(HistorySource, &str, Option<i64>)> = found
        .entries
        .iter()
        .map(|e| (e.source, e.object.name.as_str(), e.revision))
        .collect();
    assert_eq!(
        summary,
        [
            (HistorySource::FieldManager, "settings", None),
            (HistorySource::HelmRevision, "shop", Some(2)),
        ]
    );
    assert!(found.reports.iter().all(|r| r.error.is_none()));
    // A missing object is an error of the call.
    let gone = ObjectRef {
        kind: kind("", "v1", "ConfigMap"),
        namespace: Some("shop".into()),
        name: "gone".into(),
    };
    assert_eq!(
        object_history(&mgr, &id, gone).await.unwrap_err().code,
        ErrorCode::NotFound
    );
}

#[test]
fn concurrent_saves_do_not_collide_and_remove_all_clears_every_cluster() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().join("timeline");
    let cluster = ClusterId("c1".into());
    let doc = |n: usize| {
        json!({ "version": 1, "cluster": "c1", "entries": vec![json!({ "n": n }); n] }).to_string()
    };
    std::thread::scope(|scope| {
        for n in 1..=8 {
            let (dir, cluster, text) = (&dir, &cluster, doc(n));
            scope.spawn(move || save(dir, cluster, Some(&text)).unwrap());
        }
    });
    // One of the writes won whole; no temporary file is left.
    let read: Value = serde_json::from_str(&load(&dir, &cluster).unwrap().unwrap()).unwrap();
    assert!((1..=8).contains(&read["entries"].as_array().unwrap().len()));
    let names = || -> Vec<String> {
        std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    };
    assert_eq!(names().len(), 1, "{:?}", names());

    // Every cluster's file goes, also of a cluster no longer known, and a leftover temporary file; others stay.
    let other = ClusterId("gone".into());
    save(
        &dir,
        &other,
        Some(&json!({ "version": 1, "cluster": "gone", "entries": [] }).to_string()),
    )
    .unwrap();
    std::fs::write(dir.join("x.json.tmp-1-2"), "{").unwrap();
    std::fs::write(dir.join("README"), "keep").unwrap();
    remove_all(&dir).unwrap();
    assert_eq!(names(), ["README"]);
    remove_all(&tmp.path().join("missing")).unwrap();
}
