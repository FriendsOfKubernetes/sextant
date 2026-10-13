//! Cloud clusters against fake `aws`, `gcloud`, `az` and `gke-gcloud-auth-plugin`: shell scripts in a temporary
//! directory at the front of `PATH` that answer with the JSON the real CLIs print. From finding the CLIs to importing
//! clusters and reading them back as a kubeconfig source. No cloud account and no real CLI is needed.
#![cfg(all(unix, feature = "desktop"))]

use std::path::{Path, PathBuf};

use sextant_core::cloud::{CloudCli, CloudProblemKind, CloudProvider, CloudQuery};
use sextant_core::kubeconfig::{KubeconfigEnv, KubeconfigRegistry};
use sextant_core::{ClusterId, SourceKind};

const LEAK_MARKER: &str = "value-that-must-not-reach-a-cli";
const AKS_TOKEN: &str = "fake-aks-token-from-get-credentials";

const AWS: &str = r#"#!/bin/sh
env > "$FAKE_LOG/aws.env"
echo "$*" >> "$FAKE_LOG/aws.calls"
case "$*" in
  "--version") echo "aws-cli/2.15.30 Python/3.11.8 Linux/6.5.0 exe/x86_64.ubuntu.22 prompt/off" ;;
  "configure list-profiles") printf 'default\ndev\n' ;;
  "configure get region --profile=dev") echo "eu-west-1" ;;
  "configure get region --profile=default") exit 1 ;;
  "configure get sso_session --profile=dev") echo "my-sso" ;;
  "eks list-clusters --region=eu-west-1 --profile=dev --output=json") echo '{"clusters": ["prod"]}' ;;
  "eks list-clusters --region=us-east-1 --profile=dev --output=json")
    echo "Error when retrieving token from sso: Token has expired and refresh failed" >&2; exit 255 ;;
  "eks describe-cluster --region=eu-west-1 --profile=dev --output=json --name=prod")
    cat <<'JSON'
{"cluster": {"name": "prod", "arn": "arn:aws:eks:eu-west-1:111122223333:cluster/prod", "version": "1.29",
 "endpoint": "https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com", "certificateAuthority": {"data": "Y2EtZWtz"},
 "status": "ACTIVE", "platformVersion": "eks.5", "tags": {}}}
JSON
    ;;
  *) echo "fake aws: unexpected arguments: $*" >&2; exit 2 ;;
esac
"#;

const GCLOUD: &str = r#"#!/bin/sh
echo "$*" >> "$FAKE_LOG/gcloud.calls"
case "$*" in
  "version --format=json") echo '{"Google Cloud SDK": "470.0.0", "bq": "2.1.3", "core": "2024.03.29"}' ;;
  "projects list --format=json")
    echo '[{"lifecycleState": "ACTIVE", "name": "Shop", "projectId": "shop-prod", "projectNumber": "1"}, {"lifecycleState": "ACTIVE", "name": "Lab", "projectId": "lab", "projectNumber": "2"}]' ;;
  "config get-value project") echo "shop-prod" ;;
  "container clusters list --project=shop-prod --format=json")
    echo '[{"name": "web", "location": "europe-west1-b", "endpoint": "34.76.1.2", "masterAuth": {"clusterCaCertificate": "Y2EtZ2tl"}, "currentMasterVersion": "1.29.1-gke.1", "status": "RUNNING"}]' ;;
  *) echo "fake gcloud: unexpected arguments: $*" >&2; exit 2 ;;
esac
"#;

const AZ: &str = r#"#!/bin/sh
echo "$*" >> "$FAKE_LOG/az.calls"
case "$*" in
  "version --output=json") echo '{"azure-cli": "2.58.0", "azure-cli-core": "2.58.0", "extensions": {}}' ;;
  "account list --output=json")
    echo '[{"id": "sub-1", "name": "Production", "isDefault": true, "state": "Enabled", "user": {"name": "someone@example.com", "type": "user"}}]' ;;
  "aks list --subscription=sub-1 --output=json")
    echo '[{"name": "aks-prod", "resourceGroup": "rg-prod", "location": "westeurope", "fqdn": "aks-prod.hcp.westeurope.azmk8s.io", "currentKubernetesVersion": "1.28.5", "powerState": {"code": "Running"}}]' ;;
  "aks get-credentials --subscription=sub-1 --resource-group=rg-prod --name=aks-prod --file=- --only-show-errors")
    cat <<YAML
apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: Y2EtYWtz
    server: https://aks-prod.hcp.westeurope.azmk8s.io:443
  name: aks-prod
contexts:
- context: {cluster: aks-prod, user: clusterUser_rg-prod_aks-prod}
  name: aks-prod
users:
- name: clusterUser_rg-prod_aks-prod
  user:
    token: $AKS_TOKEN
YAML
    ;;
  *) echo "fake az: unexpected arguments: $*" >&2; exit 2 ;;
esac
"#;

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    /// Fake CLIs in `<tmp>/bin` (`kubelogin` is not there), call logs in `<tmp>/log`.
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let fake = Self { dir };
        std::fs::create_dir_all(fake.log()).unwrap();
        fake.script("aws", AWS);
        fake.script("gcloud", GCLOUD);
        fake.script("az", AZ);
        fake.script("gke-gcloud-auth-plugin", "#!/bin/sh\nexit 0\n");
        fake
    }

    fn bin(&self) -> PathBuf {
        self.dir.path().join("bin")
    }

    fn log(&self) -> PathBuf {
        self.dir.path().join("log")
    }

    fn script(&self, name: &str, text: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(self.bin()).unwrap();
        let path = self.bin().join(name);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// The app environment the CLIs inherit: the fake directory first in `PATH`, and variables that must be removed.
    fn cli(&self) -> CloudCli {
        CloudCli::default().with_env([
            (
                "PATH".to_owned(),
                format!("{}:/usr/bin:/bin", self.bin().display()),
            ),
            ("HOME".to_owned(), self.dir.path().display().to_string()),
            ("FAKE_LOG".to_owned(), self.log().display().to_string()),
            ("AKS_TOKEN".to_owned(), AKS_TOKEN.to_owned()),
            ("KUBECONFIG".to_owned(), format!("/{LEAK_MARKER}")),
            ("HELM_KUBETOKEN".to_owned(), LEAK_MARKER.to_owned()),
            ("HELM_NAMESPACE".to_owned(), LEAK_MARKER.to_owned()),
        ])
    }

    fn registry(&self, extra: Vec<sextant_core::KubeconfigSource>) -> KubeconfigRegistry {
        KubeconfigRegistry::new(extra, self.dir.path().join("data/kubeconfigs")).with_env(
            KubeconfigEnv {
                kubeconfig: None,
                home: Some(self.dir.path().join("home")),
            },
        )
    }
}

fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[tokio::test]
async fn clusters_are_found_with_the_fake_clis_and_imported_into_sextants_own_files() {
    let fake = Fake::new();
    let cli = fake.cli();

    // Discovery: versions and plugins.
    let status = cli.status().await;
    let of = |p: CloudProvider| status.iter().find(|s| s.provider == p).unwrap();
    assert!(of(CloudProvider::Aws).available);
    assert_eq!(of(CloudProvider::Aws).version.as_deref(), Some("2.15.30"));
    assert_eq!(of(CloudProvider::Aws).plugin, None);
    assert_eq!(of(CloudProvider::Gcp).version.as_deref(), Some("470.0.0"));
    assert!(of(CloudProvider::Gcp).plugin.as_ref().unwrap().available);
    assert_eq!(of(CloudProvider::Azure).version.as_deref(), Some("2.58.0"));
    let kubelogin = of(CloudProvider::Azure).plugin.clone().unwrap();
    assert!(!kubelogin.available);
    assert_eq!(kubelogin.install_command, "az aks install-cli");

    // AWS: profiles with regions; the search covers two regions, one of which is signed out.
    let aws = cli.accounts(CloudProvider::Aws).await;
    assert_eq!(aws.problem, None);
    let names: Vec<&str> = aws.accounts.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(names, ["default", "dev"]);
    assert!(aws.accounts[0].is_default);
    assert_eq!(aws.accounts[1].region.as_deref(), Some("eu-west-1"));
    assert!(aws.regions.iter().any(|r| r == "eu-west-1"));
    let eks = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Aws,
            account: "dev".into(),
            regions: vec!["eu-west-1".into(), "us-east-1".into()],
        })
        .await
        .unwrap();
    assert_eq!(eks.clusters.len(), 1);
    assert_eq!(
        eks.clusters[0].context,
        "arn:aws:eks:eu-west-1:111122223333:cluster/prod"
    );
    assert_eq!(eks.problems.len(), 1, "{:?}", eks.problems);
    assert_eq!(eks.problems[0].kind, CloudProblemKind::NotLoggedIn);
    assert_eq!(
        eks.problems[0].command.as_deref(),
        Some("aws sso login --profile dev")
    );

    // GCP: projects with the current one, clusters of a project.
    let gcp = cli.accounts(CloudProvider::Gcp).await;
    assert_eq!(gcp.accounts.len(), 2);
    assert!(
        gcp.accounts
            .iter()
            .find(|a| a.id == "shop-prod")
            .unwrap()
            .is_default
    );
    let gke = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Gcp,
            account: "shop-prod".into(),
            regions: vec![],
        })
        .await
        .unwrap();
    assert_eq!(gke.clusters.len(), 1);
    assert!(gke.problems.is_empty());

    // Azure: subscriptions and clusters; the endpoint and CA are read at import.
    let azure = cli.accounts(CloudProvider::Azure).await;
    assert_eq!(azure.accounts[0].id, "sub-1");
    let aks = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Azure,
            account: "sub-1".into(),
            regions: vec![],
        })
        .await
        .unwrap();
    assert_eq!(aks.clusters.len(), 1);

    // Import all three into the registry.
    let mut registry = fake.registry(Vec::new());
    let all: Vec<_> = [&eks.clusters, &gke.clusters, &aks.clusters]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let import = cli.prepare_import(&all).await.apply(&mut registry).unwrap();
    assert!(import.problems.is_empty(), "{:?}", import.problems);
    assert_eq!(import.sources.len(), 3);
    for source in &import.sources {
        assert_eq!(source.kind, SourceKind::Cloud);
        assert_eq!(mode(&source.path), 0o600, "{}", source.path.display());
    }
    let files: Vec<String> = import
        .sources
        .iter()
        .map(|s| s.path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files,
        ["cloud-aws.yaml", "cloud-gcp.yaml", "cloud-azure.yaml"]
    );
    let azure_file = std::fs::read_to_string(&import.sources[2].path).unwrap();
    assert!(
        !azure_file.contains(AKS_TOKEN),
        "credentials printed by az are not kept"
    );
    assert!(azure_file.contains("https://aks-prod.hcp.westeurope.azmk8s.io:443"));
    assert!(
        !fake.dir.path().join("home/.kube/config").exists(),
        "~/.kube/config is not written"
    );

    let mut contexts: Vec<String> = registry
        .clusters()
        .unwrap()
        .into_iter()
        .map(|c| c.context)
        .collect();
    contexts.sort();
    assert_eq!(
        contexts,
        [
            "aks_sub-1_rg-prod_aks-prod",
            "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
            "gke_shop-prod_europe-west1-b_web",
        ]
    );

    // The source reads back as a kubeconfig whose user signs in through the provider's plugin.
    let eks_id = ClusterId::for_context(
        &import.sources[0].path,
        "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
    );
    let config = registry.kubeconfig_for(&eks_id).unwrap();
    let exec = config.auth_infos[0]
        .auth_info
        .as_ref()
        .unwrap()
        .exec
        .as_ref()
        .unwrap();
    assert_eq!(exec.command.as_deref(), Some("aws"));
    assert!(
        exec.args
            .as_ref()
            .unwrap()
            .join(" ")
            .contains("--cluster-name prod --region eu-west-1 --profile dev")
    );

    // A second import does not add contexts; a restart reads the same sources from the settings.
    cli.prepare_import(&all).await.apply(&mut registry).unwrap();
    assert_eq!(registry.clusters().unwrap().len(), 3);
    assert_eq!(registry.added_sources().len(), 3);
    let restarted = fake.registry(registry.added_sources());
    assert_eq!(restarted.clusters().unwrap().len(), 3);

    // No CLI saw KUBECONFIG or HELM_* of the app.
    let env = std::fs::read_to_string(fake.log().join("aws.env")).unwrap();
    assert!(!env.contains(LEAK_MARKER), "{env}");
    assert!(
        !env.lines()
            .any(|l| l.starts_with("KUBECONFIG=") || l.starts_with("HELM_"))
    );
    // And nothing signed in on the user's behalf.
    let calls = std::fs::read_to_string(fake.log().join("aws.calls")).unwrap();
    assert!(
        !calls.contains("sso login") && !calls.contains("update-kubeconfig"),
        "{calls}"
    );
}

#[tokio::test]
async fn a_missing_cli_or_plugin_says_how_to_install_it_and_a_failed_sign_in_says_how_to_sign_in() {
    let fake = Fake::new();
    let empty = tempfile::tempdir().unwrap();
    let none = CloudCli::default().with_env([("PATH", empty.path().as_os_str())]);
    let status = none.status().await;
    assert!(status.iter().all(|s| !s.available && s.path.is_none()));
    let accounts = none.accounts(CloudProvider::Gcp).await;
    let problem = accounts.problem.unwrap();
    assert_eq!(problem.kind, CloudProblemKind::CliMissing);
    assert_eq!(
        problem.url.as_deref(),
        Some("https://cloud.google.com/sdk/docs/install")
    );

    // After a failed connection: the kubeconfig's plugin tells which CLI to sign in with.
    let cli = fake.cli();
    let mut registry = fake.registry(Vec::new());
    let gke = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Gcp,
            account: "shop-prod".into(),
            regions: vec![],
        })
        .await
        .unwrap();
    let aks = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Azure,
            account: "sub-1".into(),
            regions: vec![],
        })
        .await
        .unwrap();
    let eks = cli
        .find_clusters(&CloudQuery {
            provider: CloudProvider::Aws,
            account: "dev".into(),
            regions: vec!["eu-west-1".into()],
        })
        .await
        .unwrap();
    let all: Vec<_> = [gke.clusters, aks.clusters, eks.clusters].concat();
    cli.prepare_import(&all).await.apply(&mut registry).unwrap();
    let hint = |context_prefix: &str| {
        let cluster = registry
            .clusters()
            .unwrap()
            .into_iter()
            .find(|c| c.context.starts_with(context_prefix))
            .unwrap();
        registry.kubeconfig_for(&cluster.id).unwrap()
    };

    let gke_hint = cli.login_hint(&hint("gke_")).await.unwrap();
    assert_eq!(gke_hint.kind, CloudProblemKind::NotLoggedIn);
    assert_eq!(gke_hint.command.as_deref(), Some("gcloud auth login"));

    let aks_hint = cli.login_hint(&hint("aks_")).await.unwrap();
    assert_eq!(aks_hint.kind, CloudProblemKind::PluginMissing);
    assert_eq!(aks_hint.command.as_deref(), Some("az aks install-cli"));
    fake.script("kubelogin", "#!/bin/sh\nexit 0\n");
    let aks_hint = cli.login_hint(&hint("aks_")).await.unwrap();
    assert_eq!(aks_hint.command.as_deref(), Some("az login"));

    // `dev` is an SSO profile (`aws configure get sso_session` answers).
    let eks_hint = cli.login_hint(&hint("arn:")).await.unwrap();
    assert_eq!(
        eks_hint.command.as_deref(),
        Some("aws sso login --profile dev")
    );
}

#[tokio::test]
async fn a_cli_that_hangs_is_stopped_at_the_time_limit() {
    let fake = Fake::new();
    fake.script("az", "#!/bin/sh\nsleep 30\n");
    let cli = fake
        .cli()
        .with_timeout(std::time::Duration::from_millis(300));
    let started = std::time::Instant::now();
    let accounts = cli.accounts(CloudProvider::Azure).await;
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
    let problem = accounts.problem.unwrap();
    assert_eq!(problem.kind, CloudProblemKind::Failed);
    assert!(
        problem.message.contains("did not answer"),
        "{}",
        problem.message
    );
}
