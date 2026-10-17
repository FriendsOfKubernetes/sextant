//! Shared helpers for integration tests against the kind cluster from `scripts/test-cluster.sh`.
//!
//! Tests run only when `SEXTANT_TEST_KUBECONFIG` points at the admin kubeconfig; otherwise they return early
//! (and pass), so `cargo test --workspace` works without a cluster:
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --tests -- --test-threads=1
//! ```
//!
//! Usage in `tests/<feature>.rs`:
//!
//! ```ignore
//! mod common;
//!
//! #[tokio::test]
//! async fn something() {
//!     let Some(cluster) = common::test_cluster() else { return };
//!     let client = cluster.client().await;
//!     // ...
//! }
//! ```
#![allow(dead_code)]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use sextant_core::kubeconfig::KubeconfigEnv;
use sextant_core::{ClusterId, ClusterManager, KubeconfigRegistry};

/// Admin kubeconfig of the test cluster.
pub const KUBECONFIG_ENV: &str = "SEXTANT_TEST_KUBECONFIG";
/// Optional override for the `limited` ServiceAccount kubeconfig; default is `kubeconfig-limited` next to the admin one.
pub const LIMITED_KUBECONFIG_ENV: &str = "SEXTANT_TEST_KUBECONFIG_LIMITED";

/// Namespace with the fixtures (nginx deployment + service, CronJob `hello`, ConfigMap `demo-config`,
/// Secret `demo-secret`, Widget `demo-widget`, ServiceAccount `limited`).
pub const DEMO_NAMESPACE: &str = "sextant-demo";
/// Context name inside the admin kubeconfig written by kind.
pub const ADMIN_CONTEXT: &str = "kind-sextant-test";
/// Context name inside the limited kubeconfig.
pub const LIMITED_CONTEXT: &str = "sextant-test-limited";
/// Turns on the tests of the GitOps tools installed by `scripts/test-cluster.sh up --gitops`.
pub const GITOPS_ENV: &str = "SEXTANT_TEST_GITOPS";

pub struct TestCluster {
    pub kubeconfig: PathBuf,
    pub limited_kubeconfig: PathBuf,
}

/// The test cluster, or `None` (with a note on stderr) when `SEXTANT_TEST_KUBECONFIG` is not set.
pub fn test_cluster() -> Option<TestCluster> {
    let Some(path) = std::env::var_os(KUBECONFIG_ENV).filter(|v| !v.is_empty()) else {
        eprintln!("skipped: {KUBECONFIG_ENV} is not set (see scripts/test-cluster.sh)");
        return None;
    };
    let kubeconfig = PathBuf::from(path);
    assert!(
        kubeconfig.is_file(),
        "{KUBECONFIG_ENV}={} does not exist",
        kubeconfig.display()
    );
    let limited_kubeconfig = std::env::var_os(LIMITED_KUBECONFIG_ENV)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| kubeconfig.with_file_name("kubeconfig-limited"));
    Some(TestCluster {
        kubeconfig,
        limited_kubeconfig,
    })
}

impl TestCluster {
    /// A plain kube client with admin rights, for test setup and assertions.
    pub async fn client(&self) -> kube::Client {
        client_from(&self.kubeconfig).await
    }

    /// A kube client authenticated as the `limited` ServiceAccount (token auth, no access to Secrets).
    pub async fn limited_client(&self) -> kube::Client {
        client_from(&self.limited_kubeconfig).await
    }
}

pub async fn client_from(path: &Path) -> kube::Client {
    let kubeconfig = kube::config::Kubeconfig::read_from(path)
        .unwrap_or_else(|e| panic!("cannot read kubeconfig {}: {e}", path.display()));
    let config = kube::Config::from_custom_kubeconfig(
        kubeconfig,
        &kube::config::KubeConfigOptions::default(),
    )
    .await
    .unwrap_or_else(|e| panic!("bad kubeconfig {}: {e}", path.display()));
    kube::Client::try_from(config).expect("kube client")
}

/// The test cluster when it has Flux and Argo CD (`SEXTANT_TEST_GITOPS=1`), otherwise `None` with a note.
pub fn gitops_cluster() -> Option<TestCluster> {
    let cluster = test_cluster()?;
    if std::env::var(GITOPS_ENV).as_deref() != Ok("1") {
        eprintln!("skipped: {GITOPS_ENV}=1 is not set (see scripts/test-cluster.sh up --gitops)");
        return None;
    }
    Some(cluster)
}

/// Admin kubeconfig of a throwaway cluster without Flux and Argo CD, for the real install test.
pub const INSTALL_KUBECONFIG_ENV: &str = "SEXTANT_TEST_INSTALL_KUBECONFIG";

/// The kubeconfig of the throwaway install cluster, or `None` (with a note on stderr) when
/// `SEXTANT_TEST_INSTALL_KUBECONFIG` is not set.
pub fn install_cluster() -> Option<PathBuf> {
    let Some(path) = std::env::var_os(INSTALL_KUBECONFIG_ENV).filter(|v| !v.is_empty()) else {
        eprintln!(
            "skipped: {INSTALL_KUBECONFIG_ENV} is not set (a throwaway kind cluster without Flux and Argo CD, see \
             tests/gitops_install.rs)"
        );
        return None;
    };
    let kubeconfig = PathBuf::from(path);
    assert!(
        kubeconfig.is_file(),
        "{INSTALL_KUBECONFIG_ENV}={} does not exist",
        kubeconfig.display()
    );
    Some(kubeconfig)
}

/// A manager connected to the only context of `kubeconfig`.
pub async fn connected(kubeconfig: &Path) -> (tempfile::TempDir, ClusterManager, ClusterId) {
    let tmp = tempfile::tempdir().unwrap();
    let registry =
        KubeconfigRegistry::new(Vec::new(), tmp.path().to_path_buf()).with_env(KubeconfigEnv {
            kubeconfig: Some(kubeconfig.as_os_str().to_owned()),
            home: None,
        });
    let id = registry.clusters().unwrap()[0].id.clone();
    let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
    mgr.connect(&id).await.unwrap();
    (tmp, mgr, id)
}

/// Polls `done` until it is true; panics after `secs` seconds naming `what`.
pub async fn wait_until<F, Fut>(what: &str, secs: u64, mut done: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !done().await {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}
