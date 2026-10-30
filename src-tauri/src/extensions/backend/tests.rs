//! Backends against the test component of `crates/sextant-ext-runtime` (`tests/fixtures/guest.wasm`): installed from a
//! package like any extension, called as its frames call it, reaching Sextant only through the extension API.

use std::sync::{Arc, RwLock};

use serde_json::{Value, json};
use sextant_core::extensions::{BackendGrant, MANIFEST_FILE, asks_within, parse_manifest};
use sextant_core::kubeconfig::{KubeconfigEnv, KubeconfigRegistry};
use sextant_core::{ClusterManager, ErrorCode, SettingsStore};

use super::allowed_url;
use crate::access_guard::confirm::Confirmations;
use crate::extensions::api::ExtensionApi;
use crate::extensions::test_support::stored_zip;
use crate::extensions::{ExtensionHost, ExtensionState};

const GUEST: &[u8] =
    include_bytes!("../../../../crates/sextant-ext-runtime/tests/fixtures/guest.wasm");
const ID: &str = "acme.backend";

const KUBECONFIG: &str = "apiVersion: v1
kind: Config
clusters:
- name: c
  cluster: { server: https://127.0.0.1:9 }
users:
- name: u
  user: { token: t }
contexts:
- name: ctx-a
  context: { cluster: c, user: u }
current-context: ctx-a
";

struct Env {
    dir: tempfile::TempDir,
    api: Arc<ExtensionApi>,
    host: ExtensionHost,
}

fn manifest(version: &str, backend: Value) -> String {
    json!({
        "id": ID, "name": "Backend demo", "version": version, "description": "", "author": "Me",
        "sextantApi": 1, "entry": "index.html", "contributes": {},
        "permissions": { "clusters": { "type": "all" }, "rules": [
            { "namespaces": { "type": "all" }, "kinds": { "type": "all" }, "actions": ["read"], "confirm": false }
        ] },
        "backend": backend,
    })
    .to_string()
}

fn declared() -> Value {
    json!({
        "module": "backend.wasm",
        "network": { "hosts": ["api.example.com"] },
        "credentials": [{ "id": "token", "label": "API token" }]
    })
}

fn package(version: &str, backend: Value, module: &[u8]) -> Vec<u8> {
    let manifest = manifest(version, backend);
    stored_zip(&[
        (MANIFEST_FILE, manifest.as_bytes()),
        ("index.html", b"<p>hello</p>"),
        ("backend.wasm", module),
    ])
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let kubeconfig = dir.path().join("kubeconfig");
        std::fs::write(&kubeconfig, KUBECONFIG).unwrap();
        let settings = Arc::new(SettingsStore::open(dir.path().join("config/settings.json")));
        let mut registry = KubeconfigRegistry::new(Vec::new(), dir.path().join("data/kubeconfigs"));
        registry.set_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.into_os_string()),
            home: Some(dir.path().join("home")),
        });
        let clusters = ClusterManager::new(Arc::new(RwLock::new(registry)));
        let data = dir.path().join("data");
        let api = Arc::new(ExtensionApi::new(
            clusters,
            Arc::clone(&settings),
            Arc::new(Confirmations::default()),
            &data,
        ));
        let host = ExtensionHost::new(&data, settings);
        Self { dir, api, host }
    }

    fn inspect(
        &self,
        version: &str,
        backend: Value,
        module: &[u8],
    ) -> sextant_core::CoreResult<super::super::PendingInstall> {
        let file = self
            .dir
            .path()
            .join(format!("backend-{version}.sextant-ext"));
        std::fs::write(&file, package(version, backend, module)).unwrap();
        self.host.inspect_file(&file)
    }

    fn install(&self) {
        let pending = self.inspect("1.0.0", declared(), GUEST).unwrap();
        let info = self.host.install(&pending.token).unwrap();
        assert_eq!(info.state, ExtensionState::Active);
    }

    async fn call(&self, method: &str, params: Value) -> sextant_core::CoreResult<Value> {
        self.api
            .call(
                &self.host,
                ID,
                "backend.call",
                json!({ "method": method, "params": params }),
                None,
            )
            .await
    }

    /// `host.call(method, params)` from inside the backend (the test component's `host` method).
    async fn host_call(&self, method: &str, params: Value) -> sextant_core::CoreResult<Value> {
        self.call("host", Value::String(format!("{method}\n{params}")))
            .await
    }
}

#[tokio::test]
async fn a_backend_that_is_not_a_component_is_refused_before_consent() {
    let env = Env::new();
    let err = env.inspect("1.0.0", declared(), b"not wasm").unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    assert!(
        err.message
            .starts_with("sextant-extension.json: backend.module: "),
        "{}",
        err.message
    );
    let missing = env
        .inspect("1.0.0", json!({ "module": "elsewhere.wasm" }), GUEST)
        .unwrap_err();
    assert_eq!(
        missing.message,
        "sextant-extension.json: backend.module: `elsewhere.wasm` is not in the package"
    );
}

#[tokio::test]
async fn a_frames_call_reaches_the_backend_and_is_journaled() {
    let env = Env::new();
    env.install();
    // `params` is passed as JSON text and the answer read as JSON.
    assert_eq!(
        env.call("echo", json!({ "a": [1, 2] })).await.unwrap(),
        json!({ "a": [1, 2] })
    );
    let err = env.call("nothing", json!({})).await.unwrap_err();
    assert_eq!(err.message, "unknown method nothing");
    let err = env.call("bad method!", json!({})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Invalid);
    let journal = env.api.audit_list(Some(ID));
    assert_eq!(journal[0].tool, "backend.call");
    assert!(
        journal
            .iter()
            .any(|e| e.tool == "backend.call" && e.target == "echo" && e.result == "ok")
    );
}

#[tokio::test]
async fn the_backend_reaches_clusters_only_through_the_extension_api() {
    let env = Env::new();
    env.install();
    let clusters = env.host_call("clusters.list", json!({})).await.unwrap();
    assert_eq!(clusters[0]["context"], "ctx-a", "{clusters}");
    // Its calls are the extension's, in the same journal.
    assert!(
        env.api
            .audit_list(Some(ID))
            .iter()
            .any(|e| e.tool == "clusters.list")
    );
    for method in ["resources.watch", "backend.call"] {
        let err = env.host_call(method, json!({})).await.unwrap_err();
        assert_eq!(
            err.message,
            format!("invalid: {method} is not available to a backend")
        );
    }
}

#[tokio::test]
async fn credentials_are_read_only_when_declared_and_entered() {
    let env = Env::new();
    env.install();
    assert_eq!(
        env.host_call("credentials.get", json!({ "name": "token" }))
            .await
            .unwrap(),
        Value::Null
    );
    env.host
        .set_credential(ID, "token", Some("s3cret"))
        .unwrap();
    assert_eq!(
        env.host_call("credentials.get", json!({ "name": "token" }))
            .await
            .unwrap(),
        json!("s3cret")
    );
    assert_eq!(
        env.host.credentials_status(ID).unwrap(),
        [("token".to_owned(), true)]
    );
    let err = env
        .host_call("credentials.get", json!({ "name": "other" }))
        .await
        .unwrap_err();
    assert_eq!(
        err.message,
        "forbidden: the manifest declares no credential `other`"
    );
    assert!(env.host.set_credential(ID, "other", Some("x")).is_err());
    // Removing the extension removes its credentials.
    env.host.remove(ID).unwrap();
    env.install();
    assert_eq!(
        env.host_call("credentials.get", json!({ "name": "token" }))
            .await
            .unwrap(),
        Value::Null
    );
}

#[tokio::test]
async fn requests_to_undeclared_hosts_are_refused_and_journaled() {
    let env = Env::new();
    env.install();
    let err = env
        .call("fetch", json!("https://elsewhere.example.org/x?token=abc"))
        .await
        .unwrap_err();
    assert!(err.message.contains("HttpRequestDenied"), "{}", err.message);
    let journal = env.api.audit_list(Some(ID));
    let request = journal.iter().find(|e| e.tool == "http").unwrap();
    // The path only: never the query string.
    assert_eq!(request.target, "GET elsewhere.example.org/x");
    assert_eq!(request.result, "denied");
}

#[test]
fn only_https_on_443_to_a_declared_host_is_allowed() {
    let hosts = ["api.example.com".to_owned()];
    let url = |u: &str| reqwest::Url::parse(u).unwrap();
    assert!(allowed_url(&url("https://api.example.com/v1"), &hosts));
    assert!(allowed_url(&url("https://API.example.com:443/v1"), &hosts));
    for refused in [
        "http://api.example.com/",
        "https://api.example.com:8443/",
        "https://user:pass@api.example.com/",
        "https://evil.example.com/",
        "https://api.example.com.evil.org/",
        "https://127.0.0.1/",
    ] {
        assert!(!allowed_url(&url(refused), &hosts), "{refused}");
    }
}

#[tokio::test]
async fn logs_are_kept_and_a_failing_backend_is_paused_until_reloaded() {
    let env = Env::new();
    env.install();
    env.call("log", json!("a line")).await.unwrap();
    let log: Vec<String> = env
        .host
        .backend_log(ID)
        .into_iter()
        .map(|l| l.message)
        .collect();
    assert!(
        log.contains(&"\"a line\"".to_owned()) || log.contains(&"a line".to_owned()),
        "{log:?}"
    );
    assert!(log.contains(&"to stdout".to_owned()), "{log:?}");
    for _ in 0..3 {
        env.call("panic", json!(null)).await.unwrap_err();
    }
    let err = env.call("echo", json!(1)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("paused"), "{}", err.message);
    env.host.reload(ID).unwrap();
    assert_eq!(env.call("echo", json!(1)).await.unwrap(), json!(1));
}

#[tokio::test]
async fn a_new_host_or_credential_brings_consent_back() {
    let env = Env::new();
    env.install();
    let same = env.inspect("1.0.1", declared(), GUEST).unwrap();
    assert!(!same.new_permissions);
    let mut wider = declared();
    wider["network"]["hosts"] = json!(["api.example.com", "other.example.com"]);
    assert!(env.inspect("1.0.2", wider, GUEST).unwrap().new_permissions);
    let mut more = declared();
    more["credentials"] =
        json!([{ "id": "token", "label": "API token" }, { "id": "key", "label": "Key" }]);
    assert!(env.inspect("1.0.3", more, GUEST).unwrap().new_permissions);

    // The rule itself: no backend granted, then a backend asked for, is more.
    let parsed = parse_manifest(manifest("1.0.0", declared()).as_bytes()).unwrap();
    let grant = BackendGrant {
        hosts: vec!["api.example.com".into()],
        credentials: vec!["token".into()],
    };
    assert!(asks_within(
        &parsed,
        &parsed.permissions,
        Some(&grant),
        None,
        None
    ));
    assert!(!asks_within(&parsed, &parsed.permissions, None, None, None));
}
