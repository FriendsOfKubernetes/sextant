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

use std::path::{Path, PathBuf};

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
