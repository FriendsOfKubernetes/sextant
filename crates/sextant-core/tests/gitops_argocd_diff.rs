//! Argo CD sign-in and diff (`sextant_core::argocd`) against the kind test cluster made with
//! `scripts/test-cluster.sh up --gitops`:
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) SEXTANT_TEST_GITOPS=1 \
//!   cargo test -p sextant-core --test gitops_argocd_diff -- --test-threads=1
//! ```
//!
//! The diff test deploys its own Application `sextant-argodiff` (the guestbook example) into its own namespace
//! `sextant-argodiff`; the sign-in tests look for credentials in their own namespace `sextant-argodiff-<test>`. Both
//! are removed at the end, also when a test fails. No Argo CD user or token is created.

mod common;

use common::{connected, gitops_cluster, wait_until};

use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::time::{Duration, Instant};

use futures::FutureExt;
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Namespace, Secret};
use kube::api::{
    ApiResource, DeleteParams, DynamicObject, GroupVersionKind, Patch, PatchParams, PostParams,
};
use kube::{Api, Client};
use serde_json::{Value, json};
use sextant_core::argocd::{
    self, ArgoClient, CredentialSource, Credentials, ManagedResource, SecretString,
};
use sextant_core::portforward::{ForwardTarget, PodFilter, PortForwarder};
use sextant_core::{ClusterId, ClusterManager, ErrorCode};

const APP: &str = "sextant-argodiff";
/// A value the diff must never carry.
const PLAIN_VALUE: &str = "sextant-argodiff-plain-value";

fn application_api(client: Client) -> Api<DynamicObject> {
    let gvk = GroupVersionKind::gvk("argoproj.io", "v1alpha1", "Application");
    Api::namespaced_with(client, "argocd", &ApiResource::from_gvk(&gvk))
}

async fn delete_namespace(client: &Client, ns: &str, wait: bool) {
    let namespaces: Api<Namespace> = Api::all(client.clone());
    let _ = namespaces.delete(ns, &DeleteParams::background()).await;
    if wait {
        wait_until("the old namespace to go away", 180, || {
            let namespaces = namespaces.clone();
            let ns = ns.to_string();
            async move { namespaces.get_opt(&ns).await.unwrap().is_none() }
        })
        .await;
    }
}

async fn create_namespace(client: &Client, ns: &str) {
    delete_namespace(client, ns, true).await;
    let namespace: Namespace =
        serde_json::from_value(json!({ "metadata": { "name": ns } })).unwrap();
    Api::<Namespace>::all(client.clone())
        .create(&PostParams::default(), &namespace)
        .await
        .unwrap();
}

/// What a test works with: a connected manager, an admin client and a client of `argocd-server` (forwarded).
struct Argo {
    mgr: ClusterManager,
    id: ClusterId,
    client: Client,
    argo: ArgoClient,
}

/// Runs `body` with [`Argo`] and the namespaces `cleanup` (deleted afterwards, also when `body` panics).
async fn with_argo<F, Fut>(namespaces: &[&str], body: F)
where
    F: FnOnce(Argo) -> Fut,
    Fut: Future<Output = ()>,
{
    let Some(cluster) = gitops_cluster() else {
        return;
    };
    let client = cluster.client().await;
    for ns in namespaces {
        create_namespace(&client, ns).await;
    }
    let (tmp, mgr, id) = connected(&cluster.kubeconfig).await;
    let server = argocd::find_server(&mgr, &id, None).await.unwrap();
    assert_eq!(
        (server.namespace.as_str(), server.name.as_str(), server.port),
        ("argocd", "argocd-server", 443)
    );
    let forwarder = PortForwarder::new();
    let server_found = server.clone();
    let target = ForwardTarget::Service {
        namespace: server.namespace,
        name: server.name,
    };
    let info = forwarder
        .start(&mgr, &id, target, server.port, None, PodFilter::Any)
        .await
        .unwrap();
    let argo = Argo {
        mgr,
        id,
        client: client.clone(),
        argo: ArgoClient::for_server(&server_found, info.local_port),
    };
    let result = AssertUnwindSafe(body(argo)).catch_unwind().await;
    // The forward and the kubeconfig copy live until the body is done.
    drop((forwarder, tmp));
    let _ = application_api(client.clone())
        .delete(APP, &DeleteParams::background())
        .await;
    for ns in namespaces {
        delete_namespace(&client, ns, false).await;
    }
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

/// Signs in as `admin` with the password of `argocd-initial-admin-secret`, found without asking.
async fn admin_session(argo: &Argo) -> argocd::Session {
    let found = argocd::standard_credentials(&argo.mgr, &argo.id, "argocd")
        .await
        .unwrap();
    assert!(
        matches!(found.first(), Some(Credentials::Password { username, .. }) if username == "admin"),
        "the initial admin secret comes first: {found:?}"
    );
    let candidates = found
        .into_iter()
        .map(|c| (CredentialSource::Secret, c))
        .collect();
    let (session, source, _) = argocd::sign_in(&argo.argo, candidates).await.unwrap();
    assert_eq!(source, CredentialSource::Secret);
    session
}

fn find<'a>(items: &'a [ManagedResource], kind: &str, name: &str) -> Option<&'a ManagedResource> {
    items.iter().find(|r| r.kind == kind && r.name == name)
}

#[tokio::test]
async fn the_diff_shows_a_resource_changed_by_hand_and_a_secret_without_values() {
    with_argo(&[APP], |argo| async move {
        let session = admin_session(&argo).await;
        let apps = application_api(argo.client.clone());
        let app: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "argoproj.io/v1alpha1", "kind": "Application",
            "metadata": { "name": APP, "namespace": "argocd" },
            "spec": {
                "project": "default",
                "source": { "repoURL": "https://github.com/argoproj/argocd-example-apps", "targetRevision": "HEAD", "path": "guestbook" },
                "destination": { "server": "https://kubernetes.default.svc", "namespace": APP },
                "syncPolicy": { "automated": { "prune": false, "selfHeal": false } }
            }
        }))
        .unwrap();
        let _ = apps.delete(APP, &DeleteParams::background()).await;
        wait_until("the old application to go away", 60, || {
            let apps = apps.clone();
            async move { apps.get_opt(APP).await.unwrap().is_none() }
        })
        .await;
        apps.create(&PostParams::default(), &app).await.unwrap();
        let deployments: Api<Deployment> = Api::namespaced(argo.client.clone(), APP);
        wait_until("the guestbook to be synced", 180, || {
            let deployments = deployments.clone();
            async move { deployments.get_opt("guestbook-ui").await.unwrap().is_some() }
        })
        .await;

        // Changed by hand: the live replicas differ from Git.
        deployments
            .patch(
                "guestbook-ui",
                &PatchParams::default(),
                &Patch::Merge(json!({ "spec": { "replicas": 3 } })),
            )
            .await
            .unwrap();
        // A Secret the application tracks but Git does not have (to be pruned).
        let secret: Secret = serde_json::from_value(json!({
            "metadata": {
                "name": "sextant-argodiff-db", "namespace": APP,
                "annotations": { "argocd.argoproj.io/tracking-id": format!("{APP}:/Secret:{APP}/sextant-argodiff-db") }
            },
            "stringData": { "password": PLAIN_VALUE }
        }))
        .unwrap();
        Api::<Secret>::namespaced(argo.client.clone(), APP)
            .create(&PostParams::default(), &secret)
            .await
            .unwrap();
        apps.patch(
            APP,
            &PatchParams::default(),
            &Patch::Merge(json!({ "metadata": { "annotations": { "argocd.argoproj.io/refresh": "normal" } } })),
        )
        .await
        .unwrap();

        let deadline = Instant::now() + Duration::from_secs(120);
        let items = loop {
            let items = argo
                .argo
                .managed_resources(&session, APP, Some("argocd"), None)
                .await
                .unwrap();
            let replicas = find(&items, "Deployment", "guestbook-ui")
                .and_then(|r| r.live_state.as_ref())
                .map(|live| live["spec"]["replicas"].clone());
            if replicas == Some(json!(3)) && find(&items, "Secret", "sextant-argodiff-db").is_some() {
                break items;
            }
            assert!(Instant::now() < deadline, "timed out waiting for Argo CD to see both changes");
            tokio::time::sleep(Duration::from_millis(500)).await;
        };

        let deploy = find(&items, "Deployment", "guestbook-ui").unwrap();
        assert_eq!(deploy.group, "apps");
        let target = deploy.target_state.as_ref().unwrap();
        assert_ne!(target["spec"]["replicas"], json!(3), "Git keeps its own replicas");
        assert_eq!(
            deploy.predicted_live_state.as_ref().unwrap()["spec"]["replicas"],
            target["spec"]["replicas"]
        );
        let db = find(&items, "Secret", "sextant-argodiff-db").unwrap();
        assert_eq!(db.target_state, None, "Git has no such Secret");
        let live: &Value = db.live_state.as_ref().unwrap();
        assert_eq!(live["data"]["password"], "");
        assert_eq!(live["metadata"]["annotations"]["sextant.dev/values-hidden"], "true");
        let sent = serde_json::to_string(&items).unwrap();
        assert!(!sent.contains(PLAIN_VALUE), "a Secret value is in the diff");
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, PLAIN_VALUE);
        assert!(!sent.contains(&encoded), "a Secret value is in the diff, base64-encoded");
    })
    .await;
}

#[tokio::test]
async fn without_the_standard_secrets_there_is_no_sign_in_and_wrong_credentials_are_refused() {
    let ns = "sextant-argodiff-empty";
    with_argo(&[ns], |argo| async move {
        let found = argocd::standard_credentials(&argo.mgr, &argo.id, ns)
            .await
            .unwrap();
        let none = argocd::sign_in(&argo.argo, Vec::new()).await.unwrap_err();
        let wrong = argo
            .argo
            .login_password("admin", &SecretString::new("not-the-password-42"))
            .await
            .unwrap_err();
        let bad_token = argo
            .argo
            .login_token(&SecretString::new("not-a-token-42"))
            .await
            .unwrap_err();

        assert!(found.is_empty(), "{found:?}");
        assert_eq!(none.code, ErrorCode::Unauthorized);
        assert_eq!(wrong.code, ErrorCode::Unauthorized, "{wrong}");
        assert!(!wrong.message.contains("not-the-password-42"));
        assert_eq!(bad_token.code, ErrorCode::Unauthorized);
    })
    .await;
}

#[tokio::test]
async fn a_token_secret_signs_in_and_a_disabled_admin_is_not_tried() {
    let ns = "sextant-argodiff-token";
    with_argo(&[ns], |argo| async move {
        let session = admin_session(&argo).await;
        let password = argocd::initial_admin_password(&argo.mgr, &argo.id, "argocd")
            .await
            .unwrap()
            .unwrap();
        let cm: ConfigMap = serde_json::from_value(json!({
            "metadata": { "name": argocd::SETTINGS_CONFIG_MAP, "namespace": ns },
            "data": { "admin.enabled": "false" }
        }))
        .unwrap();
        Api::<ConfigMap>::namespaced(argo.client.clone(), ns)
            .create(&PostParams::default(), &cm)
            .await
            .unwrap();
        let secrets: Api<Secret> = Api::namespaced(argo.client.clone(), ns);
        for (name, labels, data) in [
            (
                argocd::INITIAL_ADMIN_SECRET,
                json!({}),
                json!({ "password": password.expose() }),
            ),
            (
                "ci-token",
                json!({ "app.kubernetes.io/part-of": "argocd" }),
                json!({ "token": session.token().expose() }),
            ),
        ] {
            let secret: Secret = serde_json::from_value(json!({
                "metadata": { "name": name, "namespace": ns, "labels": labels },
                "stringData": data
            }))
            .unwrap();
            secrets
                .create(&PostParams::default(), &secret)
                .await
                .unwrap();
        }

        let found = argocd::standard_credentials(&argo.mgr, &argo.id, ns)
            .await
            .unwrap();
        let candidates = found
            .iter()
            .cloned()
            .map(|c| (CredentialSource::Secret, c))
            .collect();
        let (signed, _, used) = argocd::sign_in(&argo.argo, candidates).await.unwrap();

        assert_eq!(
            found.len(),
            1,
            "admin is disabled, only the token is tried: {found:?}"
        );
        assert!(matches!(used, Credentials::Token { .. }));
        assert_eq!(signed.username.as_deref(), Some("admin"));
        let options = argocd::login_options(&argo.mgr, &argo.id, ns)
            .await
            .unwrap();
        assert!(!options.local_users);
    })
    .await;
}
