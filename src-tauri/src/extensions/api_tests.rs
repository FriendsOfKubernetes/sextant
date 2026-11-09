//! The extensions' API: what an extension may do is decided by what was granted, in Rust.
//!
//! Most tests need no cluster: the kubeconfig names an unreachable server and kinds are looked up in a fake. The
//! tests at the end run every method against the kind test cluster and are skipped without it:
//! `SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant --lib -- extensions::api
//! --test-threads=1`.

use std::path::Path;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use sextant_core::extensions::{ExtensionSource, InstalledExtension};
use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{ClusterManager, KubeconfigRegistry};

use super::*;
use crate::extensions::test_support;

/// Kinds as a test cluster serves them: `Node` and `Namespace` without namespaces.
struct FakeKinds;

impl KindLookup for FakeKinds {
    fn namespaced<'a>(
        &'a self,
        _cluster: &'a ClusterId,
        kind: &'a KindPattern,
    ) -> BoxFuture<'a, Option<bool>> {
        Box::pin(async move {
            match kind.kind.as_str() {
                "Node" | "Namespace" => Some(false),
                "Pod" | "Secret" | "ConfigMap" | "Service" => Some(true),
                _ => None,
            }
        })
    }
}

const KUBECONFIG: &str = r#"
apiVersion: v1
kind: Config
clusters:
- name: nowhere
  cluster: { server: "SERVER" }
contexts:
- name: ctx-a
  context: { cluster: nowhere, user: me }
- name: ctx-b
  context: { cluster: nowhere, user: me }
users:
- name: me
  user: {}
current-context: ctx-a
"#;

struct Env {
    dir: tempfile::TempDir,
    settings: Arc<SettingsStore>,
    api: Arc<ExtensionApi>,
    host: ExtensionHost,
}

impl Env {
    /// Clusters `ctx-a` and `ctx-b` at an unreachable server.
    fn new() -> Self {
        Self::at("https://127.0.0.1:9")
    }

    /// Clusters `ctx-a` and `ctx-b` at `server`.
    fn at(server: &str) -> Self {
        Self::with_kubeconfig(&KUBECONFIG.replace("SERVER", server))
    }

    /// The clusters of the kubeconfig `text`.
    fn with_kubeconfig(text: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = dir.path().join("kubeconfig");
        std::fs::write(&kubeconfig, text).unwrap();
        let settings = Arc::new(SettingsStore::open(dir.path().join("config/settings.json")));
        let mut registry = KubeconfigRegistry::new(Vec::new(), dir.path().join("data/kubeconfigs"));
        registry.set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.into_os_string()),
            home: Some(dir.path().join("home")),
        });
        let clusters = ClusterManager::new(Arc::new(RwLock::new(registry)));
        let data = dir.path().join("data");
        let api = Arc::new(ExtensionApi::with_kinds(
            clusters,
            Arc::clone(&settings),
            Arc::new(Confirmations::default()),
            &data,
            Arc::new(FakeKinds),
        ));
        let host = ExtensionHost::new(&data, Arc::clone(&settings));
        Self {
            dir,
            settings,
            api,
            host,
        }
    }

    /// Installs `id` from a folder whose manifest asks exactly for `permissions`, granted in full.
    fn install(&self, id: &str, permissions: Value) {
        install_into(self.dir.path(), &self.settings, id, permissions);
    }

    fn set_enabled(&self, id: &str, enabled: bool) {
        self.host.set_enabled(id, enabled).unwrap();
    }

    fn cluster_id(&self, context: &str) -> ClusterId {
        self.api
            .cluster_list()
            .into_iter()
            .find(|c| c.context == context)
            .unwrap()
            .id
    }

    fn call(&self, id: &str, method: &str) -> ExtCall<'_> {
        let name = self.host.info(id).map(|i| i.name);
        ExtCall::new(&self.api, &self.host, id, method, name)
    }

    /// Answers every confirmation with `approved` and remembers the requests.
    fn answer_with(&self, approved: bool) -> Arc<Mutex<Vec<ConfirmRequest>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_in = Arc::clone(&seen);
        let confirmations = Arc::clone(&self.api.confirmations);
        self.api.set_emitter(Arc::new(move |event| {
            if let ApiEvent::Confirm(request) = event {
                seen_in.lock().unwrap().push(request.clone());
                let confirmations = Arc::clone(&confirmations);
                tokio::spawn(async move {
                    confirmations.answer(&request.id, approved).unwrap();
                });
            }
            true
        }));
        seen
    }
}

fn install_into(dir: &Path, settings: &SettingsStore, id: &str, permissions: Value) {
    let folder = dir.join("ext").join(id);
    test_support::write_folder(&folder, id, "1.0.0", permissions.clone());
    let granted: ExtensionPermissions = serde_json::from_value(permissions).unwrap();
    settings
        .update(|s| {
            s.extensions.retain(|e| e.id != id);
            s.extensions.push(InstalledExtension {
                id: id.to_owned(),
                version: "1.0.0".into(),
                name: format!("Ext {id}"),
                // Canonical, as the host records a folder (on macOS the temp dir is behind the /var symlink).
                source: ExtensionSource::Folder {
                    path: std::fs::canonicalize(&folder)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                },
                enabled: true,
                granted,
                installed_at: 1,
                granted_backend: None,
                granted_problems: None,
                granted_metric_queries: None,
                granted_commands: None,
                granted_services: None,
                granted_agent_tools: None,
            });
        })
        .unwrap();
}

/// Permissions: `clusters` and one rule.
fn perms(clusters: Value, namespaces: &[&str], actions: &[&str], confirm: bool) -> Value {
    let namespaces = if namespaces.is_empty() {
        json!({ "type": "all" })
    } else {
        json!({ "type": "only", "namespaces": namespaces })
    };
    json!({ "clusters": clusters, "rules": [
        { "namespaces": namespaces, "kinds": { "type": "all" }, "actions": actions, "confirm": confirm }
    ] })
}

fn all_clusters() -> Value {
    json!({ "type": "all" })
}

fn only(names: &[&str]) -> Value {
    json!({ "type": "only", "names": names })
}

fn need(ns: Option<&str>, kind: &str, action: AccessAction) -> Requirement {
    (ns.map(str::to_owned), KindPattern::new("", kind), action)
}

fn about(target: &str) -> CallSummary {
    summary(target.to_owned())
}

#[tokio::test]
async fn a_call_of_an_extension_that_is_not_active_is_denied_and_journaled() {
    let env = Env::new();
    let err = env
        .api
        .call(&env.host, "ghost", "clusters.list", Value::Null, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert!(
        err.message.contains("Extension ghost is not installed"),
        "{}",
        err.message
    );

    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let listed = env
        .api
        .call(&env.host, "widgets", "clusters.list", Value::Null, None)
        .await;
    assert!(listed.is_ok(), "{listed:?}");
    env.set_enabled("widgets", false);
    let calls = [
        ("clusters.list", json!({})),
        ("kinds", json!({ "clusterId": "ctx-a" })),
        ("storage.get", json!({ "key": "k" })),
    ];
    for (method, params) in calls {
        let err = env
            .api
            .call(&env.host, "widgets", method, params, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Denied, "{method}");
    }

    let journal = env.api.audit_list(Some("widgets"));
    assert_eq!(journal[0].decision, AuditDecision::Denied);
    assert_eq!(journal[0].source, ConfirmSource::Extension);
    assert_eq!(journal[0].principal, "Extension Ext widgets");
    assert_eq!(journal[0].client, "widgets");
    assert_eq!(journal[0].result, "denied");
    assert_eq!(journal[1].tool, "clusters.list", "storage is not journaled");
}

#[tokio::test]
async fn only_granted_clusters_are_listed_and_others_are_refused_without_asking() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(only(&["ctx-a"]), &[], &["read", "modify"], true),
    );
    let seen = env.answer_with(true);

    let listed = env
        .api
        .call(&env.host, "widgets", "clusters.list", json!({}), None)
        .await
        .unwrap();
    let contexts: Vec<&str> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["context"].as_str().unwrap())
        .collect();
    assert_eq!(contexts, vec!["ctx-a"]);

    let call = env.call("widgets", "resources.patch");
    let err = call.target("ctx-b").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(
        err.message,
        "Sextant denied access to cluster ctx-b for extension Ext widgets. Allow it in Settings → Extensions → \
         Ext widgets → Permissions (reinstall with wider permissions)."
    );
    assert_eq!(call.record().decision, Some(AuditDecision::Denied));
    // By id as well as by context.
    let by_id = env.cluster_id("ctx-b");
    assert!(env.call("widgets", "kinds").target(&by_id.0).await.is_err());
    assert_eq!(
        env.call("widgets", "kinds")
            .target("ctx-a")
            .await
            .unwrap()
            .context,
        "ctx-a"
    );
    assert!(seen.lock().unwrap().is_empty(), "a refusal never asks");
}

#[tokio::test]
async fn every_object_is_decided_against_what_was_granted() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &["team-a"], &["read", "delete"], false),
    );
    let call = env.call("widgets", "resources.delete");
    let cluster = call.target("ctx-a").await.unwrap();

    // A namespace rule never covers a kind without namespaces, whatever namespace was sent.
    let err = call
        .check(
            &cluster,
            &[need(Some("team-a"), "Node", AccessAction::Delete)],
            &about("Node worker-1"),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(
        err.message,
        "Sextant denied delete on Node worker-1 in cluster ctx-a for extension Ext widgets. Allow it in Settings → \
         Extensions → Ext widgets → Permissions (reinstall with wider permissions)."
    );

    let pod = |ns: &str| need(Some(ns), "Pod", AccessAction::Delete);
    let target = about("Pod team-a/web");
    let fresh = || env.call("widgets", "resources.delete");
    assert!(
        fresh()
            .check(&cluster, &[pod("team-a")], &target)
            .await
            .is_ok()
    );
    assert!(
        fresh()
            .check(&cluster, &[pod("team-b")], &target)
            .await
            .is_err()
    );
    assert!(
        fresh().check(&cluster, &[pod("")], &target).await.is_err(),
        "\"\" is no namespace"
    );
    let unknown = need(Some("team-a"), "Mystery", AccessAction::Delete);
    assert!(fresh().check(&cluster, &[unknown], &target).await.is_err());
    // Every requirement must be allowed; modify was never granted.
    let both = [
        pod("team-a"),
        need(Some("team-a"), "Pod", AccessAction::Modify),
    ];
    let err = fresh().check(&cluster, &both, &target).await.unwrap_err();
    assert!(
        err.message
            .starts_with("Sextant denied modify on Pod team-a/web"),
        "{}",
        err.message
    );
    // Secret values are their own action.
    let values = need(Some("team-a"), "Secret", AccessAction::SecretValues);
    let err = fresh()
        .check(&cluster, &[values], &about("Secret team-a/db key password"))
        .await
        .unwrap_err();
    assert!(
        err.message
            .starts_with("Sextant denied secret values on Secret team-a/db"),
        "{}",
        err.message
    );

    // Over all namespaces: only the granted ones; none at all is a refusal.
    let pods = KindPattern::new("", "Pod");
    let list = about("Pod in all namespaces");
    assert_eq!(
        fresh()
            .allowed_namespaces(&cluster, &pods, AccessAction::Read, &list)
            .await,
        Ok(NamespaceScope::Only {
            namespaces: vec!["team-a".into()]
        })
    );
    let err = fresh()
        .allowed_namespaces(&cluster, &pods, AccessAction::Logs, &list)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
}

#[tokio::test]
async fn a_list_narrowed_to_granted_namespaces_names_them_in_the_journal() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &["team-b", "team-a"], &["read"], false),
    );
    env.install("wide", perms(all_clusters(), &[], &["read"], false));
    let pods = KindPattern::new("", "Pod");
    let list = about("Pod in all namespaces");

    let call = env.call("widgets", "resources.list");
    let cluster = call.target("ctx-a").await.unwrap();
    call.allowed_namespaces(&cluster, &pods, AccessAction::Read, &list)
        .await
        .unwrap();
    assert_eq!(call.record().target, "Pod in namespaces team-a, team-b");

    // A grant over all namespaces, and a refusal, still say "all namespaces".
    let call = env.call("wide", "resources.list");
    let cluster = call.target("ctx-a").await.unwrap();
    assert_eq!(
        call.allowed_namespaces(&cluster, &pods, AccessAction::Read, &list)
            .await,
        Ok(NamespaceScope::All)
    );
    assert_eq!(call.record().target, "Pod in all namespaces");
    let call = env.call("widgets", "resources.list");
    let err = call
        .allowed_namespaces(&cluster, &pods, AccessAction::Logs, &list)
        .await
        .unwrap_err();
    assert!(
        err.message.contains("on Pod in all namespaces"),
        "{}",
        err.message
    );
    assert_eq!(call.record().target, "Pod in all namespaces");
}

#[tokio::test]
async fn a_rule_that_asks_shows_the_extension_in_the_dialog() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &[], &["read", "modify"], true),
    );
    let modify = [need(Some("team-a"), "Pod", AccessAction::Modify)];
    let patch = CallSummary {
        tool: String::new(),
        target: "Pod team-a/web".into(),
        details: Some("metadata: {}".into()),
    };

    let seen = env.answer_with(true);
    let call = env.call("widgets", "resources.patch");
    let cluster = call.target("ctx-a").await.unwrap();
    assert_eq!(call.check(&cluster, &modify, &patch).await, Ok(()));
    assert_eq!(call.record().decision, Some(AuditDecision::Approved));
    let shown = seen.lock().unwrap()[0].clone();
    assert_eq!(shown.source, ConfirmSource::Extension);
    assert_eq!(shown.principal, "Extension Ext widgets");
    assert_eq!(shown.client, "widgets");
    assert_eq!(shown.tool, "resources.patch");
    assert_eq!(shown.cluster_name, "ctx-a");
    assert_eq!(shown.target, "Pod team-a/web");
    assert_eq!(shown.details.as_deref(), Some("metadata: {}"));

    env.answer_with(false);
    let call = env.call("widgets", "resources.patch");
    let err = call.check(&cluster, &modify, &patch).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(
        err.message,
        "The user declined resources.patch on Pod team-a/web in cluster ctx-a."
    );
    assert_eq!(call.record().decision, Some(AuditDecision::Declined));

    // Reads are never asked about.
    let seen = env.answer_with(false);
    let read = [need(Some("team-a"), "Pod", AccessAction::Read)];
    assert_eq!(
        env.call("widgets", "resources.get")
            .check(&cluster, &read, &patch)
            .await,
        Ok(())
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn without_a_window_a_call_that_asks_is_declined() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["delete"], true));
    let call = env.call("widgets", "resources.delete");
    let cluster = call.target("ctx-a").await.unwrap();
    let err = call
        .check(
            &cluster,
            &[need(Some("team-a"), "Pod", AccessAction::Delete)],
            &about("Pod team-a/web"),
        )
        .await
        .unwrap_err();
    assert!(
        err.message.starts_with("The user declined"),
        "{}",
        err.message
    );
    // Told apart from the rules' refusal by its reason, not its words (#389).
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(err.reason, Some(sextant_core::error::ErrorReason::Declined));
}

#[tokio::test]
async fn a_fifth_waiting_request_of_an_extension_is_denied_without_a_dialog() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["delete"], true));
    let seen = Arc::new(Mutex::new(Vec::<ConfirmRequest>::new()));
    let seen_in = Arc::clone(&seen);
    // The window shows the requests and leaves them waiting.
    env.api.set_emitter(Arc::new(move |event| {
        if let ApiEvent::Confirm(request) = event {
            seen_in.lock().unwrap().push(request.clone());
        }
        true
    }));
    let delete = [need(Some("team-a"), "Pod", AccessAction::Delete)];
    let target = about("Pod team-a/web");
    let calls: Vec<ExtCall<'_>> = (0..MAX_PENDING_PER_EXTENSION)
        .map(|_| env.call("widgets", "resources.delete"))
        .collect();
    let cluster = calls[0].target("ctx-a").await.unwrap();
    let waiting =
        futures::future::join_all(calls.iter().map(|c| c.check(&cluster, &delete, &target)));
    let fifth = async {
        while env.api.confirmations.pending() < MAX_PENDING_PER_EXTENSION {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let call = env.call("widgets", "resources.delete");
        let err = call.check(&cluster, &delete, &target).await.unwrap_err();
        assert_eq!(call.record().decision, Some(AuditDecision::Denied));
        assert_eq!(
            seen.lock().unwrap().len(),
            MAX_PENDING_PER_EXTENSION,
            "a dialog was shown"
        );
        for request in seen.lock().unwrap().iter() {
            env.api.confirmations.answer(&request.id, false).unwrap();
        }
        err
    };
    let (results, err) = tokio::join!(waiting, fifth);
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(
        err.message,
        "Extension widgets already has 4 requests waiting for the user: resources.delete on Pod team-a/web in \
         cluster ctx-a was not asked and not run."
    );
    assert!(results.iter().all(|r| {
        r.as_ref()
            .unwrap_err()
            .message
            .starts_with("The user declined")
    }));
}

#[tokio::test]
async fn an_extension_disabled_while_its_dialog_is_open_does_not_run() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["modify"], true));
    let settings = Arc::clone(&env.settings);
    let confirmations = Arc::clone(&env.api.confirmations);
    env.api.set_emitter(Arc::new(move |event| {
        if let ApiEvent::Confirm(request) = event {
            settings
                .update(|s| s.extensions.iter_mut().for_each(|e| e.enabled = false))
                .unwrap();
            confirmations.answer(&request.id, true).unwrap();
        }
        true
    }));
    let call = env.call("widgets", "resources.patch");
    let cluster = call.target("ctx-a").await.unwrap();
    let err = call
        .check(
            &cluster,
            &[need(Some("team-a"), "Pod", AccessAction::Modify)],
            &about("Pod team-a/web"),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert!(err.message.contains("is disabled"), "{}", err.message);
    assert_eq!(call.record().decision, Some(AuditDecision::Denied));
}

#[tokio::test]
async fn bad_parameters_and_unknown_methods_are_invalid_before_the_cluster_is_touched() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &[], &["read", "modify"], false),
    );
    let pod = json!({ "kind": { "kind": "Pod" }, "namespace": "team-a", "name": "web" });
    let cases = [
        ("resources.fly", json!({})),
        (
            "resources.get",
            json!({ "clusterId": "ctx-a", "ref": pod, "extra": 1 }),
        ),
        (
            "resources.patch",
            json!({ "clusterId": "ctx-a", "ref": pod, "patch": [], "patchType": "merge" }),
        ),
        (
            "resources.patch",
            json!({ "clusterId": "ctx-a", "ref": pod, "patchType": "json",
                    "patch": [{ "op": "copy", "from": "data/password", "path": "/metadata/labels/x" }] }),
        ),
        (
            "resources.apply",
            json!({ "clusterId": "ctx-a", "yaml": "" }),
        ),
        (
            "resources.create",
            json!({ "clusterId": "ctx-a", "yaml": "" }),
        ),
        (
            "resources.create",
            json!({ "clusterId": "ctx-a", "yaml": "kind: ConfigMap\napiVersion: v1\nmetadata: {name: a}\n---\nkind: ConfigMap\napiVersion: v1\nmetadata: {name: b}\n" }),
        ),
        (
            "resources.watch",
            json!({ "clusterId": "ctx-a", "kind": { "kind": "Pod" } }),
        ),
    ];
    for (method, params) in cases {
        let err = env
            .api
            .call(&env.host, "widgets", method, params, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{method}: {}", err.message);
    }
    // An apply of a Secret loaded without its values is refused before anything else.
    let hidden = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: team-a\n  annotations:\n    \
                  sextant.dev/values-hidden: \"true\"\ndata:\n  password: \"\"\n";
    let err = env
        .api
        .call(
            &env.host,
            "widgets",
            "resources.apply",
            json!({ "clusterId": "ctx-a", "yaml": hidden }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
}

#[tokio::test]
async fn node_shell_pods_are_refused_by_name_before_anything_is_asked() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &[], &["read", "modify", "delete"], true),
    );
    let seen = env.answer_with(true);
    // `refuse_named_node_shell` is what the methods run before the check.
    let object: ObjectRef = ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespace: Some("kube-system".into()),
        name: "sextant-node-shell-worker-abc12".into(),
    };
    let err = refuse_named_node_shell(&object, None).unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(err.message, NODE_SHELL_REFUSAL);
    let labelled = json!({ "apiVersion": "v1", "kind": "Pod",
                           "metadata": { "name": "x", "namespace": "team-a", "labels": { "sextant.dev/owner": "me" } } });
    let elsewhere = ObjectRef {
        namespace: Some("team-a".into()),
        name: "x".into(),
        ..object.clone()
    };
    assert!(refuse_named_node_shell(&elsewhere, Some(&labelled)).is_err());
    assert!(refuse_named_node_shell(&elsewhere, None).is_ok());
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn storage_keeps_one_object_per_extension_up_to_a_megabyte() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    let call = |id: &str, method: &str, params: Value| {
        let (api, host) = (&env.api, &env.host);
        let (id, method) = (id.to_owned(), method.to_owned());
        async move { api.call(host, &id, &method, params, None).await }
    };

    assert_eq!(
        call("widgets", "storage.get", json!({ "key": "size" })).await,
        Ok(Value::Null)
    );
    call(
        "widgets",
        "storage.set",
        json!({ "key": "size", "value": { "rows": 20 } }),
    )
    .await
    .unwrap();
    call(
        "widgets",
        "storage.set",
        json!({ "key": "theme", "value": "dark" }),
    )
    .await
    .unwrap();
    assert_eq!(
        call("widgets", "storage.get", json!({ "key": "size" })).await,
        Ok(json!({ "rows": 20 }))
    );
    assert_eq!(
        call("gadgets", "storage.get", json!({ "key": "size" })).await,
        Ok(Value::Null)
    );
    call("widgets", "storage.remove", json!({ "key": "theme" }))
        .await
        .unwrap();
    let file = env.host.storage_dir().join("widgets.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(saved, json!({ "size": { "rows": 20 } }));

    // More than 1 MB in all is refused, and nothing changes.
    let big = "x".repeat(MAX_STORAGE_BYTES);
    let err = call(
        "widgets",
        "storage.set",
        json!({ "key": "big", "value": big }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(err.message.contains("1024 KB"), "{}", err.message);
    assert_eq!(
        call("widgets", "storage.get", json!({ "key": "big" })).await,
        Ok(Value::Null)
    );
    let err = call("widgets", "storage.set", json!({ "key": "", "value": 1 }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);

    // Removing the extension removes its data; a later call is refused.
    env.host.remove("widgets").unwrap();
    assert!(!file.exists());
    let err = call("widgets", "storage.get", json!({ "key": "size" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
}

fn pending_stream(
    extension: &str,
    cluster: &str,
    granted: ExtensionPermissions,
) -> (ExtensionStream, tokio::task::JoinHandle<()>) {
    let task = tokio::spawn(std::future::pending::<()>());
    let stream = ExtensionStream {
        extension: extension.to_owned(),
        cluster: ClusterId::from(cluster),
        granted,
        task: task.abort_handle(),
    };
    (stream, task)
}

/// A stream of `extension` opened under what it is granted now.
fn stream_of(
    env: &Env,
    extension: &str,
    cluster: &str,
) -> (ExtensionStream, tokio::task::JoinHandle<()>) {
    pending_stream(
        extension,
        cluster,
        env.host.active(extension).unwrap().granted,
    )
}

/// Installs `id` again from its folder through the host (consent), as the window does: `extensions-changed` follows.
fn reinstall(env: &Env, id: &str, version: &str, permissions: Value) {
    let folder = env.dir.path().join("ext").join(id);
    test_support::write_folder(&folder, id, version, permissions);
    let pending = env.host.inspect_folder(&folder).unwrap();
    env.host.install(&pending.token).unwrap();
}

/// The host's events stop the streams: the wiring `start_extensions` uses in the app.
fn wire_host(env: &Env) {
    wire_host_events(&env.host, &env.api, |_| {});
}

async fn aborted(task: tokio::task::JoinHandle<()>) -> bool {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .is_ok_and(|end| end.is_err_and(|e| e.is_cancelled()))
}

#[tokio::test]
async fn streams_end_when_their_extension_is_disabled_removed_or_granted_anything_else() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    env.install(
        "gizmos",
        perms(all_clusters(), &[], &["read", "modify"], false),
    );
    wire_host(&env);
    let streams = &env.api.streams;
    let (w, widgets_task) = stream_of(&env, "widgets", "c1");
    let (g, gadgets_task) = stream_of(&env, "gadgets", "c1");
    let (z, gizmos_task) = stream_of(&env, "gizmos", "c1");
    streams.insert("w-1".into(), w).unwrap();
    streams.insert("g-1".into(), g).unwrap();
    streams.insert("z-1".into(), z).unwrap();
    let (taken, taken_task) = stream_of(&env, "gadgets", "c2");
    assert_eq!(
        streams.insert("g-1".into(), taken).unwrap_err().code,
        ErrorCode::Invalid
    );
    assert!(aborted(taken_task).await, "a refused stream does not run");

    // `extension_set_enabled(false)`: its stream goes on `extensions-changed`, the others stay.
    env.set_enabled("widgets", false);
    assert!(aborted(widgets_task).await);
    assert_eq!(streams.len(), 2);

    // Reinstalled with the same permissions: the stream stays; with narrower ones (still enabled): it goes.
    reinstall(
        &env,
        "gadgets",
        "1.0.1",
        perms(all_clusters(), &[], &["read"], false),
    );
    assert_eq!(streams.len(), 2);
    reinstall(
        &env,
        "gizmos",
        "1.0.1",
        perms(all_clusters(), &["team-a"], &["read"], false),
    );
    assert!(env.host.is_active("gizmos"), "still enabled");
    assert!(aborted(gizmos_task).await);
    assert_eq!(streams.len(), 1);

    // `extension_remove`.
    env.host.remove("gadgets").unwrap();
    assert!(aborted(gadgets_task).await);
    assert!(streams.is_empty());
}

#[tokio::test]
async fn host_events_are_forwarded_at_once_and_streams_are_checked_off_the_emitting_thread() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let (stream, task) = stream_of(&env, "widgets", "c1");
    env.api.streams.insert("w-1".into(), stream).unwrap();
    // Its folder's manifest broke: only reading the folder again finds that it is no longer active.
    std::fs::write(
        env.dir
            .path()
            .join("ext")
            .join("widgets")
            .join(sextant_core::extensions::MANIFEST_FILE),
        "{}",
    )
    .unwrap();
    let reads = Arc::new(Mutex::new(Vec::new()));
    let (reads_in, host) = (Arc::clone(&reads), env.host.downgrade());
    env.host.set_read_hook(Arc::new(move |id| {
        reads_in.lock().unwrap().push(std::thread::current().id());
        if let Some(host) = host.upgrade() {
            host.forget(id);
        }
    }));
    env.host.forget("widgets");
    let forwarded = Arc::new(Mutex::new(Vec::new()));
    let forwarded_in = Arc::clone(&forwarded);
    let emit = host_emitter(
        Arc::clone(&env.api.streams),
        Arc::clone(&env.api.forwards),
        env.host.downgrade(),
        move |_event| {
            forwarded_in
                .lock()
                .unwrap()
                .push(std::thread::current().id())
        },
    );

    // The host emits from threads of its own (a folder watcher, a command), outside any runtime.
    let emitting = std::thread::spawn(move || {
        emit(HostEvent::ListChanged);
        std::thread::current().id()
    })
    .join()
    .unwrap();

    assert_eq!(*forwarded.lock().unwrap(), vec![emitting]);
    assert!(
        aborted(task).await,
        "the stream of a broken extension stops"
    );
    assert!(env.api.streams.is_empty());
    let reads = reads.lock().unwrap();
    assert!(!reads.is_empty(), "the check read the folder");
    assert!(
        !reads.contains(&emitting),
        "the folder was read on the thread that emits the host's events"
    );
}

#[tokio::test]
async fn a_disable_stops_the_streams_even_when_re_enabled_before_the_look() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    wire_host(&env);
    let (w, task) = stream_of(&env, "widgets", "c1");
    env.api.streams.insert("w-1".into(), w).unwrap();
    // Every look at the extension reads its folder again, and a look off this thread is slow.
    let (host, here) = (env.host.downgrade(), std::thread::current().id());
    env.host.set_read_hook(Arc::new(move |id| {
        if std::thread::current().id() != here {
            std::thread::sleep(Duration::from_millis(300));
        }
        if let Some(host) = host.upgrade() {
            host.forget(id);
        }
    }));
    env.host.forget("widgets");

    env.set_enabled("widgets", false);
    // Gone at once, before any look: re-enabled right away, it must not stay.
    assert!(env.api.streams.is_empty());
    env.set_enabled("widgets", true);

    assert!(aborted(task).await, "the disabled extension's stream goes");
    assert!(env.api.streams.is_empty());
}

#[tokio::test]
async fn a_dev_folder_that_asks_for_more_stops_its_streams_until_consent() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    wire_host(&env);
    crate::extensions::dev::look(&env.host);
    let (w, widgets_task) = stream_of(&env, "widgets", "c1");
    let (g, gadgets_task) = stream_of(&env, "gadgets", "c1");
    env.api.streams.insert("w-1".into(), w).unwrap();
    env.api.streams.insert("g-1".into(), g).unwrap();

    let folder = env.dir.path().join("ext").join("widgets");
    test_support::write_folder(
        &folder,
        "widgets",
        "1.0.0",
        perms(all_clusters(), &[], &["read", "modify"], false),
    );
    crate::extensions::dev::look(&env.host);
    assert_eq!(
        env.host.info("widgets").unwrap().state,
        crate::extensions::ExtensionState::NeedsConsent
    );
    assert!(
        aborted(widgets_task).await,
        "paused for consent: its stream ends"
    );
    assert_eq!(env.api.streams.len(), 1, "another extension's stream stays");
    gadgets_task.abort();
}

#[tokio::test]
async fn a_dev_folder_that_asks_for_less_is_granted_only_that_and_its_wider_streams_stop() {
    let env = Env::new();
    let wide = perms(all_clusters(), &[], &["read", "modify"], false);
    env.install("widgets", wide.clone());
    wire_host(&env);
    crate::extensions::dev::look(&env.host);
    let (w, task) = stream_of(&env, "widgets", "c1");
    env.api.streams.insert("w-1".into(), w).unwrap();

    let narrow = perms(all_clusters(), &["team-a"], &["read"], false);
    let folder = env.dir.path().join("ext").join("widgets");
    test_support::write_folder(&folder, "widgets", "1.0.0", narrow.clone());
    crate::extensions::dev::look(&env.host);
    let narrow: ExtensionPermissions = serde_json::from_value(narrow).unwrap();
    let info = env.host.info("widgets").unwrap();
    assert_eq!(info.state, crate::extensions::ExtensionState::Active);
    assert_eq!(info.granted, narrow, "granted only what it asks for now");
    assert!(
        aborted(task).await,
        "a stream opened under the wider grant ends"
    );
    assert!(env.api.streams.is_empty());

    // Asking for the old, wider permissions again needs the user's consent again.
    test_support::write_folder(&folder, "widgets", "1.0.0", wide);
    crate::extensions::dev::look(&env.host);
    let info = env.host.info("widgets").unwrap();
    assert_eq!(info.state, crate::extensions::ExtensionState::NeedsConsent);
    assert_eq!(info.granted, narrow);
}

/// Starts `widgets`' stream `id` whose sink blocks on its first update (its task busy, not at an await) until
/// `release` gets a message; `entered` gets one when the sink is reached.
async fn stream_held_in_its_sink(
    env: &Env,
    id: &str,
) -> (
    futures::channel::mpsc::UnboundedSender<WatchUpdate>,
    std::sync::mpsc::Receiver<()>,
    std::sync::mpsc::Sender<()>,
) {
    let (updates_tx, updates_rx) = futures::channel::mpsc::unbounded::<WatchUpdate>();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    let sink: UpdateSink = Arc::new(move |_| {
        let _ = entered_tx.send(());
        let _ = lock(&release_rx).recv();
        false
    });
    let granted = env.host.active("widgets").unwrap().granted;
    env.api
        .start_stream(
            &env.host,
            id.to_owned(),
            "widgets",
            granted,
            ClusterId::from("c1"),
            async move { Ok::<_, CoreError>(updates_rx) },
            sink,
        )
        .await
        .unwrap();
    (updates_tx, entered_rx, release_tx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_that_ends_by_itself_forgets_only_itself() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    for (extension, id) in [("gadgets", "s-1"), ("widgets", "s-2")] {
        let (updates, entered, release) = stream_held_in_its_sink(&env, id).await;
        updates
            .unbounded_send(WatchUpdate::Snapshot { items: Vec::new() })
            .unwrap();
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        // Stopped while its task is busy (an abort lands at the next await), and the id taken by another stream.
        assert!(env.api.streams.stop_of("widgets", id));
        let (other, other_task) = stream_of(&env, extension, "c1");
        env.api.streams.insert(id.into(), other).unwrap();
        release.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            env.api.streams.len(),
            1,
            "the stream registered under {id} afterwards ({extension}) stays"
        );
        assert!(env.api.streams.stop_of(extension, id));
        assert!(aborted(other_task).await);
    }
}

#[tokio::test]
async fn a_watch_whose_extension_changed_before_it_was_registered_does_not_stay() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let start = |granted: ExtensionPermissions, id: &str| {
        let open = async { Ok::<_, CoreError>(futures::stream::pending::<WatchUpdate>()) };
        let sink: UpdateSink = Arc::new(|_| true);
        env.api.start_stream(
            &env.host,
            id.to_owned(),
            "widgets",
            granted,
            ClusterId::from("c1"),
            open,
            sink,
        )
    };
    // Checked under a grant that is not the one in force now (reinstalled meanwhile).
    let earlier: ExtensionPermissions =
        serde_json::from_value(perms(all_clusters(), &[], &["read", "modify"], false)).unwrap();
    let err = start(earlier, "w-1").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert!(env.api.streams.is_empty());

    let granted = env.host.active("widgets").unwrap().granted;
    start(granted.clone(), "w-2").await.unwrap();
    assert_eq!(env.api.streams.len(), 1);

    // Disabled between the checks and the registration.
    env.set_enabled("widgets", false);
    let err = start(granted, "w-3").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert_eq!(
        env.api.streams.len(),
        1,
        "only the stream registered before"
    );
}

#[tokio::test]
async fn an_extension_stops_only_its_own_streams() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let (w, task) = stream_of(&env, "widgets", "c1");
    env.api.streams.insert("w-1".into(), w).unwrap();
    assert!(!env.api.streams.stop_of("gadgets", "w-1"));
    assert_eq!(env.api.streams.len(), 1);
    assert!(env.api.streams.stop_of("widgets", "w-1"));
    assert!(aborted(task).await);
    assert!(
        !env.api.streams.stop_of("widgets", "w-1"),
        "already stopped"
    );
}

#[tokio::test]
async fn streams_end_with_their_cluster_or_the_page() {
    let env = Env::new();
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    let streams = &env.api.streams;
    let (g1, gadgets_c1) = stream_of(&env, "gadgets", "c1");
    let (g2, gadgets_c2) = stream_of(&env, "gadgets", "c2");
    streams.insert("g-1".into(), g1).unwrap();
    streams.insert("g-2".into(), g2).unwrap();
    streams.stop_cluster(&ClusterId::from("c1"));
    assert!(aborted(gadgets_c1).await);
    assert_eq!(streams.len(), 1);

    // A page reload stops everything and declines the extension confirmations it showed.
    let task = gadgets_c2;
    let confirmations = Arc::clone(&env.api.confirmations);
    let waiting = tokio::spawn(async move {
        confirmations
            .ask(
                ConfirmRequest {
                    id: String::new(),
                    source: ConfirmSource::Extension,
                    principal: "Extension x".into(),
                    client: "x".into(),
                    cluster_id: ClusterId::from("c1"),
                    cluster_name: "c1".into(),
                    tool: "resources.delete".into(),
                    target: "Pod a/b".into(),
                    details: None,
                },
                |_| true,
            )
            .await
    });
    while env.api.confirmations.pending() == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    env.api.reset();
    assert!(aborted(task).await);
    assert_eq!(waiting.await.unwrap(), ConfirmOutcome::Declined);
}

#[tokio::test]
async fn the_journal_is_its_own_file_filtered_by_extension() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    env.install("gadgets", perms(all_clusters(), &[], &["read"], false));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&events);
    env.api.set_emitter(Arc::new(move |event| {
        sink.lock().unwrap().push(event);
        true
    }));
    for id in ["widgets", "gadgets", "widgets"] {
        env.api
            .call(&env.host, id, "clusters.list", json!({}), None)
            .await
            .unwrap();
    }
    assert_eq!(env.api.audit_list(Some("widgets")).len(), 2);
    assert_eq!(env.api.audit_list(None).len(), 3);
    assert_eq!(events.lock().unwrap().len(), 3, "ext-audit for every call");
    let data = env.dir.path().join("data");
    assert!(data.join("extensions-audit.jsonl").exists());
    assert!(!data.join("mcp-audit.jsonl").exists());
    env.api.audit.clear().unwrap();
    assert!(env.api.audit_list(None).is_empty());
}

/// A Kubernetes API server for one Secret: `/api` (to connect) and `team-a/db` with `password: hunter2`; anything
/// else is 404.
async fn fake_cluster() -> String {
    use axum::http::{StatusCode, Uri, header};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = axum::Router::new().fallback(|uri: Uri| async move {
        let (status, body) = match uri.path() {
            "/api" => (
                StatusCode::OK,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            "/api/v1/namespaces/monitoring/services/prometheus-k8s:9090/proxy/api/v1/query" => (
                StatusCode::OK,
                r#"{"status":"success","data":{"resultType":"vector",
                    "result":[{"metric":{"namespace":"rook-ceph"},"value":[100,"3"]}]}}"#,
            ),
            // API token Secrets of Argo CD, found by their labels (#371): the list comes with key names only.
            "/api/v1/namespaces/argocd/secrets" => (
                StatusCode::OK,
                r#"{"apiVersion":"v1","kind":"SecretList","metadata":{"resourceVersion":"1"},"items":[
                    {"metadata":{"name":"argocd-token-ci","namespace":"argocd","labels":{"app.kubernetes.io/part-of":"argocd"}},
                     "data":{"token":"dDBr"}},
                    {"metadata":{"name":"argocd-notifications-secret","namespace":"argocd","labels":{"app.kubernetes.io/part-of":"argocd"}},
                     "data":{"slack":"eA=="}}]}"#,
            ),
            "/api/v1/namespaces/team-a/secrets/db" => (
                StatusCode::OK,
                r#"{"apiVersion":"v1","kind":"Secret","metadata":{"name":"db","namespace":"team-a"},
                    "data":{"password":"aHVudGVyMg=="}}"#,
            ),
            _ => (
                StatusCode::NOT_FOUND,
                r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#,
            ),
        };
        (status, [(header::CONTENT_TYPE, "application/json")], body)
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    url
}

#[tokio::test]
async fn malformed_calls_never_push_out_a_secret_read_nor_read_as_allowed() {
    use crate::access_guard::audit::CAPACITY;
    let env = Env::at(&fake_cluster().await);
    env.install(
        "widgets",
        perms(
            all_clusters(),
            &["team-a"],
            &["read", "secretValues"],
            false,
        ),
    );
    env.install(
        "gadgets",
        perms(all_clusters(), &["team-a"], &["read"], false),
    );
    let read =
        json!({ "clusterId": "ctx-a", "namespace": "team-a", "name": "db", "key": "password" });
    let value = env
        .api
        .call(&env.host, "widgets", "secret.value", read.clone(), None)
        .await
        .unwrap();
    assert_eq!(value, json!("hunter2"));
    let real = env.api.audit_list(Some("widgets"))[0].clone();
    assert_eq!(
        (real.decision, real.result.as_str()),
        (AuditDecision::Allowed, "ok")
    );

    // Calls that end before any access decision: no parameters, missing or empty fields, an unknown cluster, an
    // unknown field.
    let malformed = [
        json!({}),
        json!({ "clusterId": "ctx-a" }),
        json!({ "clusterId": "ctx-a", "namespace": "", "name": "db", "key": "password" }),
        json!({ "clusterId": "no-such-cluster", "namespace": "team-a", "name": "db", "key": "password" }),
        json!({ "clusterId": "ctx-a", "namespace": "team-a", "name": "db", "key": "password", "extra": 1 }),
    ];
    for i in 0..(3 * CAPACITY) {
        let params = malformed[i % malformed.len()].clone();
        let err = env
            .api
            .call(&env.host, "widgets", "secret.value", params, None)
            .await
            .unwrap_err();
        assert_ne!(err.code, ErrorCode::Denied, "{}", err.message);
    }
    let kept = env.api.audit_list(Some("widgets"));
    assert_eq!(kept.len(), CAPACITY);
    assert!(kept.contains(&real), "the real secret read stays");
    assert!(
        kept.iter()
            .filter(|e| **e != real)
            .all(|e| e.decision == AuditDecision::NotChecked),
        "malformed calls are journaled as not checked"
    );

    // Without "Secret values": malformed calls are not checked, a well-formed one is denied; none reads as allowed.
    let mut calls: Vec<(&str, Value)> = malformed
        .iter()
        .map(|p| ("secret.value", p.clone()))
        .collect();
    calls.push(("secret.value", read));
    // A granted cluster is no decision: a delete of a kind the cluster does not serve ends before the check.
    let mystery = json!({ "kind": { "kind": "Mystery" }, "namespace": "team-a", "name": "x" });
    calls.push((
        "resources.delete",
        json!({ "clusterId": "ctx-a", "ref": mystery }),
    ));
    calls.push(("secret.steal", json!({})));
    for (method, params) in &calls {
        let result = env
            .api
            .call(&env.host, "gadgets", method, params.clone(), None)
            .await;
        assert!(result.is_err(), "{method} {params}");
    }
    let journal = env.api.audit_list(Some("gadgets"));
    assert_eq!(journal.len(), calls.len());
    let decisions: Vec<AuditDecision> = journal.iter().rev().map(|e| e.decision).collect();
    let mut expected = vec![AuditDecision::NotChecked; malformed.len()];
    expected.extend([
        AuditDecision::Denied,
        AuditDecision::NotChecked,
        AuditDecision::NotChecked,
    ]);
    assert_eq!(decisions, expected);
}

#[tokio::test]
async fn a_development_folder_read_again_during_a_call_is_read_off_the_runtime() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let granted = env.host.active("widgets").unwrap().granted;
    // The runtime of this test runs on this thread only: a manifest read here held up every call.
    let runtime_thread = std::thread::current().id();
    let reads = Arc::new(Mutex::new(Vec::new()));
    let (reads_in, host) = (Arc::clone(&reads), env.host.downgrade());
    // The folder changes all the time: every read is forgotten at once, so every look at the extension reads it
    // again (walking the folder), as after a `forget` between two checks of one call.
    env.host.set_read_hook(Arc::new(move |id| {
        reads_in.lock().unwrap().push(std::thread::current().id());
        if let Some(host) = host.upgrade() {
            host.forget(id);
        }
    }));
    env.host.forget("widgets");

    env.api
        .call(&env.host, "widgets", "clusters.list", json!({}), None)
        .await
        .unwrap();
    // Reads the grant to find the cluster, then fails to connect.
    let list = json!({ "clusterId": "ctx-a", "kind": { "kind": "Pod" } });
    let listed = env
        .api
        .call(&env.host, "widgets", "resources.list", list, None)
        .await;
    assert!(listed.is_err());
    let open = async { Ok::<_, CoreError>(futures::stream::pending::<WatchUpdate>()) };
    let sink: UpdateSink = Arc::new(|_| true);
    env.api
        .start_stream(
            &env.host,
            "w-1".to_owned(),
            "widgets",
            granted,
            ClusterId::from("c1"),
            open,
            sink,
        )
        .await
        .unwrap();
    env.api.streams.stop_all();

    let reads = reads.lock().unwrap();
    // The first look of each call, the grant of each of the two calls, and the stream's look before it stays.
    assert!(reads.len() >= 5, "{} reads", reads.len());
    assert!(
        !reads.contains(&runtime_thread),
        "a manifest was read on the runtime's thread"
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Against the test cluster

const NS: &str = "sextant-ext-api-test";

struct Live {
    _dir: tempfile::TempDir,
    state: AppState,
    host: ExtensionHost,
    cluster: ClusterId,
}

impl Live {
    async fn call(&self, method: &str, params: Value) -> CoreResult<Value> {
        self.state
            .ext_api
            .call(&self.host, "widgets", method, params, None)
            .await
    }
}

async fn live(permissions: Value) -> Option<Live> {
    let Some(kubeconfig) = std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
    else {
        eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
        return None;
    };
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(&dir.path().join("config"), &dir.path().join("data"));
    state.registry.write().unwrap().set_env(KubeconfigEnv {
        kubeconfig: Some(kubeconfig),
        home: Some(dir.path().join("home")),
    });
    let cluster = state.registry.read().unwrap().clusters().unwrap()[0]
        .id
        .clone();
    state.clusters.connect(&cluster).await.unwrap();
    let host = ExtensionHost::new(&dir.path().join("data"), Arc::clone(&state.settings));
    install_into(dir.path(), &state.settings, "widgets", permissions);
    Some(Live {
        _dir: dir,
        state,
        host,
        cluster,
    })
}

/// Waits until the namespace `name` left by an earlier run is gone (deleting a namespace takes a while).
async fn wait_gone(live: &Live, name: &str) {
    let ns = ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Namespace".into(),
        },
        namespace: None,
        name: name.into(),
    };
    for _ in 0..240 {
        match resources::get(&live.state.clusters, &live.cluster, &ns).await {
            Err(e) if e.code == ErrorCode::NotFound => return,
            _ => tokio::time::sleep(Duration::from_millis(250)).await,
        }
    }
    panic!("namespace {name} is still there");
}

/// Applies `yaml` as the cluster admin (not through the extension).
async fn admin_apply(live: &Live, yaml: &str) {
    resources::apply_yaml(&live.state.clusters, &live.cluster, yaml)
        .await
        .unwrap();
}

fn cluster_scope_rules() -> Value {
    json!({ "clusters": { "type": "all" }, "rules": [
        { "namespaces": { "type": "only", "namespaces": [NS] }, "kinds": { "type": "all" },
          "actions": ["read", "modify", "delete"], "confirm": false },
        { "namespaces": { "type": "only", "namespaces": ["sextant-demo"] }, "kinds": { "type": "all" },
          "actions": ["read", "logs"], "confirm": false }
    ] })
}

#[tokio::test]
async fn every_method_against_the_test_cluster() {
    let Some(live) = live(cluster_scope_rules()).await else {
        return;
    };
    wait_gone(&live, NS).await;
    admin_apply(
        &live,
        &format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {NS}\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  \
             name: db\n  namespace: {NS}\nstringData:\n  password: hunter2-test-only\n---\napiVersion: v1\nkind: \
             ConfigMap\nmetadata:\n  name: settings\n  namespace: {NS}\ndata:\n  mode: a\n"
        ),
    )
    .await;
    let id = live.cluster.0.clone();
    let cm = json!({ "kind": { "kind": "ConfigMap" }, "namespace": NS, "name": "settings" });
    let secret = json!({ "kind": { "kind": "Secret" }, "namespace": NS, "name": "db" });

    // clusters.list, kinds
    let clusters = live.call("clusters.list", json!({})).await.unwrap();
    assert!(
        clusters
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == json!(id))
    );
    let kinds = live
        .call("kinds", json!({ "clusterId": id }))
        .await
        .unwrap();
    assert!(
        kinds
            .as_array()
            .unwrap()
            .iter()
            .any(|k| k["kindRef"]["kind"] == "ConfigMap")
    );

    // resources.list: in the namespace, and over all namespaces only the granted ones.
    let listed = live
        .call(
            "resources.list",
            json!({ "clusterId": id, "kind": { "kind": "ConfigMap" }, "namespace": NS }),
        )
        .await
        .unwrap();
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|o| o["metadata"]["name"] == "settings")
    );
    let everywhere = live
        .call(
            "resources.list",
            json!({ "clusterId": id, "kind": { "kind": "ConfigMap" } }),
        )
        .await
        .unwrap();
    assert_eq!(everywhere["namespaces"], json!(["sextant-demo", NS]));
    let nodes = live
        .call(
            "resources.list",
            json!({ "clusterId": id, "kind": { "kind": "Node" } }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        nodes.code,
        ErrorCode::Denied,
        "a namespace rule never covers Nodes"
    );

    // resources.get: a Secret without values; secret.value needs "Secret values".
    let got = live
        .call("resources.get", json!({ "clusterId": id, "ref": secret }))
        .await
        .unwrap();
    assert_eq!(got["data"]["password"], "");
    assert!(!got.to_string().contains("hunter2"));
    let value = live
        .call(
            "secret.value",
            json!({ "clusterId": id, "namespace": NS, "name": "db", "key": "password" }),
        )
        .await
        .unwrap_err();
    assert_eq!(value.code, ErrorCode::Denied);
    let outside = live
        .call("resources.get", json!({ "clusterId": id, "ref": {
            "kind": { "kind": "ConfigMap" }, "namespace": "default", "name": "kube-root-ca.crt" } }))
        .await
        .unwrap_err();
    assert_eq!(outside.code, ErrorCode::Denied);

    // resources.getMany: each object in its place, a missing one as its error; a batch with one object the extension
    // may not read is refused as a whole.
    let missing =
        json!({ "kind": { "kind": "ConfigMap" }, "namespace": NS, "name": "no-such-map" });
    let many = live
        .call(
            "resources.getMany",
            json!({ "clusterId": id, "refs": [cm, secret, missing] }),
        )
        .await
        .unwrap();
    let items = many["items"].as_array().unwrap();
    assert_eq!(items[0]["object"]["metadata"]["name"], cm["name"]);
    assert_eq!(items[1]["object"]["data"]["password"], "");
    assert!(!many.to_string().contains("hunter2"));
    assert_eq!(items[2]["error"]["code"], "notFound");
    let outside = json!({ "kind": { "kind": "ConfigMap" }, "namespace": "default", "name": "kube-root-ca.crt" });
    let refused = live
        .call(
            "resources.getMany",
            json!({ "clusterId": id, "refs": [cm, outside] }),
        )
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Denied);
    let too_many: Vec<Value> = (0..=MAX_GET_MANY).map(|_| cm.clone()).collect();
    let err = live
        .call(
            "resources.getMany",
            json!({ "clusterId": id, "refs": too_many }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);

    // resources.patch: a merge patch; on a Secret, a JSON patch that may read values needs "Secret values".
    let patched = live
        .call(
            "resources.patch",
            json!({ "clusterId": id, "ref": cm, "patchType": "merge",
                                          "patch": { "data": { "mode": "b" } } }),
        )
        .await
        .unwrap();
    assert_eq!(patched["data"]["mode"], "b");
    let copy = live
        .call("resources.patch", json!({ "clusterId": id, "ref": secret, "patchType": "json",
            "patch": [{ "op": "copy", "from": "/data/password", "path": "/metadata/annotations/x" }] }))
        .await
        .unwrap_err();
    assert_eq!(copy.code, ErrorCode::Denied);
    assert!(copy.message.contains("secret values"), "{}", copy.message);
    live.call(
        "resources.patch",
        json!({ "clusterId": id, "ref": secret, "patchType": "json",
            "patch": [{ "op": "add", "path": "/metadata/labels", "value": { "app": "x" } }] }),
    )
    .await
    .unwrap();

    // resources.apply: checked per object; another namespace is refused before anything is sent.
    let applied = live
        .call("resources.apply", json!({ "clusterId": id, "yaml": format!(
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: applied\n  namespace: {NS}\ndata:\n  a: \"1\"\n") }))
        .await
        .unwrap();
    assert_eq!(applied[0]["name"], "applied");
    let two = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: second\n  namespace: {NS}\n---\napiVersion: v1\nkind: \
         ConfigMap\nmetadata:\n  name: sneaky\n  namespace: default\n"
    );
    let refused = live
        .call("resources.apply", json!({ "clusterId": id, "yaml": two }))
        .await
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Denied);
    let second = json!({ "kind": { "kind": "ConfigMap" }, "namespace": NS, "name": "second" });
    let err = live
        .call("resources.get", json!({ "clusterId": id, "ref": second }))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        ErrorCode::NotFound,
        "nothing of a refused apply is sent"
    );

    // resources.create (#412): a new object once; the same name again is a conflict and the object stays as it was;
    // another namespace is refused before anything is sent.
    let fresh = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: created\n  namespace: {NS}\ndata:\n  a: \"1\"\n"
    );
    let created = live
        .call(
            "resources.create",
            json!({ "clusterId": id, "yaml": fresh }),
        )
        .await
        .unwrap();
    assert_eq!(created["name"], "created");
    let again = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: created\n  namespace: {NS}\ndata:\n  a: \"2\"\n"
    );
    let taken = live
        .call(
            "resources.create",
            json!({ "clusterId": id, "yaml": again }),
        )
        .await
        .unwrap_err();
    assert_eq!(taken.code, ErrorCode::Conflict, "{}", taken.message);
    let kept = live
        .call("resources.get", json!({ "clusterId": id, "ref": { "kind": { "kind": "ConfigMap" }, "namespace": NS, "name": "created" } }))
        .await
        .unwrap();
    assert_eq!(kept["data"]["a"], "1");
    let elsewhere = live
        .call(
            "resources.create",
            json!({ "clusterId": id, "yaml":
            "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: sneaky\n  namespace: default\n" }),
        )
        .await
        .unwrap_err();
    assert_eq!(elsewhere.code, ErrorCode::Denied);

    // Node shell pods: by name (no rule needed to refuse), and by label on a live pod.
    let named = json!({ "kind": { "kind": "Pod" }, "namespace": "kube-system", "name": "sextant-node-shell-x-abcde" });
    let err = live
        .call("resources.delete", json!({ "clusterId": id, "ref": named }))
        .await
        .unwrap_err();
    assert_eq!(err.message, NODE_SHELL_REFUSAL);
    admin_apply(
        &live,
        &format!(
            "apiVersion: v1\nkind: Pod\nmetadata:\n  name: disguised\n  namespace: {NS}\n  labels:\n    \
             sextant.dev/node-shell: \"true\"\nspec:\n  containers:\n  - name: c\n    image: registry.k8s.io/pause:3.9\n"
        ),
    )
    .await;
    let disguised = json!({ "kind": { "kind": "Pod" }, "namespace": NS, "name": "disguised" });
    let unlabel = live
        .call(
            "resources.patch",
            json!({ "clusterId": id, "ref": disguised, "patchType": "merge",
            "patch": { "metadata": { "labels": { "sextant.dev/node-shell": null } } } }),
        )
        .await
        .unwrap_err();
    assert_eq!(unlabel.message, NODE_SHELL_REFUSAL);
    let delete = live
        .call(
            "resources.delete",
            json!({ "clusterId": id, "ref": disguised }),
        )
        .await
        .unwrap_err();
    assert_eq!(delete.message, NODE_SHELL_REFUSAL);
    let missing = json!({ "kind": { "kind": "Pod" }, "namespace": NS, "name": "no-such-pod" });
    let unread = live
        .call(
            "resources.delete",
            json!({ "clusterId": id, "ref": missing }),
        )
        .await
        .unwrap_err();
    assert!(
        unread.message.contains("could not read"),
        "fail closed: {}",
        unread.message
    );

    // logs.tail
    let pods = resources::list(
        &live.state.clusters,
        &live.cluster,
        &KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        Some("sextant-demo"),
        Some("app=nginx"),
        None,
        1,
    )
    .await
    .unwrap();
    let nginx = pods.items[0]["metadata"]["name"]
        .as_str()
        .unwrap()
        .to_owned();
    let log = live
        .call(
            "logs.tail",
            json!({ "clusterId": id, "namespace": "sextant-demo", "pod": nginx, "lines": 5 }),
        )
        .await
        .unwrap();
    assert!(log.is_string());
    let no_logs = live
        .call(
            "logs.tail",
            json!({ "clusterId": id, "namespace": NS, "pod": "disguised" }),
        )
        .await
        .unwrap_err();
    assert_eq!(
        no_logs.code,
        ErrorCode::Denied,
        "logs were granted only in sextant-demo"
    );

    // resources.delete
    live.call("resources.delete", json!({ "clusterId": id, "ref": cm }))
        .await
        .unwrap();

    // resources.watch: a stream in AppState that ends when the extension is disabled.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WatchUpdate>();
    let sink: UpdateSink = Arc::new(move |update| tx.send(update).is_ok());
    live.state
        .ext_api
        .call(
            &live.host,
            "widgets",
            "resources.watch",
            json!({ "clusterId": id, "kind": { "kind": "Secret" }, "namespaces": [NS] }),
            Some(("ext-stream-1".into(), sink)),
        )
        .await
        .unwrap();
    assert_eq!(live.state.ext_api.streams.len(), 1);
    let first = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .unwrap()
        .unwrap();
    let WatchUpdate::Snapshot { items } = first else {
        panic!("first update is a snapshot: {first:?}");
    };
    assert!(
        items
            .iter()
            .any(|o| o.to_value()["metadata"]["name"] == "db")
    );
    assert!(
        !serde_json::to_string(&items).unwrap().contains("hunter2"),
        "no Secret values in a watch"
    );
    let denied_watch = live
        .state
        .ext_api
        .call(
            &live.host,
            "widgets",
            "resources.watch",
            json!({ "clusterId": id, "kind": { "kind": "Secret" }, "namespaces": ["kube-system"] }),
            Some(("ext-stream-2".into(), Arc::new(|_: WatchUpdate| true))),
        )
        .await
        .unwrap_err();
    assert_eq!(denied_watch.code, ErrorCode::Denied);

    // Without namespaces: only the namespaces the grant covers; with none granted for reading: denied.
    let (tx_all, mut rx_all) = tokio::sync::mpsc::unbounded_channel::<WatchUpdate>();
    let sink: UpdateSink = Arc::new(move |update| tx_all.send(update).is_ok());
    live.state
        .ext_api
        .call(
            &live.host,
            "widgets",
            "resources.watch",
            json!({ "clusterId": id, "kind": { "kind": "ConfigMap" }, "namespaces": null }),
            Some(("ext-stream-3".into(), sink)),
        )
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(10), rx_all.recv())
        .await
        .unwrap()
        .unwrap();
    let WatchUpdate::Snapshot { items } = first else {
        panic!("first update is a snapshot: {first:?}");
    };
    let namespaces: std::collections::BTreeSet<String> = items
        .iter()
        .map(|o| {
            o.to_value()["metadata"]["namespace"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert!(namespaces.contains(NS), "{namespaces:?}");
    assert!(
        namespaces
            .iter()
            .all(|ns| *ns == NS || *ns == "sextant-demo"),
        "only granted namespaces: {namespaces:?}"
    );
    install_into(
        live._dir.path(),
        &live.state.settings,
        "gadgets",
        perms(all_clusters(), &[NS], &["logs"], false),
    );
    let none = live
        .state
        .ext_api
        .call(
            &live.host,
            "gadgets",
            "resources.watch",
            json!({ "clusterId": id, "kind": { "kind": "ConfigMap" } }),
            Some(("ext-stream-4".into(), Arc::new(|_: WatchUpdate| true))),
        )
        .await
        .unwrap_err();
    assert_eq!(none.code, ErrorCode::Denied);

    // Disabled through the host: both streams end on `extensions-changed`.
    wire_host_events(&live.host, &live.state.ext_api, |_| {});
    assert_eq!(live.state.ext_api.streams.len(), 2);
    live.host.set_enabled("widgets", false).unwrap();
    assert!(live.state.ext_api.streams.is_empty());

    // Everything was journaled, without the Secret's value.
    let journal = live.state.ext_api.audit_list(Some("widgets"));
    assert!(journal.len() >= 15, "{}", journal.len());
    assert!(!serde_json::to_string(&journal).unwrap().contains("hunter2"));
    assert!(journal.iter().all(|e| e.source == ConfirmSource::Extension));

    // Clean up as the admin.
    let ns = ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Namespace".into(),
        },
        namespace: None,
        name: NS.into(),
    };
    resources::delete(&live.state.clusters, &live.cluster, &ns)
        .await
        .unwrap();
    live.state.close_all();
}

#[tokio::test]
async fn a_change_that_asks_waits_for_the_window_on_the_test_cluster() {
    let mut rules = cluster_scope_rules();
    rules["rules"][0]["confirm"] = json!(true);
    let Some(live) = live(rules).await else {
        return;
    };
    const ASK_NS: &str = "sextant-ext-api-ask";
    wait_gone(&live, ASK_NS).await;
    admin_apply(
        &live,
        &format!("apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {ASK_NS}\n"),
    )
    .await;
    // The rule covers only NS; make one for the namespace of this test.
    let mut granted = cluster_scope_rules();
    granted["rules"][0]["namespaces"]["namespaces"] = json!([ASK_NS]);
    granted["rules"][0]["confirm"] = json!(true);
    install_into(live._dir.path(), &live.state.settings, "widgets", granted);

    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_in = Arc::clone(&seen);
    let confirmations = Arc::clone(&live.state.ext_api.confirmations);
    live.state.ext_api.set_emitter(Arc::new(move |event| {
        if let ApiEvent::Confirm(request) = event {
            seen_in.lock().unwrap().push(request.clone());
            let confirmations = Arc::clone(&confirmations);
            tokio::spawn(async move {
                let _ = confirmations.answer(&request.id, false);
            });
        }
        true
    }));
    let id = live.cluster.0.clone();
    let yaml = format!(
        "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: asked\n  namespace: {ASK_NS}\n"
    );
    let err = live
        .call("resources.apply", json!({ "clusterId": id, "yaml": yaml }))
        .await
        .unwrap_err();
    assert!(
        err.message.starts_with("The user declined resources.apply"),
        "{}",
        err.message
    );
    let request = seen.lock().unwrap()[0].clone();
    assert_eq!(request.principal, "Extension Ext widgets");
    assert_eq!(request.source, ConfirmSource::Extension);
    assert!(
        request
            .details
            .unwrap()
            .contains("ConfigMap sextant-ext-api-ask/asked")
    );
    let journal = live.state.ext_api.audit_list(Some("widgets"));
    assert_eq!(journal[0].decision, AuditDecision::Declined);

    let ns = ObjectRef {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Namespace".into(),
        },
        namespace: None,
        name: ASK_NS.into(),
    };
    resources::delete(&live.state.clusters, &live.cluster, &ns)
        .await
        .unwrap();
    live.state.close_all();
}

#[tokio::test]
async fn an_unreadable_storage_file_is_an_error_and_is_kept() {
    let env = Env::new();
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));
    let file = env.host.storage_dir().join("widgets.json");
    std::fs::create_dir_all(env.host.storage_dir()).unwrap();
    std::fs::write(&file, "{not json").unwrap();
    for (method, params) in [
        ("storage.get", json!({ "key": "a" })),
        ("storage.set", json!({ "key": "a", "value": 1 })),
        ("storage.remove", json!({ "key": "a" })),
    ] {
        let err = env
            .api
            .call(&env.host, "widgets", method, params, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Other, "{method}");
        assert!(err.message.contains("cannot be read"), "{}", err.message);
    }
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{not json");
}

#[tokio::test]
async fn a_long_extension_id_is_clipped_in_the_journal() {
    let env = Env::new();
    let long = "x".repeat(1000);
    let _ = env
        .api
        .call(&env.host, &long, "clusters.list", json!({}), None)
        .await;
    let entry = &env.api.audit_list(None)[0];
    assert!(entry.client.chars().count() < 300, "{}", entry.client.len());
    assert!(entry.client.ends_with("…[cut]"));
}

/// What a failed exec plugin printed reaches the window's connection state, never an extension: neither the error of
/// a call that connected the cluster nor `clusters.list` carries it (#256).
#[cfg(unix)]
#[tokio::test]
async fn an_extension_never_gets_what_a_failed_exec_plugin_printed() {
    let user = "{ exec: { apiVersion: client.authentication.k8s.io/v1, command: sh, \
                args: [-c, 'echo PLUGIN-SAID not logged in >&2; exit 1'], interactiveMode: Never } }";
    let env = Env::with_kubeconfig(
        &KUBECONFIG
            .replace("SERVER", "https://127.0.0.1:9")
            .replace("user: {}", &format!("user: {user}")),
    );
    env.install("widgets", perms(all_clusters(), &[], &["read"], false));

    let err = env
        .call("widgets", "kinds")
        .open("ctx-a")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthPlugin, "{err}");
    assert_eq!(err.plugin_output, None);
    assert!(!serde_json::to_string(&err).unwrap().contains("PLUGIN-SAID"));

    let id = env.cluster_id("ctx-a");
    match env.api.clusters.state(&id) {
        ConnectionState::Error(state) => {
            assert!(
                state
                    .plugin_output
                    .unwrap()
                    .contains("PLUGIN-SAID not logged in")
            );
        }
        other => panic!("expected an error state, got {other:?}"),
    }
    let listed = env
        .api
        .call(&env.host, "widgets", "clusters.list", json!({}), None)
        .await
        .unwrap();
    assert!(!listed.to_string().contains("PLUGIN-SAID"), "{listed}");
    assert_eq!(listed[0]["state"]["state"], "error", "{listed}");
}

#[test]
fn objects_reach_an_extension_without_their_inline_secret_material() {
    let route = json!({
        "apiVersion": "route.openshift.io/v1", "kind": "Route",
        "metadata": { "name": "web", "namespace": "a" },
        "spec": { "host": "web.example.com", "tls": { "key": "-----BEGIN PRIVATE KEY-----", "certificate": "cert" } },
    });
    let out = without_inline_secrets(route);
    assert_eq!(out["spec"]["tls"]["key"], "");
    assert_eq!(out["spec"]["tls"]["certificate"], "cert");
    assert!(!out.to_string().contains("PRIVATE KEY"));
    // Saving such a copy back is refused by the core (the marker of hidden values).
    assert!(
        out["metadata"]["annotations"]
            .get("sextant.dev/values-hidden")
            .is_some()
    );
    let config_map = json!({ "apiVersion": "v1", "kind": "ConfigMap", "data": { "key": "v" } });
    assert_eq!(without_inline_secrets(config_map.clone()), config_map);
}

/// Agrees to the metric query `ceph_health_status{namespace="{{ns}}"}` of `id` and points `context`'s metrics at a
/// Prometheus Service.
fn agree_to_metric_query(env: &Env, id: &str, context: &str) {
    let query: sextant_core::extensions::metric_queries::MetricQuery =
        serde_json::from_value(json!({
            "id": "health",
            "title": "Ceph health",
            "query": "ceph_health_status{namespace=\"{{ns}}\"}",
            "params": [{ "name": "ns", "type": "namespace" }]
        }))
        .unwrap();
    let cluster = env.cluster_id(context);
    env.settings
        .update(|s| {
            let entry = s.extensions.iter_mut().find(|e| e.id == id).unwrap();
            entry.granted_metric_queries = Some(vec![query]);
            let settings = s.clusters.entry(cluster.0.clone()).or_default();
            settings.prometheus = sextant_core::metrics::PrometheusMode::Manual {
                target: sextant_core::metrics::PrometheusTarget::Service {
                    namespace: "monitoring".into(),
                    service: "prometheus-k8s".into(),
                    port: 9090,
                    path_prefix: String::new(),
                },
            };
        })
        .unwrap();
}

#[tokio::test]
async fn a_metric_query_runs_only_when_agreed_to_and_is_journaled_without_its_answer() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "ceph",
        perms(only(&["ctx-a"]), &["rook-ceph"], &["read"], false),
    );
    let call = |params: Value| {
        env.api
            .call(&env.host, "ceph", "metrics.query", params, None)
    };

    // Not agreed to: refused before the cluster is touched.
    let err =
        call(json!({ "clusterId": "ctx-a", "id": "health", "params": { "ns": "rook-ceph" } }))
            .await
            .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    assert!(
        err.message.contains("not a query of its manifest"),
        "{}",
        err.message
    );
    let journal = env.api.audit_list(Some("ceph"));
    assert_eq!(journal[0].tool, "metrics.query");
    assert_eq!(journal[0].target, "health(ns=rook-ceph)");
    assert_eq!(journal[0].decision, AuditDecision::Denied);
    assert!(journal[0].cluster_id.is_none());

    agree_to_metric_query(&env, "ceph", "ctx-a");
    let answer =
        call(json!({ "clusterId": "ctx-a", "id": "health", "params": { "ns": "rook-ceph" } }))
            .await
            .unwrap();
    assert_eq!(answer["resultType"], "vector");
    assert_eq!(answer["series"][0]["points"], json!([[100.0, 3.0]]));
    let journal = env.api.audit_list(Some("ceph"));
    assert_eq!(journal[0].decision, AuditDecision::Allowed);
    assert_eq!(journal[0].result, "ok");
    assert_eq!(journal[0].cluster_name.as_deref(), Some("ctx-a"));

    // A cluster outside the grant, a bad value, PromQL in place of an id, unknown fields: refused.
    let err =
        call(json!({ "clusterId": "ctx-b", "id": "health", "params": { "ns": "rook-ceph" } }))
            .await
            .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    let err = call(
        json!({ "clusterId": "ctx-a", "id": "health", "params": { "ns": "a\"} or up{x=\"" } }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let err = call(json!({ "clusterId": "ctx-a", "id": "up", "params": {} }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    let err = call(json!({ "clusterId": "ctx-a", "id": "health", "query": "up" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let err = call(
        json!({ "clusterId": "ctx-a", "id": "health", "params": { "ns": "rook-ceph" },
        "range": { "minutes": 5, "step": "1m" } }),
    )
    .await
    .unwrap_err();
    assert!(err.message.contains("instant query"), "{}", err.message);
}

/// The namespace of the command test (its own: the pod takes a while to go).
const COMMAND_NS: &str = "sextant-ext-commands";

#[tokio::test]
async fn a_declared_command_runs_in_its_pod_and_nothing_else_does() {
    let rules = json!({ "clusters": { "type": "all" }, "rules": [
        { "namespaces": { "type": "only", "namespaces": [COMMAND_NS] }, "kinds": { "type": "all" },
          "actions": ["read"], "confirm": false }
    ] });
    let Some(live) = live(rules).await else {
        return;
    };
    admin_apply(
        &live,
        &format!(
            "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: {COMMAND_NS}\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  \
             name: tools\n  namespace: {COMMAND_NS}\n  labels:\n    app: tools\nspec:\n  terminationGracePeriodSeconds: 0\n  \
             containers:\n  - name: tools\n    image: busybox:stable\n    command: [\"sleep\", \"3600\"]\n"
        ),
    )
    .await;
    let commands: Vec<commands::CommandContribution> = serde_json::from_value(json!([
        { "id": "say", "title": "Say a word", "target": { "labelSelector": "app=tools", "container": "tools" },
          "argv": ["echo", "{{word}}"], "params": [{ "name": "word", "type": "enum", "values": ["hello", "bye"] }] },
        { "id": "wipe", "title": "Change something", "target": { "labelSelector": "app=tools", "container": "tools" },
          "argv": ["true"], "changes": true }
    ]))
    .unwrap();
    live.state
        .settings
        .update(|s| {
            let entry = s.extensions.iter_mut().find(|e| e.id == "widgets").unwrap();
            entry.granted_commands = Some(commands);
        })
        .unwrap();
    let id = live.cluster.0.clone();
    let say = |word: &str| json!({ "clusterId": id, "id": "say", "namespace": COMMAND_NS, "params": { "word": word } });
    // The pod becomes ready.
    let mut answer = None;
    for _ in 0..120 {
        match live.call("exec.run", say("hello")).await {
            Ok(value) => {
                answer = Some(value);
                break;
            }
            Err(err) if err.code == ErrorCode::NotFound => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(err) => panic!("{err:?}"),
        }
    }
    let answer = answer.expect("the pod never became ready");
    assert_eq!(answer["stdout"], "hello\n");
    assert_eq!(answer["exitCode"], 0);
    assert_eq!(answer["pod"], "tools");
    // The journal keeps the command's title and the words it ran, never what it printed.
    let journal = live.state.ext_api.audit_list(Some("widgets"));
    let last = journal.first().unwrap();
    assert_eq!(last.tool, "exec.run");
    assert_eq!(
        last.target,
        format!("Say a word in namespace {COMMAND_NS}: echo hello")
    );

    // A value its type refuses, a command it does not have, words of its own: nothing runs.
    let err = live.call("exec.run", say("hello; id")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let err = live
        .call(
            "exec.run",
            json!({ "clusterId": id, "id": "shell", "namespace": COMMAND_NS }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    let err = live
        .call(
            "exec.run",
            json!({ "clusterId": id, "id": "say", "namespace": COMMAND_NS, "argv": ["sh"] }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    // One that changes something asks the user, and with no window to ask it is declined.
    let err = live
        .call(
            "exec.run",
            json!({ "clusterId": id, "id": "wipe", "namespace": COMMAND_NS }),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    // Another namespace is not readable for the extension.
    let err = live
        .call("exec.run", json!({ "clusterId": id, "id": "say", "namespace": "default", "params": { "word": "bye" } }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);

    resources::delete(
        &live.state.clusters,
        &live.cluster,
        &ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Namespace".into(),
            },
            namespace: None,
            name: COMMAND_NS.into(),
        },
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn opening_logs_is_decided_as_logs_on_the_pod_or_the_namespace() {
    let env = Env::new();
    env.install(
        "widgets",
        perms(all_clusters(), &["team-a"], &["read", "logs"], false),
    );
    let call = |params: Value| {
        env.api
            .call(&env.host, "widgets", "logs.open", params, None)
    };
    let ok = call(
        json!({ "clusterId": "ctx-a", "namespace": "team-a", "pod": "web-1", "container": "app" }),
    )
    .await
    .unwrap();
    assert_eq!(ok, Value::Null);
    let selected =
        call(json!({ "clusterId": "ctx-a", "namespace": "team-a", "labelSelector": "app=web" }))
            .await;
    assert!(selected.is_ok(), "{selected:?}");
    let err = call(json!({ "clusterId": "ctx-a", "namespace": "team-b", "pod": "web-1" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    let err = call(json!({ "clusterId": "ctx-a", "namespace": "team-a" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
    let journal = env.api.audit_list(Some("widgets"));
    // Newest first.
    assert_eq!(journal[3].target, "Pod team-a/web-1 container app");
    assert_eq!(journal[2].target, "pods app=web in team-a");
}

#[tokio::test]
async fn port_forwards_need_the_action_and_belong_to_their_extension() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "widgets",
        perms(all_clusters(), &["team-a"], &["read"], false),
    );
    env.install(
        "gadgets",
        perms(all_clusters(), &["team-a"], &["read", "portForward"], false),
    );
    let start = json!({ "clusterId": "ctx-a", "namespace": "team-a", "kind": "Service", "name": "web", "port": 80 });
    let err = env
        .api
        .call(
            &env.host,
            "widgets",
            "portForward.start",
            start.clone(),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    let bad = json!({ "clusterId": "ctx-a", "namespace": "team-a", "kind": "Service", "name": "web", "port": 0 });
    let err = env
        .api
        .call(&env.host, "gadgets", "portForward.start", bad, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
    // A node shell pod is refused by name before anything is asked.
    let shell = json!({ "clusterId": "ctx-a", "namespace": "kube-system", "kind": "Pod",
                        "name": "sextant-node-shell-worker-abc12", "port": 22 });
    let err = env
        .api
        .call(&env.host, "gadgets", "portForward.start", shell, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    // Nothing of another extension (or nothing at all) can be listed or stopped.
    let listed = env
        .api
        .call(&env.host, "gadgets", "portForward.list", json!({}), None)
        .await
        .unwrap();
    assert_eq!(listed, json!({ "forwards": [] }));
    let err = env
        .api
        .call(
            &env.host,
            "gadgets",
            "portForward.stop",
            json!({ "id": "pf-1" }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{}", err.message);
}

#[tokio::test]
async fn a_status_patch_needs_its_kind_granted_and_is_the_only_subresource() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "widgets",
        perms(all_clusters(), &[], &["read", "modify"], false),
    );
    let pod = json!({ "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": "team-a", "name": "web" });
    let patch = |subresource: &str| {
        json!({ "clusterId": "ctx-a", "ref": pod, "patch": { "status": { "phase": "x" } }, "patchType": "merge",
                "subresource": subresource })
    };
    let err = env
        .api
        .call(
            &env.host,
            "widgets",
            "resources.patch",
            patch("scale"),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
    let err = env
        .api
        .call(
            &env.host,
            "widgets",
            "resources.patch",
            patch("status"),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    assert!(
        err.message.contains("status of Pod team-a/web"),
        "{}",
        err.message
    );
}

fn grant_services(env: &Env, id: &str, services: Value) {
    let services: Vec<sextant_core::extensions::services::ServiceContribution> =
        serde_json::from_value(services).unwrap();
    env.settings
        .update(|s| {
            let entry = s.extensions.iter_mut().find(|e| e.id == id).unwrap();
            entry.granted_services = Some(services);
        })
        .unwrap();
    env.host.forget(id);
}

#[tokio::test]
async fn a_service_request_reaches_only_agreed_services_with_read_and_port_forward() {
    let env = Env::at(&fake_cluster().await);
    env.install("argo", perms(all_clusters(), &["argocd"], &["read"], false));
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": "https", "scheme": "https" }]),
    );
    let call = |params: Value| {
        env.api
            .call(&env.host, "argo", "service.request", params, None)
    };
    let request = |service: &str, path: &str| json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": service, "method": "GET", "path": path });
    // Not agreed to: not found, before the cluster is touched.
    let err = call(request("other", "/api/version")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{}", err.message);
    // A path with a query, a `..` or a `#`: invalid.
    for path in ["/api?x=1", "/a/../b", "api"] {
        let err = call(request("api", path)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid, "{path}: {}", err.message);
    }
    let mut bad = request("api", "/api/v1/session");
    bad["body"] = json!({ "password": "x {{secret:argocd-initial-admin-secret/password}}" });
    let err = call(bad).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
    let mut bad = request("api", "/api/v1/session");
    bad["auth"] = json!("basic");
    assert_eq!(call(bad).await.unwrap_err().code, ErrorCode::Invalid);
    // Without Port forward on Services there: denied.
    let err = call(request("api", "/api/version")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    let journal = env.api.audit_list(Some("argo"));
    assert_eq!(
        journal[0].target,
        "Service argocd/argocd-server: GET /api/version"
    );
}

#[tokio::test]
async fn a_secret_a_service_request_sends_needs_secret_values() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "argo",
        perms(all_clusters(), &["argocd"], &["read", "portForward"], false),
    );
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": 443, "scheme": "https" }]),
    );
    let login = json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api", "method": "POST",
        "path": "/api/v1/session", "capture": ".token",
        "body": { "username": "admin", "password": "{{secret:argocd-initial-admin-secret/password}}" } });
    let err = env
        .api
        .call(&env.host, "argo", "service.request", login, None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    assert!(err.message.contains("Secret"), "{}", err.message);
    // Signing out needs nothing and sends nothing.
    let forget = json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" });
    assert_eq!(
        env.api
            .call(&env.host, "argo", "service.forget", forget, None)
            .await
            .unwrap(),
        Value::Null
    );
}

#[test]
fn secret_values_go_only_where_the_body_names_them_and_a_captured_token_never_comes_back() {
    let mut body = json!({ "username": "admin", "password": "{{secret:argocd-initial-admin-secret/password}}",
                           "list": ["{{secret:argocd-initial-admin-secret/password}}", "x"] });
    let mut found = Vec::new();
    secret_placeholders(&body, &mut found).unwrap();
    assert_eq!(
        found,
        vec![(
            "argocd-initial-admin-secret".to_owned(),
            "password".to_owned()
        )]
    );
    fill_secret(
        &mut body,
        "argocd-initial-admin-secret",
        "password",
        "hunter2",
    );
    assert_eq!(body["password"], json!("hunter2"));
    assert_eq!(body["list"], json!(["hunter2", "x"]));
    for bad in [
        json!("{{secret:Bad_Name/key}}"),
        json!("{{secret:name}}"),
        json!("pre {{secret:a/b}}"),
    ] {
        assert!(secret_placeholders(&bad, &mut Vec::new()).is_err(), "{bad}");
    }
    let mut answer = json!({ "token": "t0k", "user": "admin" });
    let steps = parse_field_path(".token").unwrap();
    assert_eq!(take_at(&mut answer, &steps).as_deref(), Some("t0k"));
    assert_eq!(answer, json!({ "token": "<hidden>", "user": "admin" }));
    assert_eq!(take_at(&mut json!({ "token": "" }), &steps), None);
}

#[tokio::test]
async fn a_call_for_an_ai_agent_needs_the_agents_own_access_too() {
    use sextant_core::access::{AccessRule, KindScope};
    let env = Env::new();
    env.install(
        "argo",
        perms(all_clusters(), &["team-a"], &["read", "logs"], false),
    );
    let agent = || {
        Some(AgentLimit {
            client: "claude-code".into(),
        })
    };
    let open_logs = json!({ "clusterId": "ctx-a", "namespace": "team-a", "pod": "web-1" });
    // The agent's access is closed by default: the extension's grant alone is not enough.
    let err = env
        .api
        .call_as(
            &env.host,
            "argo",
            "logs.open",
            open_logs.clone(),
            None,
            agent(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    assert!(
        err.message.contains("AI agent claude-code"),
        "{}",
        err.message
    );
    let journal = env.api.audit_list(Some("argo"));
    assert_eq!(
        journal[0].principal,
        "AI agent claude-code through extension Ext argo"
    );
    // The agent may read logs in team-a: allowed, as the extension may too.
    let id = env.cluster_id("ctx-a");
    env.settings
        .update(|s| {
            let cluster = s.clusters.entry(id.0.clone()).or_default();
            cluster.agent_access = ClusterAccess {
                preset: AccessPreset::Custom,
                rules: vec![AccessRule {
                    namespaces: NamespaceScope::Only {
                        namespaces: vec!["team-a".into()],
                    },
                    kinds: KindScope::All,
                    actions: vec![AccessAction::Read, AccessAction::Logs],
                    confirm: false,
                }],
            };
        })
        .unwrap();
    let ok = env
        .api
        .call_as(&env.host, "argo", "logs.open", open_logs, None, agent())
        .await;
    assert!(ok.is_ok(), "{ok:?}");
    // Never more than the extension may: another namespace the agent may not read either way.
    let err = env
        .api
        .call_as(
            &env.host,
            "argo",
            "logs.open",
            json!({ "clusterId": "ctx-a", "namespace": "team-b", "pod": "web-1" }),
            None,
            agent(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied);
    // Without the agent, the extension alone decides.
    assert!(
        env.api
            .call(
                &env.host,
                "argo",
                "logs.open",
                json!({ "clusterId": "ctx-a", "namespace": "team-a", "pod": "x" }),
                None
            )
            .await
            .is_ok()
    );
    assert_eq!(
        intersect(
            NamespaceScope::Only {
                namespaces: vec!["a".into(), "b".into()]
            },
            NamespaceScope::Only {
                namespaces: vec!["b".into(), "c".into()]
            }
        ),
        NamespaceScope::Only {
            namespaces: vec!["b".into()]
        }
    );
}

#[tokio::test]
async fn an_agent_tool_runs_only_when_the_user_lets_agents_have_the_extensions_tools() {
    let env = Env::new();
    env.install("argo", perms(all_clusters(), &[], &["read"], false));
    let err = env
        .api
        .agent_tool_call(&env.host, "argo", "sync", json!({}), "claude-code")
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    let entry = &env.api.audit_list(Some("argo"))[0];
    assert_eq!(
        (entry.tool.as_str(), entry.target.as_str()),
        ("agentTool", "sync")
    );
    assert_eq!(entry.decision, AuditDecision::Denied);
}

#[tokio::test]
async fn a_sign_in_typed_in_sextants_dialog_fills_the_request_and_never_comes_back() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "argo",
        perms(all_clusters(), &["argocd"], &["read", "portForward"], false),
    );
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": 443, "scheme": "https",
                 "signIn": { "fields": [{ "id": "username", "label": "User" }, { "id": "password", "label": "Password", "secret": true }] } }]),
    );
    let login = |field: &str| {
        json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api", "method": "POST", "path": "/api/v1/session",
                "capture": ".token", "body": { "username": "{{signIn:username}}", "password": format!("{{{{signIn:{field}}}}}") } })
    };
    let call = |params: Value| {
        env.api
            .call(&env.host, "argo", "service.request", params, None)
    };
    // A field the service does not declare: invalid.
    assert_eq!(
        call(login("token")).await.unwrap_err().code,
        ErrorCode::Invalid
    );
    // Nothing typed yet: the extension is told to ask for it.
    let err = call(login("password")).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unauthorized, "{}", err.message);
    // Other fields than the service declares are refused.
    let id = env.cluster_id("ctx-a").0;
    let partial: HashMap<String, String> = [("username".to_owned(), "admin".to_owned())].into();
    assert!(
        env.api
            .sign_in(&env.host, "argo", &id, "argocd", "api", partial, false)
            .await
            .is_err()
    );
    let values: HashMap<String, String> = [
        ("username".to_owned(), "admin".to_owned()),
        ("password".to_owned(), "hunter2".to_owned()),
    ]
    .into();
    env.api
        .sign_in(&env.host, "argo", &id, "argocd", "api", values, false)
        .await
        .unwrap();
    // Signed in: the request goes on to the forward (none in this test), past the sign-in.
    let err = call(login("password")).await.unwrap_err();
    assert_ne!(err.code, ErrorCode::Unauthorized, "{}", err.message);
    assert!(!err.message.contains("hunter2"));
    let journal = env.api.audit_list(Some("argo"));
    assert!(journal.iter().any(|e| e.tool == "ui.signIn"));
    assert!(journal.iter().all(|e| !e.target.contains("hunter2")));
    // Signing out drops it.
    env.api
        .call(
            &env.host,
            "argo",
            "service.forget",
            json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" }),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        call(login("password")).await.unwrap_err().code,
        ErrorCode::Unauthorized
    );
}

#[tokio::test]
async fn a_secret_key_a_service_declares_needs_no_secret_values_on_the_namespace() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "argo",
        perms(all_clusters(), &["argocd"], &["read", "portForward"], false),
    );
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "labelSelector": "app.kubernetes.io/name=argocd-server", "port": 443,
                 "scheme": "https", "secrets": [{ "name": "argocd-initial-admin-secret", "key": "password" }] }]),
    );
    let login = |secret: &str| {
        json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api", "method": "POST", "path": "/api/v1/session",
                "capture": ".token", "body": { "username": "admin", "password": format!("{{{{secret:{secret}}}}}") } })
    };
    let call = |params: Value| {
        env.api
            .call(&env.host, "argo", "service.request", params, None)
    };
    // The declared key: allowed without "Secret values" (the fake cluster has no such Secret: not found, not denied).
    let err = call(login("argocd-initial-admin-secret/password"))
        .await
        .unwrap_err();
    assert_ne!(err.code, ErrorCode::Denied, "{}", err.message);
    // Another key: "Secret values" on the namespace, which this extension does not have.
    let err = call(login("argocd-initial-admin-secret/other"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    // A token from a sign-in field the service does not declare: invalid.
    let mut token = login("argocd-initial-admin-secret/password");
    token["auth"] = json!("signIn:token");
    assert_eq!(call(token).await.unwrap_err().code, ErrorCode::Invalid);
    let journal = env.api.audit_list(Some("argo"));
    assert!(
        journal.iter().any(|e| e.target
            == "Service argocd/app.kubernetes.io/name=argocd-server: POST /api/v1/session")
    );
}

#[tokio::test]
async fn secrets_picked_by_labels_are_listed_by_name_and_may_be_the_bearer_token() {
    let env = Env::at(&fake_cluster().await);
    env.install(
        "argo",
        perms(all_clusters(), &["argocd"], &["read", "portForward"], false),
    );
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": 443, "scheme": "https",
                 "secrets": [{ "labelSelector": "app.kubernetes.io/part-of=argocd", "key": "token" }] }]),
    );
    let call =
        |method: &'static str, params: Value| env.api.call(&env.host, "argo", method, params, None);
    // Names only, and only of Secrets with the key.
    let found = call(
        "service.secrets",
        json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" }),
    )
    .await
    .unwrap();
    assert_eq!(
        found,
        json!({ "secrets": [{ "name": "argocd-token-ci", "key": "token" }] })
    );
    let request = |auth: &str| {
        json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api", "method": "GET",
                "path": "/api/v1/session/userinfo", "auth": auth })
    };
    // A labelled Secret's agreed key: no "Secret values" needed (the fake cluster cannot read it: not denied).
    let err = call("service.request", request("secret:argocd-token-ci/token"))
        .await
        .unwrap_err();
    assert_ne!(err.code, ErrorCode::Denied, "{}", err.message);
    assert!(!err.message.contains("t0k"), "{}", err.message);
    // A Secret the selector does not pick, or another key: "Secret values", which the extension does not have.
    for auth in [
        "secret:db/token",
        "secret:argocd-notifications-secret/slack",
    ] {
        let err = call("service.request", request(auth)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Denied, "{auth}: {}", err.message);
    }
    // A malformed one: invalid.
    let err = call("service.request", request("secret:/token"))
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid, "{}", err.message);
}

#[tokio::test]
async fn the_sign_in_state_says_saved_for_this_run_or_none_and_never_a_value() {
    let env = Env::at(&fake_cluster().await);
    env.install("argo", perms(all_clusters(), &["argocd"], &["read"], false));
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": 443, "scheme": "https",
                 "signIn": { "fields": [{ "id": "token", "label": "Token", "secret": true }] } }]),
    );
    let state = || {
        env.api.call(
            &env.host,
            "argo",
            "service.signInState",
            json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" }),
            None,
        )
    };
    assert_eq!(state().await.unwrap(), json!({ "state": "none" }));
    let id = env.cluster_id("ctx-a").0;
    let values: HashMap<String, String> = [("token".to_owned(), "t0k3n".to_owned())].into();
    env.api
        .sign_in(&env.host, "argo", &id, "argocd", "api", values, false)
        .await
        .unwrap();
    let answer = state().await.unwrap();
    assert_eq!(answer, json!({ "state": "session" }));
    assert!(!answer.to_string().contains("t0k3n"));
    // A service the user did not agree to: not found.
    let err = env
        .api
        .call(
            &env.host,
            "argo",
            "service.signInState",
            json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "other" }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{}", err.message);
}

#[tokio::test]
async fn forgetting_only_the_saved_sign_in_keeps_this_runs_session() {
    let env = Env::at(&fake_cluster().await);
    env.install("argo", perms(all_clusters(), &["argocd"], &["read"], false));
    grant_services(
        &env,
        "argo",
        json!([{ "id": "api", "title": "Argo CD API", "name": "argocd-server", "port": 443, "scheme": "https",
                 "signIn": { "fields": [{ "id": "token", "label": "Token", "secret": true }] } }]),
    );
    let id = env.cluster_id("ctx-a").0;
    let values: HashMap<String, String> = [("token".to_owned(), "t0k3n".to_owned())].into();
    env.api
        .sign_in(&env.host, "argo", &id, "argocd", "api", values, false)
        .await
        .unwrap();
    let call = |params: Value| {
        env.api
            .call(&env.host, "argo", "service.forget", params, None)
    };
    let state = || {
        env.api.call(
            &env.host,
            "argo",
            "service.signInState",
            json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" }),
            None,
        )
    };
    call(json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api", "saved": true }))
        .await
        .unwrap();
    assert_eq!(state().await.unwrap(), json!({ "state": "session" }));
    call(json!({ "clusterId": "ctx-a", "namespace": "argocd", "service": "api" }))
        .await
        .unwrap();
    assert_eq!(state().await.unwrap(), json!({ "state": "none" }));
}

#[tokio::test]
async fn several_patches_are_decided_together_under_one_confirmation_and_stop_at_the_first_failure()
{
    let env = Env::at(&fake_cluster().await);
    env.install(
        "widgets",
        perms(all_clusters(), &["team-a"], &["read", "modify"], true),
    );
    let seen = env.answer_with(true);
    let pod = |name: &str, ns: &str| json!({ "kind": { "group": "", "version": "v1", "kind": "Pod" }, "namespace": ns, "name": name });
    let item = |name: &str, ns: &str| json!({ "ref": pod(name, ns), "patch": { "metadata": { "labels": { "a": "b" } } }, "patchType": "merge" });
    // One item outside the grant: nothing is asked, nothing sent.
    let err = env
        .api
        .call(&env.host, "widgets", "resources.patchMany",
              json!({ "clusterId": "ctx-a", "items": [item("web-1", "team-a"), item("web-2", "team-b")] }), None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Denied, "{}", err.message);
    assert!(seen.lock().unwrap().is_empty());
    // Both granted: one question for both; the fake cluster has no such pod, so the first fails and the rest is not sent.
    let answer = env
        .api
        .call(&env.host, "widgets", "resources.patchMany",
              json!({ "clusterId": "ctx-a", "items": [item("web-1", "team-a"), item("web-2", "team-a")] }), None)
        .await
        .unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(
        seen.lock().unwrap()[0].target.contains("web-1")
            && seen.lock().unwrap()[0].target.contains("web-2")
    );
    assert_eq!(answer["sent"], json!(0));
    assert_eq!(answer["items"].as_array().unwrap().len(), 1);
    assert_eq!(answer["items"][0]["error"]["code"], json!("notFound"));
    let none = env
        .api
        .call(
            &env.host,
            "widgets",
            "resources.patchMany",
            json!({ "clusterId": "ctx-a", "items": [] }),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(none.code, ErrorCode::Invalid);
}
