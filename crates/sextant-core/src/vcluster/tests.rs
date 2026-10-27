use base64::Engine as _;
use secrecy::ExposeSecret as _;
use serde_json::json;

use super::*;
use crate::fake_api::{FakeApi, NOT_FOUND, Reply, Request, connected_to};
use crate::kubeconfig::KubeconfigEnv;

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;

// What the syncer writes into `vc-<name>` (`pkg/setup/controllers.go` `WriteKubeConfigToSecret` →
// `pkg/util/kubeconfig/kubeconfig.go` `WriteKubeConfig`): one cluster at `https://localhost:8443` with its CA, an
// admin user with a client certificate and key. The values are stand-ins (nothing here decodes them).
const CA: &str =
    "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkZBS0UtQ0EKLS0tLS1FTkQgQ0VSVElGSUNBVEUtLS0tLQo=";
const CERT: &str =
    "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCkZBS0UtQ0xJRU5UCi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS0K";
const KEY: &str = "UFJJVkFURS1LRVktVkFMVUUtTkVWRVItU0hPV04=";

fn exported(server: &str) -> String {
    format!(
        "apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    certificate-authority-data: {CA}\n    server: {server}\n    \
         proxy-url: http://proxy.example:3128\n  name: my-vcluster\ncontexts:\n- context:\n    cluster: my-vcluster\n    \
         namespace: default\n    user: my-vcluster\n  name: my-vcluster\ncurrent-context: my-vcluster\npreferences: {{}}\n\
         users:\n- name: my-vcluster\n  user:\n    client-certificate-data: {CERT}\n    client-key-data: {KEY}\n"
    )
}

fn secret_json(config: &str) -> String {
    let b64 = |s: &str| base64::engine::general_purpose::STANDARD.encode(s);
    json!({
        "kind": "Secret",
        "apiVersion": "v1",
        "metadata": {
            "name": "vc-dev",
            "namespace": "team-a",
            "labels": { "app": "vcluster", "vcluster-name": "dev" },
        },
        "type": "Opaque",
        "data": {
            "config": b64(config),
            "certificate-authority": b64("ca"),
            "client-certificate": b64("cert"),
            "client-key": b64("PRIVATE-KEY-VALUE-NEVER-SHOWN"),
            "token": "",
        },
    })
    .to_string()
}

fn no_secret_in(text: &str) {
    for value in [KEY, CERT, "PRIVATE-KEY-VALUE", "LS0t"] {
        assert!(!text.contains(value), "{text}");
    }
}

#[test]
fn the_context_is_named_as_vcluster_connect_names_it() {
    assert_eq!(
        context_name("dev", "team-a", "kind-host"),
        "vcluster_dev_team-a_kind-host"
    );
    assert_eq!(secret_name("dev"), "vc-dev");
}

#[test]
fn names_are_dns_labels() {
    assert!(validate_target("team-a", "dev").is_ok());
    for (ns, name) in [
        ("Team", "dev"),
        ("team-a", "dev/x"),
        ("", "dev"),
        ("team-a", "-dev"),
    ] {
        assert_eq!(
            validate_target(ns, name).unwrap_err().code,
            ErrorCode::Invalid,
            "{ns} {name}"
        );
    }
}

#[test]
fn the_kubeconfig_points_at_the_local_forward_and_keeps_only_what_a_connection_needs() {
    let parsed = parse_kubeconfig(
        exported("https://localhost:8443").as_bytes(),
        "vcluster_dev_team-a_h",
    )
    .unwrap();
    assert_eq!(parsed.remote_port(), 8443);
    let config = parsed.kubeconfig(41234);

    assert_eq!(
        config.current_context.as_deref(),
        Some("vcluster_dev_team-a_h")
    );
    let cluster = config.clusters[0].cluster.as_ref().unwrap();
    assert_eq!(config.clusters[0].name, "vcluster_dev_team-a_h");
    assert_eq!(cluster.server.as_deref(), Some("https://127.0.0.1:41234"));
    assert_eq!(cluster.tls_server_name.as_deref(), Some("localhost"));
    assert_eq!(cluster.certificate_authority_data.as_deref(), Some(CA));
    assert_eq!(cluster.proxy_url, None);
    let user = config.auth_infos[0].auth_info.as_ref().unwrap();
    assert_eq!(config.auth_infos[0].name, "vcluster_dev_team-a_h");
    assert_eq!(user.client_certificate_data.as_deref(), Some(CERT));
    assert_eq!(user.client_key_data.as_ref().unwrap().expose_secret(), KEY);
    assert!(user.exec.is_none());
    let ctx = config.contexts[0].context.as_ref().unwrap();
    assert_eq!(ctx.cluster, "vcluster_dev_team-a_h");
    assert_eq!(ctx.user.as_deref(), Some("vcluster_dev_team-a_h"));
    assert_eq!(ctx.namespace.as_deref(), Some("default"));

    // Never printed.
    no_secret_in(&format!("{parsed:?}"));
}

#[test]
fn the_remote_port_is_the_servers_or_8443() {
    for (server, port) in [
        ("https://localhost:8443", 8443),
        ("https://localhost:9443", 9443),
        ("https://vc.example.com", 8443),
        ("https://vc.example.com/some/path", 8443),
    ] {
        let parsed = parse_kubeconfig(exported(server).as_bytes(), "c").unwrap();
        assert_eq!(parsed.remote_port(), port, "{server}");
    }
    let err = parse_kubeconfig(exported("ftp://localhost:21").as_bytes(), "c").unwrap_err();
    assert_eq!(err.code, ErrorCode::Kubeconfig);
}

#[test]
fn a_named_tls_server_name_is_kept() {
    let text = exported("https://localhost:8443").replace(
        "    server: https://localhost:8443\n",
        "    server: https://localhost:8443\n    tls-server-name: my-vcluster.team-a\n",
    );
    let config = parse_kubeconfig(text.as_bytes(), "c")
        .unwrap()
        .kubeconfig(1);
    assert_eq!(
        config.clusters[0]
            .cluster
            .as_ref()
            .unwrap()
            .tls_server_name
            .as_deref(),
        Some("my-vcluster.team-a")
    );
}

#[test]
fn a_secret_never_makes_sextant_run_a_program_or_read_a_file() {
    let base = exported("https://localhost:8443");
    let cases = [
        base.replace(
            &format!("    client-key-data: {KEY}\n"),
            "    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: /bin/sh\n      args: [\"-c\", \"id\"]\n",
        ),
        base.replace(
            &format!("    client-key-data: {KEY}\n"),
            "    client-key: /root/.kube/key.pem\n",
        ),
        base.replace(
            &format!("    certificate-authority-data: {CA}\n"),
            "    certificate-authority: /etc/ca.pem\n",
        ),
        base.replace(
            &format!("    client-key-data: {KEY}\n"),
            "    tokenFile: /var/run/token\n",
        ),
        base.replace(
            &format!("    client-certificate-data: {CERT}\n    client-key-data: {KEY}\n"),
            "    username: admin\n",
        ),
    ];
    for text in cases {
        let err = parse_kubeconfig(text.as_bytes(), "c").unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "{text}");
        no_secret_in(&err.message);
    }
}

#[test]
fn what_is_not_one_clusters_kubeconfig_is_refused_without_quoting_it() {
    let two = exported("https://localhost:8443").replace(
        "contexts:",
        "- cluster:\n    server: https://other:8443\n  name: other\ncontexts:",
    );
    for text in [two.as_str(), "not: [a kubeconfig", "PRIVATE-KEY-VALUE: {"] {
        let err = parse_kubeconfig(text.as_bytes(), "c").unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig);
        no_secret_in(&err.message);
    }
    let huge = vec![b'a'; MAX_CONFIG_BYTES + 1];
    assert_eq!(
        parse_kubeconfig(&huge, "c").unwrap_err().code,
        ErrorCode::Kubeconfig
    );
}

#[tokio::test]
async fn the_secret_is_read_with_the_users_credentials_and_its_kubeconfig_parsed() {
    let secret = secret_json(&exported("https://localhost:8443"));
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/team-a/secrets/vc-dev" => Reply::json(200, secret.clone()),
        _ => Reply::not_found(),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let client = mgr.client(&id).unwrap();

    let parsed = read_kubeconfig(&client, "team-a", "dev", "kind-host")
        .await
        .unwrap();

    assert_eq!(parsed.context(), "vcluster_dev_team-a_kind-host");
    assert_eq!(parsed.remote_port(), 8443);
    assert_eq!(api.count("/api/v1/namespaces/team-a/secrets/vc-dev"), 1);
}

#[tokio::test]
async fn a_forbidden_or_missing_secret_is_a_clear_error() {
    let forbidden = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"secrets \"vc-dev\" is forbidden: User \"u\" cannot get resource \"secrets\"","reason":"Forbidden","code":403}"#;
    let without_key = json!({
        "kind": "Secret", "apiVersion": "v1",
        "metadata": { "name": "vc-old", "namespace": "team-a" },
        "data": { "client-key": base64::engine::general_purpose::STANDARD.encode("PRIVATE-KEY-VALUE") },
    })
    .to_string();
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/team-a/secrets/vc-dev" => Reply::json(403, forbidden),
        "/api/v1/namespaces/team-a/secrets/vc-old" => Reply::json(200, without_key.clone()),
        _ => Reply::json(404, NOT_FOUND),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let client = mgr.client(&id).unwrap();

    let err = read_kubeconfig(&client, "team-a", "dev", "h")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Forbidden);
    assert!(err.message.contains("team-a/vc-dev"), "{}", err.message);

    let err = read_kubeconfig(&client, "team-a", "gone", "h")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.message.contains("team-a/vc-gone"), "{}", err.message);

    let err = read_kubeconfig(&client, "team-a", "old", "h")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    no_secret_in(&err.message);

    // A malformed name never reaches the server.
    let before = api.requests().len();
    let err = read_kubeconfig(&client, "team-a", "../x", "h")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert_eq!(api.requests().len(), before);
}

fn pod(name: &str, created: &str, extra: serde_json::Value) -> serde_json::Value {
    let mut labels = json!({ "app": "vcluster", "release": "dev" });
    if let Some(more) = extra.get("labels").and_then(|l| l.as_object()) {
        for (k, v) in more {
            labels[k] = v.clone();
        }
    }
    let mut meta = json!({ "name": name, "namespace": "team-a", "creationTimestamp": created, "labels": labels });
    if let Some(deleted) = extra.get("deletionTimestamp") {
        meta["deletionTimestamp"] = deleted.clone();
    }
    json!({ "metadata": meta, "spec": { "containers": [] } })
}

#[tokio::test]
async fn the_service_is_forwarded_to_when_it_maps_the_pods_port() {
    let service = json!({
        "kind": "Service", "apiVersion": "v1",
        "metadata": { "name": "dev", "namespace": "team-a", "labels": { "app": "vcluster", "release": "dev" } },
        "spec": {
            "selector": { "app": "vcluster", "release": "dev" },
            "ports": [{ "name": "https", "port": 443, "targetPort": 8443, "protocol": "TCP" }],
        },
    })
    .to_string();
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/team-a/services/dev" => Reply::json(200, service.clone()),
        _ => Reply::json(404, NOT_FOUND),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let client = mgr.client(&id).unwrap();

    let (target, port) = forward_target(&client, "team-a", "dev", 8443)
        .await
        .unwrap();

    assert_eq!(
        target,
        ForwardTarget::Service {
            namespace: "team-a".into(),
            name: "dev".into()
        }
    );
    assert_eq!(port, 443);
}

#[tokio::test]
async fn without_a_service_the_newest_live_control_plane_pod_is_forwarded_to() {
    let pods = json!({
        "kind": "PodList", "apiVersion": "v1", "metadata": {},
        "items": [
            pod("dev-0", "2026-10-01T10:00:00Z", json!({})),
            pod("dev-new", "2026-10-02T10:00:00Z", json!({ "deletionTimestamp": "2026-10-03T10:00:00Z" })),
            // A pod of the virtual cluster that the syncer copied, carrying the same labels.
            pod("web-x-default-x-dev", "2026-10-04T10:00:00Z", json!({ "labels": { "vcluster.loft.sh/managed-by": "dev" } })),
            pod("dev-1", "2026-10-01T12:00:00Z", json!({})),
        ],
    })
    .to_string();
    let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1/namespaces/team-a/pods" => Reply::json(200, pods.clone()),
        _ => Reply::json(404, NOT_FOUND),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let client = mgr.client(&id).unwrap();

    let (target, port) = forward_target(&client, "team-a", "dev", 8443)
        .await
        .unwrap();

    assert_eq!(
        target,
        ForwardTarget::Pod {
            namespace: "team-a".into(),
            name: "dev-1".into()
        }
    );
    assert_eq!(port, 8443);
    let listed = api
        .requests()
        .into_iter()
        .find(|r| r.path == "/api/v1/namespaces/team-a/pods")
        .unwrap();
    assert!(
        listed
            .query
            .contains("labelSelector=app%3Dvcluster%2Crelease%3Ddev"),
        "{}",
        listed.query
    );
}

fn registry(dir: &std::path::Path) -> KubeconfigRegistry {
    KubeconfigRegistry::new(Vec::new(), dir.join("kubeconfigs")).with_env(KubeconfigEnv {
        kubeconfig: None,
        home: None,
    })
}

fn entry(context: &str, port: u16) -> Kubeconfig {
    parse_kubeconfig(exported("https://localhost:8443").as_bytes(), context)
        .unwrap()
        .kubeconfig(port)
}

#[test]
fn entries_go_to_sextants_own_private_file_and_leave_with_their_last_context() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = registry(dir.path());

    let source = save(&mut registry, &entry("vcluster_dev_team-a_h", 40001)).unwrap();
    save(&mut registry, &entry("vcluster_qa_team-b_h", 40002)).unwrap();
    // Connecting again replaces the entry (a new port).
    let again = save(&mut registry, &entry("vcluster_dev_team-a_h", 40003)).unwrap();

    assert_eq!(source.kind, SourceKind::Vcluster);
    assert_eq!(again.id, source.id);
    assert_eq!(source.path, dir.path().join("kubeconfigs").join(FILE_NAME));
    assert!(registry.is_own(&source));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&source.path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let clusters = registry.clusters().unwrap();
    let mut servers: Vec<_> = clusters
        .iter()
        .map(|c| (c.context.as_str(), c.server.as_str()))
        .collect();
    servers.sort();
    assert_eq!(
        servers,
        [
            ("vcluster_dev_team-a_h", "https://127.0.0.1:40003"),
            ("vcluster_qa_team-b_h", "https://127.0.0.1:40002"),
        ]
    );
    // The kubeconfig a connection gets is the forward's, with the certificate checked against `localhost`.
    let dev = clusters
        .iter()
        .find(|c| c.context == "vcluster_dev_team-a_h")
        .unwrap();
    let config = registry.kubeconfig_for(&dev.id).unwrap();
    assert_eq!(
        config.clusters[0]
            .cluster
            .as_ref()
            .unwrap()
            .tls_server_name
            .as_deref(),
        Some("localhost")
    );

    assert!(!remove(&mut registry, &["vcluster_dev_team-a_h".into()]).unwrap());
    let left: Vec<_> = registry
        .clusters()
        .unwrap()
        .into_iter()
        .map(|c| c.context)
        .collect();
    assert_eq!(left, ["vcluster_qa_team-b_h"]);

    assert!(remove(&mut registry, &["vcluster_qa_team-b_h".into()]).unwrap());
    assert!(!source.path.exists());
    assert!(registry.added_sources().is_empty());
    // Nothing left to remove.
    assert!(!remove(&mut registry, &["vcluster_qa_team-b_h".into()]).unwrap());
}

#[test]
fn at_start_the_file_of_an_earlier_run_is_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = registry(dir.path());
    let source = save(&mut registry, &entry("vcluster_dev_team-a_h", 40001)).unwrap();

    // The next run starts with the sources the settings kept.
    let mut next =
        KubeconfigRegistry::new(registry.added_sources(), dir.path().join("kubeconfigs")).with_env(
            KubeconfigEnv {
                kubeconfig: None,
                home: None,
            },
        );
    assert!(forget_all(&mut next).unwrap());
    assert!(!source.path.exists());
    assert!(next.added_sources().is_empty());
    assert!(!forget_all(&mut next).unwrap());
}

#[test]
fn a_cloud_file_is_not_touched_by_removing_virtual_clusters() {
    let dir = tempfile::tempdir().unwrap();
    let mut registry = registry(dir.path());
    let cloud = registry
        .add_cloud("cloud-aws.yaml", &entry("vcluster_dev_team-a_h", 1))
        .unwrap();

    assert!(!remove(&mut registry, &["vcluster_dev_team-a_h".into()]).unwrap());
    assert!(!forget_all(&mut registry).unwrap());
    assert!(cloud.path.exists());
    assert_eq!(registry.clusters().unwrap().len(), 1);
}
