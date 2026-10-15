//! Cloud clusters (EKS, GKE, AKS) through the user's own, already signed-in `aws`, `gcloud` and `az`.
//!
//! Sextant never signs in for the user and never asks a CLI to write a kubeconfig (`aws eks update-kubeconfig`,
//! `gcloud container clusters get-credentials` change `~/.kube/config`): it reads the cluster's endpoint and CA from
//! the CLI's JSON and writes its own kubeconfig with exec authentication (`aws eks get-token`,
//! `gke-gcloud-auth-plugin`, `kubelogin`), one file per provider in the data directory
//! ([`KubeconfigRegistry::add_cloud`]). No token passes through Sextant: the exec plugin produces it when the cluster
//! is connected.
//!
//! Every CLI runs through [`CloudCli`], which hands it the app's environment without `KUBECONFIG` and `HELM_*`, with
//! stdin closed, prompts and pagers off and a time limit. A failing call becomes a [`CloudProblem`]: what went wrong
//! in words, and the command that fixes it (`aws sso login --profile …`, `gcloud auth login`, `az login`, how to
//! install a plugin) for the user to run.

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures::StreamExt as _;
use kube::config::Kubeconfig;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::{KubeconfigRegistry, KubeconfigSource, kubeconfig_error};

/// How long one CLI call may take (an SSO prompt that cannot be answered, a hung network call).
pub const CLI_TIMEOUT: Duration = Duration::from_secs(60);

/// Calls of one CLI run at the same time when many clusters are described.
const PARALLEL_CALLS: usize = 8;

/// The Entra ID application of AKS (the same for every AKS cluster with Entra ID integration): `kubelogin` asks for a
/// token for it.
pub const AKS_SERVER_ID: &str = "6dae42f8-4368-4678-94ff-3960e28e3630";

/// The exec API version every generated kubeconfig uses (what `aws`, `gcloud` and `kubelogin` write themselves).
const EXEC_API_VERSION: &str = "client.authentication.k8s.io/v1beta1";

/// AWS regions offered for the EKS search (the commercial ones). Regions of the profiles are added to them.
pub const AWS_REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "af-south-1",
    "ap-east-1",
    "ap-south-1",
    "ap-south-2",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-7",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ca-central-1",
    "ca-west-1",
    "eu-central-1",
    "eu-central-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-south-1",
    "eu-south-2",
    "eu-north-1",
    "il-central-1",
    "me-south-1",
    "me-central-1",
    "mx-central-1",
    "sa-east-1",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CloudProvider {
    /// Amazon EKS through `aws`.
    Aws,
    /// Google GKE through `gcloud`.
    Gcp,
    /// Azure AKS through `az`.
    Azure,
}

impl CloudProvider {
    pub const ALL: [CloudProvider; 3] = [Self::Aws, Self::Gcp, Self::Azure];

    /// The CLI's command name.
    pub fn cli(self) -> &'static str {
        match self {
            Self::Aws => "aws",
            Self::Gcp => "gcloud",
            Self::Azure => "az",
        }
    }

    /// Sextant's own kubeconfig of the provider's clusters, in the data directory.
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Aws => "cloud-aws.yaml",
            Self::Gcp => "cloud-gcp.yaml",
            Self::Azure => "cloud-azure.yaml",
        }
    }

    /// Where to read how to install the CLI.
    pub fn install_url(self) -> &'static str {
        match self {
            Self::Aws => {
                "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
            }
            Self::Gcp => "https://cloud.google.com/sdk/docs/install",
            Self::Azure => "https://learn.microsoft.com/cli/azure/install-azure-cli",
        }
    }

    /// The exec credential plugin the provider's kubeconfig needs besides the CLI (`aws` is its own plugin).
    pub fn plugin(self) -> Option<Plugin> {
        match self {
            Self::Aws => None,
            Self::Gcp => Some(Plugin {
                name: "gke-gcloud-auth-plugin",
                install_command: "gcloud components install gke-gcloud-auth-plugin",
                install_url: "https://cloud.google.com/kubernetes-engine/docs/how-to/cluster-access-for-kubectl#install_plugin",
            }),
            Self::Azure => Some(Plugin {
                name: "kubelogin",
                install_command: "az aks install-cli",
                install_url: "https://azure.github.io/kubelogin/install.html",
            }),
        }
    }
}

/// An exec credential plugin and how to install it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plugin {
    pub name: &'static str,
    pub install_command: &'static str,
    pub install_url: &'static str,
}

/// File names a command may have on this platform: on Windows the CLIs are `.exe` or `.cmd` scripts.
fn binary_names(command: &str, windows: bool) -> Vec<String> {
    if windows {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| format!("{command}.{ext}"))
            .chain(std::iter::once(command.to_owned()))
            .collect()
    } else {
        vec![command.to_owned()]
    }
}

/// Whether a CLI is installed, its version, and whether its credential plugin is there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudCliStatus {
    pub provider: CloudProvider,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub install_url: String,
    /// `null` for AWS (the CLI is its own plugin).
    pub plugin: Option<CloudPluginStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudPluginStatus {
    pub name: String,
    pub available: bool,
    pub install_command: String,
    pub install_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CloudProblemKind {
    /// The CLI is not in `PATH` (`url`: how to install it).
    CliMissing,
    /// Not signed in, or the sign-in expired (`command`: how to sign in).
    NotLoggedIn,
    /// The credential plugin is not in `PATH` (`command`, `url`: how to install it).
    PluginMissing,
    /// Anything else the CLI refused (`message`).
    Failed,
}

/// Something the user has to fix, with the command that fixes it. Sextant only shows the command; the user runs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudProblem {
    pub provider: CloudProvider,
    pub kind: CloudProblemKind,
    /// What it concerns: a region, a profile, a cluster (`null`: the whole CLI).
    pub scope: Option<String>,
    /// The CLI's own words (its stderr, shortened), or Sextant's.
    pub message: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

/// An AWS profile, a GCP project or an Azure subscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudAccount {
    /// Profile name, project id or subscription id; `""` — AWS credentials from the environment (no profile).
    pub id: String,
    /// Project or subscription name; the profile name for AWS.
    pub name: String,
    /// The profile's region (AWS only).
    pub region: Option<String>,
    /// The CLI's current profile, project or subscription.
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudAccounts {
    pub provider: CloudProvider,
    pub accounts: Vec<CloudAccount>,
    /// Regions to search (AWS only; empty for the others).
    pub regions: Vec<String>,
    pub problem: Option<CloudProblem>,
}

/// What to search: an account and, for AWS, the regions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudQuery {
    pub provider: CloudProvider,
    pub account: String,
    #[serde(default)]
    pub regions: Vec<String>,
}

/// A cluster a CLI listed: what is shown and everything the kubeconfig is built from (no credentials).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudCluster {
    pub provider: CloudProvider,
    pub name: String,
    /// AWS profile (`""`: none), GCP project id, Azure subscription id.
    pub account: String,
    /// AWS region, GCP zone or region, Azure location.
    pub location: String,
    /// Azure resource group.
    pub resource_group: Option<String>,
    /// The cloud's id of the cluster (the EKS ARN).
    pub cloud_id: Option<String>,
    /// API server URL; `null` when it is read at import (AKS).
    pub endpoint: Option<String>,
    /// Base64 PEM of the cluster CA; `null` when it is read at import (AKS).
    pub certificate_authority: Option<String>,
    pub version: Option<String>,
    pub status: Option<String>,
    /// The kubeconfig context the import creates (the name `aws`/`gcloud` would give it).
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudSearch {
    pub clusters: Vec<CloudCluster>,
    pub problems: Vec<CloudProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CloudImport {
    /// The provider files the clusters went to.
    pub sources: Vec<KubeconfigSource>,
    /// Contexts written (added or replaced).
    pub contexts: Vec<String>,
    /// Clusters that could not be imported.
    pub problems: Vec<CloudProblem>,
}

/// The kubeconfigs an import writes, built before the registry is touched (reading them may call a CLI).
#[derive(Debug, Default)]
pub struct PreparedImport {
    configs: Vec<(CloudProvider, Kubeconfig)>,
    contexts: Vec<String>,
    problems: Vec<CloudProblem>,
}

impl PreparedImport {
    /// Merges the kubeconfigs into the providers' files and registers them as sources.
    pub fn apply(self, registry: &mut KubeconfigRegistry) -> CoreResult<CloudImport> {
        let mut sources: Vec<KubeconfigSource> = Vec::new();
        for provider in CloudProvider::ALL {
            let mut merged = Kubeconfig::default();
            for (_, config) in self.configs.iter().filter(|(p, _)| *p == provider) {
                merged.clusters.extend(config.clusters.iter().cloned());
                merged.auth_infos.extend(config.auth_infos.iter().cloned());
                merged.contexts.extend(config.contexts.iter().cloned());
            }
            if merged.contexts.is_empty() {
                continue;
            }
            let source = registry.add_cloud(provider.file_name(), &merged)?;
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
        Ok(CloudImport {
            sources,
            contexts: self.contexts,
            problems: self.problems,
        })
    }
}

/// What a CLI printed.
#[derive(Debug, Clone)]
struct CliOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

/// The cloud CLIs and the environment they run with. `CloudCli::default()` gives them the app's environment (minus
/// `KUBECONFIG`/`HELM_*`) and looks them up in its `PATH` on every call, so a CLI installed while the app runs is
/// found.
#[derive(Debug, Clone)]
pub struct CloudCli {
    env: Option<Vec<(OsString, OsString)>>,
    timeout: Duration,
}

impl Default for CloudCli {
    fn default() -> Self {
        Self {
            env: None,
            timeout: CLI_TIMEOUT,
        }
    }
}

/// Variables that point a child at another cluster or Helm setup: never inherited by a cloud CLI.
fn redirecting(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    let key = if cfg!(windows) {
        key.to_ascii_uppercase()
    } else {
        key.into_owned()
    };
    key == "KUBECONFIG" || key.starts_with("HELM_")
}

fn same_name(a: &OsStr, b: &str) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

impl CloudCli {
    /// Replaces the environment the CLIs inherit (the app passes its own, cleaned like a local terminal's; tests pass
    /// theirs). `KUBECONFIG`/`HELM_*` are still removed from it.
    pub fn with_env<K: Into<OsString>, V: Into<OsString>>(
        mut self,
        env: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        self.env = Some(env.into_iter().map(|(k, v)| (k.into(), v.into())).collect());
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The environment a CLI gets: the app's (or [`Self::with_env`]'s) without `KUBECONFIG` and `HELM_*`, with
    /// prompts and pagers off.
    pub fn child_env(&self) -> Vec<(OsString, OsString)> {
        let base: Vec<(OsString, OsString)> = match &self.env {
            Some(env) => env.clone(),
            None => std::env::vars_os().collect(),
        };
        let mut env: Vec<(OsString, OsString)> =
            base.into_iter().filter(|(k, _)| !redirecting(k)).collect();
        for (key, value) in [
            ("AWS_PAGER", ""),
            ("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"),
            ("AZURE_CORE_NO_COLOR", "1"),
        ] {
            env.retain(|(k, _)| !same_name(k, key));
            env.push((key.into(), value.into()));
        }
        env
    }

    fn var(&self, name: &str) -> Option<String> {
        self.child_env()
            .into_iter()
            .rev()
            .find(|(k, _)| same_name(k, name))
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .filter(|v| !v.is_empty())
    }

    /// `command` in the CLIs' `PATH`.
    pub fn which(&self, command: &str) -> Option<PathBuf> {
        let path = self
            .child_env()
            .into_iter()
            .rev()
            .find(|(k, _)| same_name(k, "PATH"))
            .map(|(_, v)| v)?;
        let names = binary_names(command, cfg!(windows));
        std::env::split_paths(&path)
            .filter(|dir| !dir.as_os_str().is_empty())
            .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
            .find(|candidate| is_executable(candidate))
    }

    fn cli_path(&self, provider: CloudProvider) -> Option<PathBuf> {
        self.which(provider.cli())
    }

    /// Runs `binary` with `args` (never through a shell). Fails only when it cannot start or runs out of time; a
    /// non-zero exit is in the output.
    async fn run(&self, binary: &Path, args: &[String]) -> CoreResult<CliOutput> {
        let mut cmd = Command::new(binary);
        cmd.env_clear()
            .envs(self.child_env())
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let timeout = self.timeout;
        let name = binary
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        tokio::task::spawn_blocking(move || run_with_timeout(cmd, timeout))
            .await
            .map_err(|e| CoreError::other(format!("{name} call failed: {e}")))?
            .map_err(|e| match e {
                RunError::Io(e) => CoreError::other(format!("cannot run {name}: {e}")),
                RunError::Timeout => CoreError::new(
                    ErrorCode::Timeout,
                    format!("{name} did not answer in {} s", timeout.as_secs()),
                ),
            })
    }

    /// Runs the provider's CLI; a missing CLI or a failed call becomes a problem about `scope`.
    async fn call(
        &self,
        provider: CloudProvider,
        scope: Option<&str>,
        args: &[String],
    ) -> Result<CliOutput, CloudProblem> {
        let Some(binary) = self.cli_path(provider) else {
            return Err(cli_missing(provider));
        };
        self.run(&binary, args)
            .await
            .map_err(|e| problem(provider, CloudProblemKind::Failed, scope, e.message))
    }

    /// Like [`Self::call`], and a non-zero exit is a problem too: "not signed in" with the sign-in command when
    /// the CLI says so.
    async fn call_ok(
        &self,
        provider: CloudProvider,
        scope: Option<&str>,
        account: &str,
        args: &[String],
    ) -> Result<String, CloudProblem> {
        let out = self.call(provider, scope, args).await?;
        if out.success {
            return Ok(out.stdout);
        }
        Err(self.failure(provider, scope, account, &out.stderr).await)
    }

    async fn failure(
        &self,
        provider: CloudProvider,
        scope: Option<&str>,
        account: &str,
        stderr: &str,
    ) -> CloudProblem {
        let message = short_message(stderr, provider);
        if !is_login_error(provider, stderr) {
            return problem(provider, CloudProblemKind::Failed, scope, message);
        }
        let command = match provider {
            CloudProvider::Aws => {
                let profile = Some(account).filter(|a| !a.is_empty());
                self.aws_login_command(profile, stderr).await
            }
            CloudProvider::Gcp => "gcloud auth login".to_owned(),
            CloudProvider::Azure => "az login".to_owned(),
        };
        CloudProblem {
            command: Some(command),
            ..problem(provider, CloudProblemKind::NotLoggedIn, scope, message)
        }
    }

    /// `aws sso login --profile P` for an SSO profile (or when the CLI talks about SSO), `aws configure --profile P`
    /// for a profile with access keys.
    async fn aws_login_command(&self, profile: Option<&str>, stderr: &str) -> String {
        let sso = stderr.to_ascii_lowercase().contains("sso") || {
            let mut uses_sso = false;
            for key in ["sso_session", "sso_start_url"] {
                let mut args = vec!["configure".to_owned(), "get".to_owned(), key.to_owned()];
                if let Some(profile) = profile {
                    args.push(format!("--profile={profile}"));
                }
                if let Ok(out) = self.call(CloudProvider::Aws, None, &args).await
                    && out.success
                    && !out.stdout.trim().is_empty()
                {
                    uses_sso = true;
                    break;
                }
            }
            uses_sso
        };
        let base = if sso {
            "aws sso login"
        } else {
            "aws configure"
        };
        match profile {
            Some(profile) => format!("{base} --profile {}", shell_word(profile)),
            None => base.to_owned(),
        }
    }

    /// Every CLI: installed or not, its version and its plugin.
    pub async fn status(&self) -> Vec<CloudCliStatus> {
        futures::future::join_all(CloudProvider::ALL.map(|p| self.status_of(p))).await
    }

    async fn status_of(&self, provider: CloudProvider) -> CloudCliStatus {
        let plugin = provider.plugin().map(|plugin| CloudPluginStatus {
            name: plugin.name.to_owned(),
            available: self.which(plugin.name).is_some(),
            install_command: plugin.install_command.to_owned(),
            install_url: plugin.install_url.to_owned(),
        });
        let path = self.cli_path(provider);
        let mut status = CloudCliStatus {
            provider,
            available: false,
            version: None,
            path: path.as_ref().map(|p| p.display().to_string()),
            install_url: provider.install_url().to_owned(),
            plugin,
        };
        let Some(path) = path else {
            return status;
        };
        let args: Vec<String> = match provider {
            CloudProvider::Aws => vec!["--version".into()],
            CloudProvider::Gcp => vec!["version".into(), "--format=json".into()],
            CloudProvider::Azure => vec!["version".into(), "--output=json".into()],
        };
        if let Ok(out) = self.run(&path, &args).await
            && out.success
        {
            status.available = true;
            status.version = match provider {
                CloudProvider::Aws => parse_aws_version(&format!("{}\n{}", out.stdout, out.stderr)),
                CloudProvider::Gcp => parse_gcloud_version(&out.stdout),
                CloudProvider::Azure => parse_az_version(&out.stdout),
            };
        }
        status
    }

    /// AWS profiles (with their regions and the regions to search), GCP projects or Azure subscriptions.
    pub async fn accounts(&self, provider: CloudProvider) -> CloudAccounts {
        let mut result = CloudAccounts {
            provider,
            accounts: Vec::new(),
            regions: Vec::new(),
            problem: None,
        };
        let listed = match provider {
            CloudProvider::Aws => self.aws_profiles().await.inspect(|accounts| {
                let mut regions: Vec<String> =
                    AWS_REGIONS.iter().map(|r| (*r).to_owned()).collect();
                for region in accounts.iter().filter_map(|a| a.region.clone()) {
                    if !regions.contains(&region) {
                        regions.push(region);
                    }
                }
                result.regions = regions;
            }),
            CloudProvider::Gcp => self.gcp_projects().await,
            CloudProvider::Azure => self.azure_subscriptions().await,
        };
        match listed {
            Ok(accounts) => result.accounts = accounts,
            Err(problem) => result.problem = Some(problem),
        }
        result
    }

    async fn aws_profiles(&self) -> Result<Vec<CloudAccount>, CloudProblem> {
        let aws = CloudProvider::Aws;
        let out = self
            .call_ok(aws, None, "", &args(&["configure", "list-profiles"]))
            .await?;
        let profiles = parse_aws_profiles(&out);
        let current = self
            .var("AWS_PROFILE")
            .or_else(|| self.var("AWS_DEFAULT_PROFILE"))
            .unwrap_or_else(|| "default".to_owned());
        if profiles.is_empty() {
            // No profile: credentials from the environment (or none — the search then says so).
            let region = self
                .var("AWS_REGION")
                .or_else(|| self.var("AWS_DEFAULT_REGION"));
            return Ok(vec![CloudAccount {
                id: String::new(),
                name: String::new(),
                region,
                is_default: true,
            }]);
        }
        let regions = futures::stream::iter(profiles.iter().cloned())
            .map(|profile| async move {
                let args = vec![
                    "configure".to_owned(),
                    "get".to_owned(),
                    "region".to_owned(),
                    format!("--profile={profile}"),
                ];
                let region = match self.call(aws, None, &args).await {
                    Ok(out) if out.success => {
                        Some(out.stdout.trim().to_owned()).filter(|r| !r.is_empty())
                    }
                    _ => None,
                };
                (profile, region)
            })
            .buffered(PARALLEL_CALLS)
            .collect::<Vec<_>>()
            .await;
        Ok(regions
            .into_iter()
            .map(|(profile, region)| CloudAccount {
                is_default: profile == current,
                id: profile.clone(),
                name: profile,
                region,
            })
            .collect())
    }

    async fn gcp_projects(&self) -> Result<Vec<CloudAccount>, CloudProblem> {
        let gcp = CloudProvider::Gcp;
        let list_args = args(&["projects", "list", "--format=json"]);
        let current_args = args(&["config", "get-value", "project"]);
        let (list, current) = futures::join!(
            self.call_ok(gcp, None, "", &list_args),
            self.call(gcp, None, &current_args)
        );
        let current = match current {
            Ok(out) if out.success => parse_gcloud_value(&out.stdout),
            _ => None,
        };
        let mut projects = parse_gcp_projects(&list?).map_err(|e| invalid_output(gcp, e))?;
        for project in &mut projects {
            project.is_default = current.as_deref() == Some(project.id.as_str());
        }
        Ok(projects)
    }

    async fn azure_subscriptions(&self) -> Result<Vec<CloudAccount>, CloudProblem> {
        let azure = CloudProvider::Azure;
        let out = self
            .call(azure, None, &args(&["account", "list", "--output=json"]))
            .await?;
        if !out.success {
            return Err(self.failure(azure, None, "", &out.stderr).await);
        }
        let subscriptions = parse_az_accounts(&out.stdout).map_err(|e| invalid_output(azure, e))?;
        // Signed out, `az account list` prints `[]` and only warns ("Please run 'az login' …").
        if subscriptions.is_empty() && is_login_error(azure, &out.stderr) {
            return Err(self.failure(azure, None, "", &out.stderr).await);
        }
        Ok(subscriptions)
    }

    /// The clusters of an account (in each region for AWS).
    pub async fn find_clusters(&self, query: &CloudQuery) -> CoreResult<CloudSearch> {
        plain_arg(&query.account, "account")?;
        let mut search = match query.provider {
            CloudProvider::Aws => self.find_eks(query).await?,
            CloudProvider::Gcp => {
                let args = vec![
                    "container".to_owned(),
                    "clusters".to_owned(),
                    "list".to_owned(),
                    format!("--project={}", query.account),
                    "--format=json".to_owned(),
                ];
                self.find_one_call(query, &args, |text| {
                    parse_gke_clusters(text, &query.account)
                })
                .await
            }
            CloudProvider::Azure => {
                let args = vec![
                    "aks".to_owned(),
                    "list".to_owned(),
                    format!("--subscription={}", query.account),
                    "--output=json".to_owned(),
                ];
                self.find_one_call(query, &args, |text| {
                    parse_aks_clusters(text, &query.account)
                })
                .await
            }
        };
        search
            .clusters
            .sort_by(|a, b| (&a.location, &a.name).cmp(&(&b.location, &b.name)));
        Ok(search)
    }

    async fn find_one_call(
        &self,
        query: &CloudQuery,
        args: &[String],
        parse: impl Fn(&str) -> Result<Vec<CloudCluster>, String>,
    ) -> CloudSearch {
        let scope = Some(query.account.as_str()).filter(|a| !a.is_empty());
        let result = self
            .call_ok(query.provider, scope, &query.account, args)
            .await
            .and_then(|text| parse(&text).map_err(|e| invalid_output(query.provider, e)));
        match result {
            Ok(clusters) => CloudSearch {
                clusters,
                problems: Vec::new(),
            },
            Err(problem) => CloudSearch {
                clusters: Vec::new(),
                problems: vec![problem],
            },
        }
    }

    async fn find_eks(&self, query: &CloudQuery) -> CoreResult<CloudSearch> {
        if query.regions.is_empty() {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                "choose at least one region",
            ));
        }
        for region in &query.regions {
            plain_arg(region, "region")?;
        }
        let profile = query.account.as_str();
        let listed = futures::stream::iter(query.regions.iter().cloned())
            .map(|region| async move {
                let args = aws_args(&["eks", "list-clusters"], &region, profile);
                let names = self
                    .call_ok(CloudProvider::Aws, Some(&region), profile, &args)
                    .await
                    .and_then(|text| {
                        parse_eks_list(&text).map_err(|e| invalid_output(CloudProvider::Aws, e))
                    });
                (region, names)
            })
            .buffered(PARALLEL_CALLS)
            .collect::<Vec<_>>()
            .await;

        let mut problems = Vec::new();
        let mut wanted = Vec::new();
        for (region, names) in listed {
            match names {
                Ok(names) => wanted.extend(names.into_iter().map(|n| (region.clone(), n))),
                Err(problem) => problems.push(problem),
            }
        }
        let described = futures::stream::iter(wanted)
            .map(|(region, name)| async move {
                let mut args = aws_args(&["eks", "describe-cluster"], &region, profile);
                args.push(format!("--name={name}"));
                let scope = format!("{region}/{name}");
                self.call_ok(CloudProvider::Aws, Some(&scope), profile, &args)
                    .await
                    .and_then(|text| {
                        parse_eks_cluster(&text, profile, &region)
                            .map_err(|e| invalid_output(CloudProvider::Aws, e))
                    })
            })
            .buffered(PARALLEL_CALLS)
            .collect::<Vec<_>>()
            .await;
        let mut clusters = Vec::new();
        for result in described {
            match result {
                Ok(cluster) => clusters.push(cluster),
                Err(problem) => problems.push(problem),
            }
        }
        Ok(CloudSearch {
            clusters,
            problems: dedup_login(problems),
        })
    }

    /// Builds the kubeconfigs of `clusters`. AKS clusters get their endpoint and CA from
    /// `az aks get-credentials --file -` (only the cluster part is kept; the credentials it prints are dropped).
    pub async fn prepare_import(&self, clusters: &[CloudCluster]) -> PreparedImport {
        let built = futures::stream::iter(clusters.iter().cloned())
            .map(|cluster| async move {
                let result = match self.complete(cluster.clone()).await {
                    Ok(complete) => kubeconfig_for(&complete).map_err(|e| {
                        problem(
                            cluster.provider,
                            CloudProblemKind::Failed,
                            Some(&cluster.name),
                            e.message,
                        )
                    }),
                    Err(problem) => Err(problem),
                };
                (cluster.provider, result)
            })
            .buffered(PARALLEL_CALLS)
            .collect::<Vec<_>>()
            .await;
        let mut prepared = PreparedImport::default();
        for (provider, result) in built {
            match result {
                Ok(config) => {
                    prepared
                        .contexts
                        .extend(config.contexts.iter().map(|c| c.name.clone()));
                    prepared.configs.push((provider, config));
                }
                Err(problem) => prepared.problems.push(problem),
            }
        }
        prepared.problems = dedup_login(prepared.problems);
        prepared
    }

    /// `cluster` with its endpoint and CA (read from `az` for AKS).
    async fn complete(&self, mut cluster: CloudCluster) -> Result<CloudCluster, CloudProblem> {
        if cluster.endpoint.is_some() && cluster.certificate_authority.is_some() {
            return Ok(cluster);
        }
        let failed = |message: String| {
            problem(
                cluster.provider,
                CloudProblemKind::Failed,
                Some(&cluster.name),
                message,
            )
        };
        if cluster.provider != CloudProvider::Azure {
            return Err(failed(
                "the cluster has no endpoint or CA; search again".into(),
            ));
        }
        let group = cluster.resource_group.clone().unwrap_or_default();
        for (value, what) in [
            (&cluster.name, "cluster name"),
            (&cluster.account, "subscription"),
            (&group, "resource group"),
        ] {
            plain_arg(value, what).map_err(|e| failed(e.message))?;
        }
        let args = vec![
            "aks".to_owned(),
            "get-credentials".to_owned(),
            format!("--subscription={}", cluster.account),
            format!("--resource-group={group}"),
            format!("--name={}", cluster.name),
            "--file=-".to_owned(),
            "--only-show-errors".to_owned(),
        ];
        let text = self
            .call_ok(
                CloudProvider::Azure,
                Some(&cluster.name),
                &cluster.account,
                &args,
            )
            .await?;
        let (server, ca) = cluster_part(&text).map_err(failed)?;
        // Without Entra ID (local accounts) az prints a token or certificate user: the `kubelogin --login azurecli`
        // user Sextant writes could never sign in, and `az login` would not help.
        if !signs_in_with_kubelogin(&text) {
            return Err(failed(format!(
                "{} does not use Microsoft Entra ID sign-in (az prints no kubelogin user for it), so Sextant cannot \
                 sign in to it through az. Enable Entra ID integration on the cluster, or add a kubeconfig file for it.",
                cluster.name
            )));
        }
        cluster.endpoint = Some(server);
        cluster.certificate_authority = Some(ca);
        Ok(cluster)
    }

    /// What to do when a cluster from `config` cannot sign in: the sign-in command of its cloud CLI, or how to
    /// install the CLI or plugin that is missing. `None` when the kubeconfig does not use a cloud's exec plugin.
    pub async fn login_hint(&self, config: &Kubeconfig) -> Option<CloudProblem> {
        let exec = config
            .auth_infos
            .first()
            .and_then(|u| u.auth_info.as_ref())
            .and_then(|a| a.exec.as_ref())?;
        let command = exec.command.as_deref()?;
        let args = exec.args.clone().unwrap_or_default();
        let env_var = |name: &str| {
            exec.env.iter().flatten().find_map(|entry| {
                (entry.get("name").map(String::as_str) == Some(name))
                    .then(|| entry.get("value").cloned())
                    .flatten()
            })
        };
        let scope = config.contexts.first().map(|c| c.name.clone());
        let scope = scope.as_deref();
        let not_logged_in = |provider, command: String| CloudProblem {
            command: Some(command),
            ..problem(
                provider,
                CloudProblemKind::NotLoggedIn,
                scope,
                String::new(),
            )
        };
        match command_name(command).as_str() {
            "aws" => {
                let aws = CloudProvider::Aws;
                if self.cli_path(aws).is_none() {
                    return Some(cli_missing(aws));
                }
                let profile = flag_value(&args, "--profile").or_else(|| env_var("AWS_PROFILE"));
                let login = self.aws_login_command(profile.as_deref(), "").await;
                Some(not_logged_in(aws, login))
            }
            "gke-gcloud-auth-plugin" => {
                let gcp = CloudProvider::Gcp;
                if self.which("gke-gcloud-auth-plugin").is_none() {
                    return Some(plugin_missing(gcp));
                }
                if self.cli_path(gcp).is_none() {
                    return Some(cli_missing(gcp));
                }
                Some(not_logged_in(gcp, "gcloud auth login".into()))
            }
            "kubelogin" => {
                let azure = CloudProvider::Azure;
                if self.which("kubelogin").is_none() {
                    return Some(plugin_missing(azure));
                }
                let mode = flag_value(&args, "--login").or_else(|| flag_value(&args, "-l"));
                if mode.as_deref() != Some("azurecli") {
                    return None;
                }
                if self.cli_path(azure).is_none() {
                    return Some(cli_missing(azure));
                }
                Some(not_logged_in(azure, "az login".into()))
            }
            _ => None,
        }
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|a| (*a).to_owned()).collect()
}

/// `aws <subcommand> --region=R [--profile=P] --output=json`.
fn aws_args(subcommand: &[&str], region: &str, profile: &str) -> Vec<String> {
    let mut list = args(subcommand);
    list.push(format!("--region={region}"));
    if !profile.is_empty() {
        list.push(format!("--profile={profile}"));
    }
    list.push("--output=json".to_owned());
    list
}

/// The file name of a command without its directory and Windows extension.
fn command_name(command: &str) -> String {
    let name = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = name.to_ascii_lowercase();
    for ext in [".exe", ".cmd", ".bat"] {
        if let Some(stem) = lower.strip_suffix(ext) {
            return stem.to_owned();
        }
    }
    lower
}

/// The value of `--flag value` or `--flag=value` in `args`.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let prefix = format!("{flag}=");
    args.iter().enumerate().find_map(|(i, arg)| {
        if arg == flag {
            args.get(i + 1).cloned()
        } else {
            arg.strip_prefix(&prefix).map(str::to_owned)
        }
    })
}

/// `value` as one word of a command the user runs in the local terminal (Windows PowerShell 5.1 on Windows, a POSIX
/// shell elsewhere): as is when it has only letters, digits and `._-@/:`, otherwise in single quotes, so `$(…)`,
/// backquotes and `"` stay text.
///
/// Windows PowerShell 5.1 builds a native program's command line without escaping `"` (and wraps a word with
/// whitespace in `"…"` without doubling its trailing backslashes), so the program's C runtime would drop or misread
/// them. In PowerShell mode the word is therefore written for the C runtime inside the single quotes: `"` as `\"`
/// with the backslashes right before it doubled, and trailing backslashes doubled when the value has whitespace.
/// PowerShell 7.3+ escapes by itself and would pass such a value with extra backslashes.
fn shell_word(value: &str) -> String {
    shell_word_for(value, cfg!(windows))
}

fn shell_word_for(value: &str, powershell: bool) -> String {
    // A leading `@` is splatting in PowerShell.
    let splat = powershell && value.starts_with('@');
    if !value.is_empty()
        && !splat
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-@/:".contains(c))
    {
        return value.to_owned();
    }
    let mut word = String::with_capacity(value.len() + 2);
    word.push('\'');
    // Backslashes right before the current character (PowerShell mode only needs them).
    let mut backslashes = 0;
    for c in value.chars() {
        match c {
            // POSIX: close the quotes, an escaped quote, open them again.
            '\'' if !powershell => word.push_str("'\\''"),
            // PowerShell ends a single-quoted string at any of these; doubled, it is one character.
            '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' if powershell => {
                word.push(c);
                word.push(c);
            }
            // For the native program's C runtime: the backslashes before it doubled, then `\"`.
            '"' if powershell => {
                word.extend(std::iter::repeat_n('\\', backslashes + 1));
                word.push('"');
            }
            _ => word.push(c),
        }
        backslashes = if c == '\\' { backslashes + 1 } else { 0 };
    }
    // PowerShell 5.1 wraps a word with whitespace in `"…"`: trailing backslashes would escape its closing quote.
    if powershell && value.chars().any(char::is_whitespace) {
        word.extend(std::iter::repeat_n('\\', backslashes));
    }
    word.push('\'');
    word
}

/// A value that goes to a CLI as `--flag=value` and into a kubeconfig's exec arguments: no leading `-` (it would be
/// read as a flag) and no control characters.
fn plain_arg(value: &str, what: &str) -> CoreResult<()> {
    if value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            format!("not a valid {what}: {value:?}"),
        ));
    }
    Ok(())
}

fn problem(
    provider: CloudProvider,
    kind: CloudProblemKind,
    scope: Option<&str>,
    message: String,
) -> CloudProblem {
    CloudProblem {
        provider,
        kind,
        scope: scope.map(str::to_owned),
        message,
        command: None,
        url: None,
    }
}

fn cli_missing(provider: CloudProvider) -> CloudProblem {
    CloudProblem {
        url: Some(provider.install_url().to_owned()),
        ..problem(
            provider,
            CloudProblemKind::CliMissing,
            None,
            format!("{} was not found in PATH", provider.cli()),
        )
    }
}

fn plugin_missing(provider: CloudProvider) -> CloudProblem {
    let plugin = provider.plugin().expect("a provider with a plugin");
    CloudProblem {
        command: Some(plugin.install_command.to_owned()),
        url: Some(plugin.install_url.to_owned()),
        ..problem(
            provider,
            CloudProblemKind::PluginMissing,
            None,
            format!("{} was not found in PATH", plugin.name),
        )
    }
}

fn invalid_output(provider: CloudProvider, error: String) -> CloudProblem {
    problem(
        provider,
        CloudProblemKind::Failed,
        None,
        format!("unexpected output of {}: {error}", provider.cli()),
    )
}

/// One "not signed in" per sign-in command (every region of a signed-out profile fails the same way).
fn dedup_login(problems: Vec<CloudProblem>) -> Vec<CloudProblem> {
    let mut out: Vec<CloudProblem> = Vec::new();
    for p in problems {
        let repeated = p.kind == CloudProblemKind::NotLoggedIn
            && out
                .iter()
                .any(|q| q.kind == p.kind && q.provider == p.provider && q.command == p.command);
        if repeated {
            continue;
        }
        let mut p = p;
        if p.kind == CloudProblemKind::NotLoggedIn {
            p.scope = None;
        }
        out.push(p);
    }
    out
}

/// The CLI's error text, shortened for a message (the last lines matter; tracebacks are long).
fn short_message(stderr: &str, provider: CloudProvider) -> String {
    const MAX: usize = 600;
    let text = stderr.trim();
    if text.is_empty() {
        return format!("{} failed", provider.cli());
    }
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX {
        return text.to_owned();
    }
    let tail: String = chars[chars.len() - MAX..].iter().collect();
    format!("…{tail}")
}

/// Whether the CLI says the user is not signed in or the sign-in expired.
pub fn is_login_error(provider: CloudProvider, stderr: &str) -> bool {
    let text = stderr.to_ascii_lowercase();
    let patterns: &[&str] = match provider {
        CloudProvider::Aws => &[
            "unable to locate credentials",
            "expiredtoken",
            "token has expired",
            "token is expired",
            "sso session",
            "error loading sso token",
            "aws sso login",
            "security token included in the request is invalid",
            "security token included in the request is expired",
            "invalidclienttokenid",
            "unrecognizedclientexception",
            "unable to load sso token",
        ],
        CloudProvider::Gcp => &[
            "gcloud auth login",
            "you do not currently have an active account",
            "reauthentication",
            "refreshing your current auth tokens",
            "invalid_grant",
            "credentials were not found",
        ],
        CloudProvider::Azure => &[
            "az login",
            "aadsts",
            "refresh token has expired",
            "interactive authentication is needed",
            "no subscription found",
        ],
    };
    patterns.iter().any(|p| text.contains(p))
}

/// `aws --version`: "aws-cli/2.15.30 Python/3.11.8 Linux/6.5.0 …" → "2.15.30".
pub fn parse_aws_version(text: &str) -> Option<String> {
    text.split_whitespace()
        .find_map(|word| word.strip_prefix("aws-cli/"))
        .map(str::to_owned)
        .filter(|v| !v.is_empty())
}

/// `gcloud version --format=json`: `{"Google Cloud SDK": "470.0.0", …}`.
pub fn parse_gcloud_version(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value.get("Google Cloud SDK")?.as_str().map(str::to_owned)
}

/// `az version --output=json`: `{"azure-cli": "2.58.0", …}`.
pub fn parse_az_version(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value.get("azure-cli")?.as_str().map(str::to_owned)
}

/// `aws configure list-profiles`: one profile per line.
pub fn parse_aws_profiles(text: &str) -> Vec<String> {
    let mut profiles: Vec<String> = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !profiles.iter().any(|p| p == line) {
            profiles.push(line.to_owned());
        }
    }
    profiles
}

/// `gcloud config get-value project`: the value, or nothing when unset (`(unset)` goes to stderr).
fn parse_gcloud_value(text: &str) -> Option<String> {
    Some(text.trim().to_owned()).filter(|v| !v.is_empty() && v != "(unset)")
}

fn json_of(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

fn str_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|s| !s.is_empty())
}

/// `aws eks list-clusters --output json`: `{"clusters": ["a", "b"]}`.
pub fn parse_eks_list(text: &str) -> Result<Vec<String>, String> {
    let value = json_of(text)?;
    let list = value
        .get("clusters")
        .and_then(Value::as_array)
        .ok_or("no \"clusters\" list")?;
    Ok(list
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect())
}

/// `aws eks describe-cluster --output json`: `{"cluster": {"name", "arn", "endpoint", "certificateAuthority":
/// {"data"}, "version", "status"}}`. The context is the cluster's ARN, as `aws eks update-kubeconfig` names it.
pub fn parse_eks_cluster(text: &str, profile: &str, region: &str) -> Result<CloudCluster, String> {
    let value = json_of(text)?;
    let cluster = value.get("cluster").ok_or("no \"cluster\" object")?;
    let name = str_at(cluster, "/name").ok_or("the cluster has no name")?;
    let arn = str_at(cluster, "/arn");
    let context = match &arn {
        Some(arn) => arn.clone(),
        None => format!("eks_{region}_{name}"),
    };
    Ok(CloudCluster {
        provider: CloudProvider::Aws,
        account: profile.to_owned(),
        location: region.to_owned(),
        resource_group: None,
        cloud_id: arn,
        endpoint: str_at(cluster, "/endpoint"),
        certificate_authority: str_at(cluster, "/certificateAuthority/data"),
        version: str_at(cluster, "/version"),
        status: str_at(cluster, "/status"),
        context,
        name,
    })
}

/// `gcloud projects list --format=json`: `[{"projectId", "name", "lifecycleState", …}]`; only active projects.
pub fn parse_gcp_projects(text: &str) -> Result<Vec<CloudAccount>, String> {
    let value = json_of(text)?;
    let list = value.as_array().ok_or("not a list")?;
    Ok(list
        .iter()
        .filter(|p| str_at(p, "/lifecycleState").is_none_or(|state| state == "ACTIVE"))
        .filter_map(|p| {
            let id = str_at(p, "/projectId")?;
            Some(CloudAccount {
                name: str_at(p, "/name").unwrap_or_else(|| id.clone()),
                id,
                region: None,
                is_default: false,
            })
        })
        .collect())
}

/// `gcloud container clusters list --format=json`: `[{"name", "location", "endpoint", "masterAuth":
/// {"clusterCaCertificate"}, "currentMasterVersion", "status"}]`. The context is `gke_<project>_<location>_<name>`,
/// as `gcloud container clusters get-credentials` names it.
pub fn parse_gke_clusters(text: &str, project: &str) -> Result<Vec<CloudCluster>, String> {
    let value = json_of(text)?;
    let list = value.as_array().ok_or("not a list")?;
    Ok(list
        .iter()
        .filter_map(|c| {
            let name = str_at(c, "/name")?;
            let location = str_at(c, "/location")
                .or_else(|| str_at(c, "/zone"))
                .unwrap_or_default();
            Some(CloudCluster {
                provider: CloudProvider::Gcp,
                account: project.to_owned(),
                context: format!("gke_{project}_{location}_{name}"),
                location,
                resource_group: None,
                cloud_id: str_at(c, "/selfLink"),
                endpoint: str_at(c, "/endpoint").map(|host| {
                    if host.starts_with("https://") {
                        host
                    } else {
                        format!("https://{host}")
                    }
                }),
                certificate_authority: str_at(c, "/masterAuth/clusterCaCertificate"),
                version: str_at(c, "/currentMasterVersion"),
                status: str_at(c, "/status"),
                name,
            })
        })
        .collect())
}

/// `az account list --output=json`: `[{"id", "name", "isDefault", "state"}]`; only enabled subscriptions.
pub fn parse_az_accounts(text: &str) -> Result<Vec<CloudAccount>, String> {
    let value = json_of(text)?;
    let list = value.as_array().ok_or("not a list")?;
    Ok(list
        .iter()
        .filter(|a| str_at(a, "/state").is_none_or(|state| state == "Enabled"))
        .filter_map(|a| {
            let id = str_at(a, "/id")?;
            Some(CloudAccount {
                name: str_at(a, "/name").unwrap_or_else(|| id.clone()),
                id,
                region: None,
                is_default: a.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect())
}

/// `az aks list --output=json`: `[{"name", "resourceGroup", "location", "fqdn", "privateFqdn", "kubernetesVersion",
/// "powerState": {"code"}, "provisioningState", "id"}]`. The endpoint and CA are read at import. The context is
/// `aks_<subscription>_<resource group>_<name>` (unique across subscriptions and groups).
pub fn parse_aks_clusters(text: &str, subscription: &str) -> Result<Vec<CloudCluster>, String> {
    let value = json_of(text)?;
    let list = value.as_array().ok_or("not a list")?;
    Ok(list
        .iter()
        .filter_map(|c| {
            let name = str_at(c, "/name")?;
            let group = str_at(c, "/resourceGroup").unwrap_or_default();
            Some(CloudCluster {
                provider: CloudProvider::Azure,
                account: subscription.to_owned(),
                context: format!("aks_{subscription}_{group}_{name}"),
                location: str_at(c, "/location").unwrap_or_default(),
                resource_group: Some(group),
                cloud_id: str_at(c, "/id"),
                endpoint: None,
                certificate_authority: None,
                version: str_at(c, "/currentKubernetesVersion")
                    .or_else(|| str_at(c, "/kubernetesVersion")),
                status: str_at(c, "/powerState/code").or_else(|| str_at(c, "/provisioningState")),
                name,
            })
        })
        .collect())
}

/// The server and CA of the first cluster of a kubeconfig printed by a CLI. Users and contexts (credentials) are
/// ignored; errors never quote the text.
fn cluster_part(text: &str) -> Result<(String, String), String> {
    let config = Kubeconfig::from_yaml(text).map_err(|e| kubeconfig_error(e).message)?;
    let cluster = config
        .clusters
        .first()
        .and_then(|c| c.cluster.as_ref())
        .ok_or("the CLI printed a kubeconfig without a cluster")?;
    let server = cluster
        .server
        .clone()
        .ok_or("the CLI printed a cluster without a server")?;
    let ca = cluster
        .certificate_authority_data
        .clone()
        .ok_or("the CLI printed a cluster without a CA")?;
    Ok((server, ca))
}

/// Whether the first user of a kubeconfig printed by `az aks get-credentials` signs in through `kubelogin` (Microsoft
/// Entra ID). Credentials are not read.
fn signs_in_with_kubelogin(text: &str) -> bool {
    Kubeconfig::from_yaml(text)
        .ok()
        .and_then(|config| config.auth_infos.into_iter().next())
        .and_then(|user| user.auth_info)
        .and_then(|auth| auth.exec)
        .and_then(|exec| exec.command)
        .is_some_and(|command| command_name(&command) == "kubelogin")
}

/// The kubeconfig (one context, cluster and user, all named [`CloudCluster::context`]) of a cluster, with exec
/// authentication through the provider's CLI or plugin. Recomputes the context from the cluster's fields.
pub fn kubeconfig_for(cluster: &CloudCluster) -> CoreResult<Kubeconfig> {
    let invalid = |message: String| CoreError::new(ErrorCode::Invalid, message);
    for (value, what) in [
        (&cluster.name, "cluster name"),
        (&cluster.account, "account"),
        (&cluster.location, "location"),
    ] {
        plain_arg(value, what)?;
    }
    if cluster.name.is_empty() {
        return Err(invalid("the cluster has no name".into()));
    }
    let endpoint = cluster
        .endpoint
        .clone()
        .filter(|e| e.starts_with("https://"))
        .ok_or_else(|| {
            invalid(format!(
                "{}: the endpoint is not an https URL",
                cluster.name
            ))
        })?;
    let ca = cluster
        .certificate_authority
        .clone()
        .filter(|ca| {
            base64::engine::general_purpose::STANDARD
                .decode(ca.trim())
                .is_ok_and(|bytes| !bytes.is_empty())
        })
        .ok_or_else(|| invalid(format!("{}: the CA is not base64", cluster.name)))?;

    let (context, exec) = match cluster.provider {
        CloudProvider::Aws => {
            let context = cluster
                .cloud_id
                .clone()
                .filter(|arn| arn.starts_with("arn:aws") && arn.contains(":eks:"))
                .unwrap_or_else(|| format!("eks_{}_{}", cluster.location, cluster.name));
            let mut args = vec![
                "eks".to_owned(),
                "get-token".to_owned(),
                "--cluster-name".to_owned(),
                cluster.name.clone(),
                "--region".to_owned(),
                cluster.location.clone(),
            ];
            if !cluster.account.is_empty() {
                args.extend(["--profile".to_owned(), cluster.account.clone()]);
            }
            args.extend(["--output".to_owned(), "json".to_owned()]);
            let exec = json!({
                "apiVersion": EXEC_API_VERSION,
                "command": "aws",
                "args": args,
                "installHint": format!("Install the AWS CLI: {}", CloudProvider::Aws.install_url()),
            });
            (context, exec)
        }
        CloudProvider::Gcp => {
            let plugin = CloudProvider::Gcp.plugin().expect("gcp plugin");
            let context = format!(
                "gke_{}_{}_{}",
                cluster.account, cluster.location, cluster.name
            );
            let exec = json!({
                "apiVersion": EXEC_API_VERSION,
                "command": plugin.name,
                "provideClusterInfo": true,
                "installHint": format!("Install {}: {} ({})", plugin.name, plugin.install_command, plugin.install_url),
            });
            (context, exec)
        }
        CloudProvider::Azure => {
            let plugin = CloudProvider::Azure.plugin().expect("azure plugin");
            let group = cluster.resource_group.clone().unwrap_or_default();
            plain_arg(&group, "resource group")?;
            let context = format!("aks_{}_{}_{}", cluster.account, group, cluster.name);
            let exec = json!({
                "apiVersion": EXEC_API_VERSION,
                "command": plugin.name,
                "args": ["get-token", "--login", "azurecli", "--server-id", AKS_SERVER_ID],
                "installHint": format!("Install {}: {} ({})", plugin.name, plugin.install_command, plugin.install_url),
            });
            (context, exec)
        }
    };
    let config = json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{
            "name": context,
            "cluster": { "server": endpoint, "certificate-authority-data": ca.trim() },
        }],
        "users": [{ "name": context, "user": { "exec": exec } }],
        "contexts": [{ "name": context, "context": { "cluster": context, "user": context } }],
        "current-context": context,
    });
    serde_json::from_value(config)
        .map_err(|e| CoreError::other(format!("cannot build the kubeconfig: {e}")))
}

fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

enum RunError {
    Io(std::io::Error),
    Timeout,
}

/// Runs `cmd` to the end or until `timeout`, then kills it together with every process it started (`az` on Linux is
/// a shell wrapper around python, `az.cmd` and `gcloud` on Windows start python): see [`ProcessTree`]. The output
/// pipes are read on their own threads; after a kill they are left behind (a process that escaped may still hold them
/// open) instead of being waited for.
fn run_with_timeout(mut cmd: Command, timeout: Duration) -> Result<CliOutput, RunError> {
    ProcessTree::prepare(&mut cmd);
    let mut child = cmd.spawn().map_err(RunError::Io)?;
    let tree = ProcessTree::of(&child);
    let reader = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = reader(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = reader(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        let waited = match child.try_wait() {
            Ok(waited) => waited,
            Err(e) => {
                tree.kill(&mut child);
                let _ = child.wait();
                return Err(RunError::Io(e));
            }
        };
        match waited {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                tree.kill(&mut child);
                let _ = child.wait();
                return Err(RunError::Timeout);
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    tree.close();
    let text = |handle: std::thread::JoinHandle<Vec<u8>>| {
        String::from_utf8_lossy(&handle.join().unwrap_or_default()).into_owned()
    };
    Ok(CliOutput {
        success: status.success(),
        stdout: text(stdout),
        stderr: text(stderr),
    })
}

/// A CLI and every process it starts, so that a timed-out call stops all of them.
///
/// Unix: the CLI leads a process group of its own (`process_group(0)`, its PID is the group ID) and the whole group
/// gets `SIGKILL`. Only a process that leaves the group on purpose (`setsid`, a daemon) escapes. A CLI that exits in
/// time is not followed further: what it left running is not touched.
///
/// Windows: the CLI runs without a console window (`CREATE_NO_WINDOW`) in a job object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; everything it starts belongs to the job, which is terminated at the time
/// limit and closed once the call ends (what the CLI left running ends then too, and on a Sextant crash). The CLI is
/// put into the job right after it starts, so a process it starts before that escapes; when the job cannot be made,
/// only the CLI is killed.
struct ProcessTree {
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl ProcessTree {
    #[cfg(unix)]
    fn prepare(cmd: &mut Command) {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    #[cfg(windows)]
    fn prepare(cmd: &mut Command) {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(any(unix, windows)))]
    fn prepare(_cmd: &mut Command) {}

    #[cfg(windows)]
    fn of(child: &std::process::Child) -> Self {
        Self {
            job: job::Job::with(child),
        }
    }

    #[cfg(not(windows))]
    fn of(_child: &std::process::Child) -> Self {
        Self {}
    }

    /// The CLI has exited. On Windows this closes the job: what the CLI left running ends with it and cannot hold the
    /// output pipes open.
    fn close(self) {
        #[cfg(windows)]
        drop(self.job);
    }

    /// Kills the CLI and what it started; the caller still waits for the CLI.
    fn kill(&self, child: &mut std::process::Child) {
        #[cfg(unix)]
        {
            // The CLI is not reaped yet, so its PID (the group's ID) cannot belong to anything else.
            if let Some(group) = i32::try_from(child.id())
                .ok()
                .and_then(rustix::process::Pid::from_raw)
            {
                let _ = rustix::process::kill_process_group(group, rustix::process::Signal::KILL);
            }
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.terminate();
            }
        }
        let _ = child.kill();
    }
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };

    /// An unnamed job object that kills its processes when its (only) handle is closed.
    pub(super) struct Job(HANDLE);

    impl Job {
        /// A new job with `child` in it; `None` when Windows refuses (then only the CLI itself can be killed).
        pub(super) fn with(child: &std::process::Child) -> Option<Self> {
            // SAFETY: no security attributes and no name are valid arguments; the handle is owned by `Job` from here
            // on and closed in its `Drop`.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return None;
            }
            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `job.0` is a live job handle; the pointer and size describe `limits`, which outlives the call.
            let limited = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&limits).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            } != 0;
            // SAFETY: both handles are live: the job's is owned here, the child's by `child`, which is not waited
            // for yet.
            let assigned =
                limited && unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) } != 0;
            assigned.then_some(job)
        }

        pub(super) fn terminate(&self) {
            // SAFETY: `self.0` is a live job handle owned by `self`.
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: the handle is owned by `self` and closed only here.
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_read_from_each_cli() {
        assert_eq!(
            parse_aws_version(
                "aws-cli/2.15.30 Python/3.11.8 Linux/6.5.0-1016-azure exe/x86_64.ubuntu.22 prompt/off\n"
            ),
            Some("2.15.30".into())
        );
        assert_eq!(parse_aws_version("command not found"), None);
        assert_eq!(
            parse_gcloud_version(
                r#"{"Google Cloud SDK": "470.0.0", "bq": "2.1.3", "core": "2024.03.29", "gsutil": "5.27"}"#
            ),
            Some("470.0.0".into())
        );
        assert_eq!(
            parse_az_version(
                r#"{"azure-cli": "2.58.0", "azure-cli-core": "2.58.0", "azure-cli-telemetry": "1.1.0", "extensions": {}}"#
            ),
            Some("2.58.0".into())
        );
        assert_eq!(parse_az_version("not json"), None);
    }

    #[test]
    fn aws_profiles_are_one_per_line() {
        assert_eq!(
            parse_aws_profiles("default\ndev\n\nprod-admin\ndev\n"),
            ["default", "dev", "prod-admin"]
        );
        assert!(parse_aws_profiles("").is_empty());
    }

    #[test]
    fn eks_list_and_describe_give_name_region_endpoint_ca_and_arn_context() {
        assert_eq!(
            parse_eks_list(r#"{"clusters": ["prod", "staging"]}"#).unwrap(),
            ["prod", "staging"]
        );
        assert!(parse_eks_list(r#"{"nextToken": null}"#).is_err());

        let describe = r#"{
            "cluster": {
                "name": "prod",
                "arn": "arn:aws:eks:eu-west-1:111122223333:cluster/prod",
                "createdAt": "2024-01-10T10:00:00.000000+00:00",
                "version": "1.29",
                "endpoint": "https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com",
                "roleArn": "arn:aws:iam::111122223333:role/eks",
                "resourcesVpcConfig": {"subnetIds": [], "endpointPublicAccess": true},
                "certificateAuthority": {"data": "LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg=="},
                "status": "ACTIVE",
                "platformVersion": "eks.5",
                "tags": {}
            }
        }"#;
        let cluster = parse_eks_cluster(describe, "dev", "eu-west-1").unwrap();
        assert_eq!(cluster.name, "prod");
        assert_eq!(cluster.account, "dev");
        assert_eq!(cluster.location, "eu-west-1");
        assert_eq!(
            cluster.context,
            "arn:aws:eks:eu-west-1:111122223333:cluster/prod"
        );
        assert_eq!(
            cluster.endpoint.as_deref(),
            Some("https://ABCDEF.gr7.eu-west-1.eks.amazonaws.com")
        );
        assert_eq!(
            cluster.certificate_authority.as_deref(),
            Some("LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCg==")
        );
        assert_eq!(cluster.version.as_deref(), Some("1.29"));
        assert_eq!(cluster.status.as_deref(), Some("ACTIVE"));
    }

    #[test]
    fn gcp_projects_and_gke_clusters_are_read_from_gcloud_json() {
        let projects = parse_gcp_projects(
            r#"[
                {"createTime": "2023-01-01T00:00:00.000Z", "lifecycleState": "ACTIVE", "name": "Shop", "projectId": "shop-prod", "projectNumber": "123456789012"},
                {"lifecycleState": "DELETE_REQUESTED", "name": "Old", "projectId": "old-one", "projectNumber": "2"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            projects,
            [CloudAccount {
                id: "shop-prod".into(),
                name: "Shop".into(),
                region: None,
                is_default: false
            }]
        );

        let clusters = parse_gke_clusters(
            r#"[{
                "name": "web",
                "location": "europe-west1-b",
                "zone": "europe-west1-b",
                "endpoint": "34.76.1.2",
                "masterAuth": {"clusterCaCertificate": "LS0tLS1CRUdJTg=="},
                "currentMasterVersion": "1.29.1-gke.1589000",
                "status": "RUNNING",
                "selfLink": "https://container.googleapis.com/v1/projects/shop-prod/zones/europe-west1-b/clusters/web"
            }]"#,
            "shop-prod",
        )
        .unwrap();
        assert_eq!(clusters.len(), 1);
        let web = &clusters[0];
        assert_eq!(web.context, "gke_shop-prod_europe-west1-b_web");
        assert_eq!(web.endpoint.as_deref(), Some("https://34.76.1.2"));
        assert_eq!(
            web.certificate_authority.as_deref(),
            Some("LS0tLS1CRUdJTg==")
        );
        assert_eq!(web.version.as_deref(), Some("1.29.1-gke.1589000"));
        assert_eq!(web.location, "europe-west1-b");
    }

    #[test]
    fn azure_subscriptions_and_aks_clusters_are_read_from_az_json() {
        let accounts = parse_az_accounts(
            r#"[
                {"cloudName": "AzureCloud", "homeTenantId": "t", "id": "11111111-2222-3333-4444-555555555555", "isDefault": true, "managedByTenants": [], "name": "Production", "state": "Enabled", "tenantId": "t", "user": {"name": "someone@example.com", "type": "user"}},
                {"id": "99999999-2222-3333-4444-555555555555", "isDefault": false, "name": "Gone", "state": "Disabled"}
            ]"#,
        )
        .unwrap();
        assert_eq!(
            accounts,
            [CloudAccount {
                id: "11111111-2222-3333-4444-555555555555".into(),
                name: "Production".into(),
                region: None,
                is_default: true
            }]
        );

        let clusters = parse_aks_clusters(
            r#"[{
                "name": "aks-prod",
                "resourceGroup": "rg-prod",
                "location": "westeurope",
                "fqdn": "aks-prod-dns-abc.hcp.westeurope.azmk8s.io",
                "privateFqdn": null,
                "kubernetesVersion": "1.28",
                "currentKubernetesVersion": "1.28.5",
                "provisioningState": "Succeeded",
                "powerState": {"code": "Running"},
                "aadProfile": {"managed": true, "enableAzureRbac": true},
                "id": "/subscriptions/11111111-2222-3333-4444-555555555555/resourcegroups/rg-prod/providers/Microsoft.ContainerService/managedClusters/aks-prod"
            }]"#,
            "11111111-2222-3333-4444-555555555555",
        )
        .unwrap();
        let aks = &clusters[0];
        assert_eq!(aks.name, "aks-prod");
        assert_eq!(aks.resource_group.as_deref(), Some("rg-prod"));
        assert_eq!(aks.location, "westeurope");
        assert_eq!(aks.version.as_deref(), Some("1.28.5"));
        assert_eq!(aks.status.as_deref(), Some("Running"));
        assert_eq!(
            aks.context,
            "aks_11111111-2222-3333-4444-555555555555_rg-prod_aks-prod"
        );
        assert_eq!(aks.endpoint, None, "read at import");
    }

    #[test]
    fn signed_out_messages_of_each_cli_are_recognized() {
        let aws = CloudProvider::Aws;
        assert!(is_login_error(
            aws,
            "Unable to locate credentials. You can configure credentials by running \"aws configure\"."
        ));
        assert!(is_login_error(
            aws,
            "Error when retrieving token from sso: Token has expired and refresh failed"
        ));
        assert!(is_login_error(
            aws,
            "An error occurred (ExpiredTokenException) when calling the ListClusters operation: The security token included in the request is expired"
        ));
        assert!(!is_login_error(
            aws,
            "An error occurred (AccessDeniedException) when calling the ListClusters operation: User is not authorized"
        ));
        let gcp = CloudProvider::Gcp;
        assert!(is_login_error(
            gcp,
            "ERROR: (gcloud.projects.list) You do not currently have an active account selected.\nPlease run:\n\n  $ gcloud auth login"
        ));
        assert!(is_login_error(
            gcp,
            "ERROR: (gcloud.container.clusters.list) There was a problem refreshing your current auth tokens: Reauthentication failed."
        ));
        assert!(!is_login_error(
            gcp,
            "ERROR: (gcloud.container.clusters.list) ResponseError: code=403, message=Kubernetes Engine API has not been used in project 1"
        ));
        let azure = CloudProvider::Azure;
        assert!(is_login_error(
            azure,
            "WARNING: Please run 'az login' to access your accounts."
        ));
        assert!(is_login_error(
            azure,
            "ERROR: AADSTS700082: The refresh token has expired due to inactivity."
        ));
        assert!(!is_login_error(
            azure,
            "ERROR: (ResourceGroupNotFound) Resource group 'x' could not be found."
        ));
    }

    fn eks(name: &str) -> CloudCluster {
        CloudCluster {
            provider: CloudProvider::Aws,
            name: name.into(),
            account: "dev".into(),
            location: "eu-west-1".into(),
            resource_group: None,
            cloud_id: Some(format!("arn:aws:eks:eu-west-1:111122223333:cluster/{name}")),
            endpoint: Some("https://abc.eks.amazonaws.com".into()),
            certificate_authority: Some("Y2E=".into()),
            version: None,
            status: None,
            context: String::new(),
        }
    }

    fn exec_of(config: &Kubeconfig) -> &kube::config::ExecConfig {
        config.auth_infos[0]
            .auth_info
            .as_ref()
            .unwrap()
            .exec
            .as_ref()
            .unwrap()
    }

    #[test]
    fn eks_kubeconfig_signs_in_with_aws_eks_get_token() {
        let config = kubeconfig_for(&eks("prod")).unwrap();
        let context = "arn:aws:eks:eu-west-1:111122223333:cluster/prod";
        assert_eq!(config.contexts[0].name, context);
        assert_eq!(config.current_context.as_deref(), Some(context));
        let cluster = config.clusters[0].cluster.as_ref().unwrap();
        assert_eq!(
            cluster.server.as_deref(),
            Some("https://abc.eks.amazonaws.com")
        );
        assert_eq!(cluster.certificate_authority_data.as_deref(), Some("Y2E="));
        let exec = exec_of(&config);
        assert_eq!(
            exec.api_version.as_deref(),
            Some("client.authentication.k8s.io/v1beta1")
        );
        assert_eq!(exec.command.as_deref(), Some("aws"));
        assert_eq!(
            exec.args.as_deref().unwrap(),
            [
                "eks",
                "get-token",
                "--cluster-name",
                "prod",
                "--region",
                "eu-west-1",
                "--profile",
                "dev",
                "--output",
                "json"
            ]
        );

        let no_profile = kubeconfig_for(&CloudCluster {
            account: String::new(),
            ..eks("prod")
        })
        .unwrap();
        assert!(
            !exec_of(&no_profile)
                .args
                .as_ref()
                .unwrap()
                .contains(&"--profile".to_owned())
        );
    }

    #[test]
    fn gke_and_aks_kubeconfigs_use_their_plugins() {
        let gke = CloudCluster {
            provider: CloudProvider::Gcp,
            account: "shop-prod".into(),
            location: "europe-west1-b".into(),
            cloud_id: None,
            ..eks("web")
        };
        let config = kubeconfig_for(&gke).unwrap();
        assert_eq!(config.contexts[0].name, "gke_shop-prod_europe-west1-b_web");
        let exec = exec_of(&config);
        assert_eq!(exec.command.as_deref(), Some("gke-gcloud-auth-plugin"));
        assert!(exec.provide_cluster_info);

        let aks = CloudCluster {
            provider: CloudProvider::Azure,
            account: "sub-1".into(),
            location: "westeurope".into(),
            resource_group: Some("rg".into()),
            cloud_id: None,
            ..eks("aks-prod")
        };
        let config = kubeconfig_for(&aks).unwrap();
        assert_eq!(config.contexts[0].name, "aks_sub-1_rg_aks-prod");
        let exec = exec_of(&config);
        assert_eq!(exec.command.as_deref(), Some("kubelogin"));
        assert_eq!(
            exec.args.as_deref().unwrap(),
            [
                "get-token",
                "--login",
                "azurecli",
                "--server-id",
                AKS_SERVER_ID
            ]
        );
    }

    #[test]
    fn a_kubeconfig_is_refused_for_values_that_would_turn_into_flags_or_bad_endpoints() {
        let flag = CloudCluster {
            name: "--exec=evil".into(),
            ..eks("x")
        };
        assert_eq!(kubeconfig_for(&flag).unwrap_err().code, ErrorCode::Invalid);
        let http = CloudCluster {
            endpoint: Some("http://plain".into()),
            ..eks("x")
        };
        assert_eq!(kubeconfig_for(&http).unwrap_err().code, ErrorCode::Invalid);
        let no_ca = CloudCluster {
            certificate_authority: Some("%%%".into()),
            ..eks("x")
        };
        assert_eq!(kubeconfig_for(&no_ca).unwrap_err().code, ErrorCode::Invalid);
    }

    #[test]
    fn the_cluster_part_of_a_printed_kubeconfig_drops_its_credentials() {
        let printed = r#"apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: Y2E=
    server: https://aks-prod-dns-abc.hcp.westeurope.azmk8s.io:443
  name: aks-prod
contexts:
- context:
    cluster: aks-prod
    user: clusterUser_rg-prod_aks-prod
  name: aks-prod
current-context: aks-prod
users:
- name: clusterUser_rg-prod_aks-prod
  user:
    token: not-a-real-token
"#;
        let (server, ca) = cluster_part(printed).unwrap();
        assert_eq!(
            server,
            "https://aks-prod-dns-abc.hcp.westeurope.azmk8s.io:443"
        );
        assert_eq!(ca, "Y2E=");
        let err = cluster_part("users: [token: not-a-real-token").unwrap_err();
        assert!(!err.contains("not-a-real-token"), "{err}");
    }

    #[test]
    fn the_cli_environment_has_no_kubeconfig_or_helm_variables() {
        let cli = CloudCli::default().with_env([
            ("PATH", "/bin"),
            ("KUBECONFIG", "/tmp/other"),
            ("HELM_KUBETOKEN", "x"),
            ("HELM_NAMESPACE", "y"),
            ("AWS_PROFILE", "dev"),
        ]);
        let env = cli.child_env();
        let keys: Vec<String> = env
            .iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert!(keys.contains(&"PATH".to_owned()) && keys.contains(&"AWS_PROFILE".to_owned()));
        assert!(
            !keys
                .iter()
                .any(|k| k == "KUBECONFIG" || k.starts_with("HELM_")),
            "{keys:?}"
        );
        assert!(keys.contains(&"CLOUDSDK_CORE_DISABLE_PROMPTS".to_owned()));
    }

    #[test]
    fn login_problems_of_many_regions_become_one() {
        let login = |scope: &str| CloudProblem {
            command: Some("aws sso login --profile dev".into()),
            ..problem(
                CloudProvider::Aws,
                CloudProblemKind::NotLoggedIn,
                Some(scope),
                "expired".into(),
            )
        };
        let other = problem(
            CloudProvider::Aws,
            CloudProblemKind::Failed,
            Some("ap-east-1"),
            "opt-in".into(),
        );
        let out = dedup_login(vec![login("eu-west-1"), login("us-east-1"), other.clone()]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].scope, None);
        assert_eq!(out[1], other);
    }

    #[test]
    fn command_names_and_flags_are_read_from_exec_configs() {
        assert_eq!(command_name("/usr/local/bin/aws"), "aws");
        assert_eq!(command_name(r"C:\Tools\kubelogin.exe"), "kubelogin");
        let args = args(&["eks", "get-token", "--profile", "dev", "--region=eu-west-1"]);
        assert_eq!(flag_value(&args, "--profile").as_deref(), Some("dev"));
        assert_eq!(flag_value(&args, "--region").as_deref(), Some("eu-west-1"));
        assert_eq!(flag_value(&args, "--missing"), None);
    }

    #[test]
    fn values_in_a_shown_command_stay_one_word_and_run_nothing() {
        for powershell in [false, true] {
            assert_eq!(shell_word_for("dev", powershell), "dev");
            assert_eq!(
                shell_word_for("team@corp/x:1.2_a-b", powershell),
                "team@corp/x:1.2_a-b"
            );
            assert_eq!(shell_word_for("", powershell), "''");
            assert_eq!(shell_word_for("my profile", powershell), "'my profile'");
            assert_eq!(shell_word_for("$(x)", powershell), "'$(x)'");
            assert_eq!(shell_word_for("`x`", powershell), "'`x`'");
            assert_eq!(shell_word_for(r"C:\dir\", powershell), r"'C:\dir\'");
        }
        // POSIX shells: a quote ends the quoted part, an escaped one, a new part.
        assert_eq!(shell_word_for("a'b", false), "'a'\\''b'");
        assert_eq!(shell_word_for("a\"b", false), "'a\"b'");
        // Windows PowerShell 5.1 hands `"` to a native program as is, which the program's C runtime then drops: it
        // goes as `\"`, with the backslashes right before it doubled; other backslashes stay single.
        assert_eq!(shell_word_for("a\"b", true), r#"'a\"b'"#);
        assert_eq!(shell_word_for("a \"b\" c", true), r#"'a \"b\" c'"#);
        assert_eq!(shell_word_for(r#"a\"b"#, true), r#"'a\\\"b'"#);
        assert_eq!(shell_word_for(r#"a\\"b\c"#, true), r#"'a\\\\\"b\c'"#);
        // PowerShell 5.1 wraps a value with whitespace in `"…"`: its trailing backslashes are doubled.
        assert_eq!(shell_word_for(r"C:\my dir\", true), r"'C:\my dir\\'");
        assert_eq!(shell_word_for(r"C:\my dir\", false), r"'C:\my dir\'");
        // PowerShell: a quote inside single quotes is doubled (typographic ones end the string too).
        assert_eq!(shell_word_for("a'b", true), "'a''b'");
        assert_eq!(shell_word_for("@x", true), "'@x'");
        assert_eq!(shell_word_for("@x", false), "@x");
        assert_eq!(shell_word_for("a\u{2019}b", true), "'a\u{2019}\u{2019}b'");
        assert_eq!(shell_word("my profile"), "'my profile'");
    }
}
