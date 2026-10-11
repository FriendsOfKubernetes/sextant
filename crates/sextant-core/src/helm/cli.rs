//! Calls to the `helm` binary. Every call that reaches a cluster passes `--kubeconfig <temp> --kube-context <ctx>`,
//! where the temporary kubeconfig (mode 0600) holds only that context and is deleted when the call is over;
//! credentials never appear on the command line. User values go through a temporary file (`-f`), not `--set`.
//! Positional arguments follow `--`, so a name starting with `-` cannot turn into a flag.
//!
//! A non-zero exit gives `CoreError { Other, <helm's stderr> }`; a missing binary gives `HelmMissing`.
//! Works with Helm 3 and Helm 4 (same flags, same JSON output, same release storage).

use std::ffi::{OsStr, OsString};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// Where to install Helm, shown when it is missing.
pub const INSTALL_URL: &str = "https://helm.sh/docs/intro/install/";

/// The `helm` binary and the environment it runs with. `HelmCli::default()` looks `helm` up in `PATH` on every
/// call, so installing Helm while the app runs is picked up.
#[derive(Debug, Clone, Default)]
pub struct HelmCli {
    binary: Option<PathBuf>,
    env: Vec<(OsString, OsString)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChartHit {
    /// `repo/chart`
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

/// `helm search repo -o json` rows (snake_case fields).
#[derive(Deserialize)]
struct RawHit {
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    app_version: String,
    #[serde(default)]
    description: String,
}

/// File names of the binary on this platform.
fn binary_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["helm.exe", "helm"]
    } else {
        &["helm"]
    }
}

/// Finds `helm` in a `PATH`-style list of directories.
pub fn find_in_path(path: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    std::env::split_paths(path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .flat_map(|dir| binary_names().iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable(candidate))
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

/// Environment variables `helm` reads that override `--kubeconfig` / `--kube-context` (another API server, token,
/// impersonated user, CA, TLS checks), the namespace or the release storage driver. Inherited from the app they
/// would send a call to another cluster or leak a token, so they are removed from every call unless set explicitly
/// with [`HelmCli::with_env`]. Every other `HELM_KUBE*` variable (present or future) is removed as well.
pub const REDIRECTING_ENV: &[&str] = &[
    "HELM_KUBEAPISERVER",
    "HELM_KUBETOKEN",
    "HELM_KUBEASUSER",
    "HELM_KUBEASGROUPS",
    "HELM_KUBECAFILE",
    "HELM_KUBEINSECURE_SKIP_TLS_VERIFY",
    "HELM_KUBETLS_SERVER_NAME",
    "HELM_KUBECONTEXT",
    "HELM_NAMESPACE",
    "HELM_DRIVER",
    "KUBECONFIG",
];

fn redirects_helm(key: &OsStr) -> bool {
    let key = key.to_string_lossy();
    key.starts_with("HELM_KUBE") || REDIRECTING_ENV.contains(&key.as_ref())
}

fn helm_missing() -> CoreError {
    CoreError::new(
        ErrorCode::HelmMissing,
        format!("helm was not found in PATH; install it: {INSTALL_URL}"),
    )
}

/// A temporary kubeconfig with only the cluster's context, and that context's name. The file is deleted when this
/// value is dropped.
pub struct KubeTarget {
    pub kubeconfig: tempfile::TempPath,
    pub context: String,
}

/// Writes the temporary kubeconfig of `cluster` (mode 0600) for a `helm` call.
pub fn kube_target(mgr: &ClusterManager, cluster: &ClusterId) -> CoreResult<KubeTarget> {
    let registry = mgr.registry();
    let registry = registry
        .read()
        .map_err(|_| CoreError::other("the kubeconfig registry is unavailable"))?;
    let context = registry
        .clusters()?
        .into_iter()
        .find(|c| &c.id == cluster)
        .map(|c| c.context)
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("unknown cluster {}", cluster.as_str()),
            )
        })?;
    let kubeconfig = registry.write_temp_kubeconfig(cluster)?;
    Ok(KubeTarget {
        kubeconfig,
        context,
    })
}

/// Arguments of one `helm` call: subcommand and flags first, then `--` and the positional arguments.
struct Args {
    flags: Vec<OsString>,
    positional: Vec<OsString>,
}

impl Args {
    fn new(subcommand: &[&str]) -> Self {
        Self {
            flags: subcommand.iter().map(OsString::from).collect(),
            positional: Vec::new(),
        }
    }

    fn flag(mut self, name: &str, value: impl AsRef<OsStr>) -> Self {
        self.flags.push(name.into());
        self.flags.push(value.as_ref().to_owned());
        self
    }

    fn switch(mut self, name: &str) -> Self {
        self.flags.push(name.into());
        self
    }

    fn arg(mut self, value: impl AsRef<OsStr>) -> Self {
        self.positional.push(value.as_ref().to_owned());
        self
    }

    fn kube(self, kc: &Path, ctx: &str, ns: &str) -> Self {
        self.flag("--namespace", ns)
            .flag("--kubeconfig", kc)
            .flag("--kube-context", ctx)
    }

    fn into_vec(self) -> Vec<OsString> {
        let mut all = self.flags;
        if !self.positional.is_empty() {
            all.push("--".into());
            all.extend(self.positional);
        }
        all
    }
}

/// User values in a private temporary file (`-f`); `None` when the text is empty.
fn values_file(values_yaml: &str) -> CoreResult<Option<tempfile::NamedTempFile>> {
    if values_yaml.trim().is_empty() {
        return Ok(None);
    }
    use std::io::Write;
    let mut file = tempfile::Builder::new()
        .prefix("sextant-values-")
        .suffix(".yaml")
        .tempfile()?;
    file.write_all(values_yaml.as_bytes())?;
    file.as_file().sync_all()?;
    Ok(Some(file))
}

impl HelmCli {
    /// Always runs this binary instead of looking `helm` up in `PATH`.
    pub fn with_binary(mut self, path: impl Into<PathBuf>) -> Self {
        self.binary = Some(path.into());
        self
    }

    /// Sets an environment variable for every call (e.g. `HELM_CONFIG_HOME` in tests).
    pub fn with_env(mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.env.push((key.into(), value.into()));
        self
    }

    /// Whether `helm` is in `PATH`, and its version.
    pub fn detect() -> HelmStatus {
        Self::default().status()
    }

    /// Like [`HelmCli::detect`], for this binary and environment.
    pub fn status(&self) -> HelmStatus {
        let Some(path) = self.binary() else {
            return HelmStatus {
                available: false,
                version: None,
                path: None,
            };
        };
        // `--template` works in Helm 3 and 4 and prints just "v3.x.y" / "v4.x.y".
        let output = self
            .command(&path)
            .args(["version", "--template", "{{.Version}}"])
            .output();
        match output {
            Ok(out) if out.status.success() => HelmStatus {
                available: true,
                version: Some(String::from_utf8_lossy(&out.stdout).trim().to_owned())
                    .filter(|v| !v.is_empty()),
                path: Some(path.display().to_string()),
            },
            _ => HelmStatus {
                available: false,
                version: None,
                path: Some(path.display().to_string()),
            },
        }
    }

    fn binary(&self) -> Option<PathBuf> {
        match &self.binary {
            Some(path) => Some(path.clone()).filter(|p| is_executable(p)),
            None => {
                let path = self
                    .env
                    .iter()
                    .rev()
                    .find(|(k, _)| k == "PATH")
                    .map(|(_, v)| v.clone())
                    .or_else(|| std::env::var_os("PATH"));
                find_in_path(path.as_deref())
            }
        }
    }

    /// The child gets the app's environment without the variables that would redirect `helm` (see
    /// [`REDIRECTING_ENV`]), plus what was set with [`HelmCli::with_env`].
    fn command(&self, binary: &Path) -> Command {
        let mut cmd = Command::new(binary);
        for (key, _) in std::env::vars_os() {
            if redirects_helm(&key) {
                cmd.env_remove(&key);
            }
        }
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        cmd
    }

    /// Runs `helm` with `args`; stdout on success, stderr as the error otherwise. `keep` (temporary files the
    /// call reads) lives until the process has exited.
    async fn run<K: Send + 'static>(&self, args: Args, keep: K) -> CoreResult<String> {
        let binary = self.binary().ok_or_else(helm_missing)?;
        let mut cmd = self.command(&binary);
        cmd.args(args.into_vec());
        let output = tokio::task::spawn_blocking(move || {
            let output = cmd.output();
            drop(keep);
            output
        })
        .await
        .map_err(|e| CoreError::other(format!("helm call failed: {e}")))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => helm_missing(),
            _ => CoreError::other(format!("cannot run helm: {e}")),
        })?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let message = if stderr.is_empty() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if stdout.is_empty() {
                format!("helm exited with {}", output.status)
            } else {
                stdout
            }
        } else {
            stderr
        };
        Err(CoreError::other(message))
    }

    /// `helm upgrade` with the given values (they replace the previous user values: `--reset-values`).
    pub async fn upgrade(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        chart_ref: &str,
        values_yaml: &str,
    ) -> CoreResult<()> {
        self.upgrade_with_version(kc, ctx, ns, release, chart_ref, None, values_yaml)
            .await
    }

    /// [`HelmCli::upgrade`] pinned to a chart version (`--version`).
    #[allow(clippy::too_many_arguments)]
    pub async fn upgrade_with_version(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        chart_ref: &str,
        version: Option<&str>,
        values_yaml: &str,
    ) -> CoreResult<()> {
        let values = values_file(values_yaml)?;
        let mut args = Args::new(&["upgrade"])
            .kube(kc, ctx, ns)
            .switch("--reset-values");
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            args = args.flag("--version", v);
        }
        if let Some(file) = &values {
            args = args.flag("--values", file.path());
        }
        self.run(args.arg(release).arg(chart_ref), values)
            .await
            .map(drop)
    }

    pub async fn rollback(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        revision: i32,
    ) -> CoreResult<()> {
        let args = Args::new(&["rollback"])
            .kube(kc, ctx, ns)
            .arg(release)
            .arg(revision.to_string());
        self.run(args, ()).await.map(drop)
    }

    pub async fn uninstall(&self, kc: &Path, ctx: &str, ns: &str, release: &str) -> CoreResult<()> {
        let args = Args::new(&["uninstall"]).kube(kc, ctx, ns).arg(release);
        self.run(args, ()).await.map(drop)
    }

    /// `helm install` into `ns` (created when missing).
    #[allow(clippy::too_many_arguments)]
    pub async fn install(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        chart: &str,
        version: Option<&str>,
        values_yaml: &str,
    ) -> CoreResult<()> {
        let values = values_file(values_yaml)?;
        let mut args = Args::new(&["install"])
            .kube(kc, ctx, ns)
            .switch("--create-namespace");
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            args = args.flag("--version", v);
        }
        if let Some(file) = &values {
            args = args.flag("--values", file.path());
        }
        self.run(args.arg(release).arg(chart), values)
            .await
            .map(drop)
    }

    pub async fn repos(&self) -> CoreResult<Vec<HelmRepo>> {
        match self
            .run(Args::new(&["repo", "list"]).flag("--output", "json"), ())
            .await
        {
            Ok(out) if out.trim().is_empty() => Ok(Vec::new()),
            Ok(out) => Ok(serde_json::from_str(&out)?),
            // Helm 3 fails with "no repositories to show"; Helm 4 prints `[]`.
            Err(e) if no_repositories(&e) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    pub async fn repo_add(&self, name: &str, url: &str) -> CoreResult<()> {
        let args = Args::new(&["repo", "add"]).arg(name).arg(url);
        self.run(args, ()).await.map(drop)
    }

    pub async fn repo_remove(&self, name: &str) -> CoreResult<()> {
        let args = Args::new(&["repo", "remove"]).arg(name);
        self.run(args, ()).await.map(drop)
    }

    /// Downloads the latest index of every repository. Nothing to update is not an error.
    pub async fn repo_update(&self) -> CoreResult<()> {
        match self.run(Args::new(&["repo", "update"]), ()).await {
            Err(e) if no_repositories(&e) => Ok(()),
            other => other.map(drop),
        }
    }

    /// Charts in the added repositories whose name or description matches `query` (all charts for an empty
    /// query); the latest version of each.
    pub async fn search(&self, query: &str) -> CoreResult<Vec<ChartHit>> {
        let mut args = Args::new(&["search", "repo"]).flag("--output", "json");
        if !query.trim().is_empty() {
            args = args.arg(query.trim());
        }
        let out = match self.run(args, ()).await {
            Ok(out) => out,
            Err(e) if no_repositories(&e) => return Ok(Vec::new()),
            Err(e) => return Err(e),
        };
        if out.trim().is_empty() {
            return Ok(Vec::new());
        }
        let raw: Vec<RawHit> = serde_json::from_str(&out)?;
        Ok(raw
            .into_iter()
            .map(|h| ChartHit {
                name: h.name,
                version: h.version,
                app_version: h.app_version,
                description: h.description,
            })
            .collect())
    }

    /// The chart's default `values.yaml`.
    pub async fn show_values(&self, chart: &str, version: Option<&str>) -> CoreResult<String> {
        let mut args = Args::new(&["show", "values"]);
        if let Some(v) = version.filter(|v| !v.is_empty()) {
            args = args.flag("--version", v);
        }
        self.run(args.arg(chart), ()).await
    }
}

fn no_repositories(e: &CoreError) -> bool {
    e.code == ErrorCode::Other && e.message.contains("no repositories")
}

/// Upgrades `release` with new user values, keeping its chart and chart version.
///
/// With an empty `chart_ref` the chart stored in the release itself is used (written to a temporary directory),
/// which needs no repository and works for charts installed from a local path. Helm does not keep subcharts in
/// the release, so a chart with dependencies needs `chart_ref` (`repo/chart`, a path or an `oci://` reference),
/// which is then pinned to the release's chart version.
#[allow(clippy::too_many_arguments)]
pub async fn upgrade_release(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart_ref: &str,
    values_yaml: &str,
) -> CoreResult<()> {
    let current = super::stored_release(mgr, cluster, ns, release, None).await?;
    let target = kube_target(mgr, cluster)?;
    let chart_ref = chart_ref.trim();
    if chart_ref.is_empty() {
        let dir = tempfile::tempdir()?;
        let chart_dir = write_stored_chart(&current.chart, dir.path())?;
        cli.upgrade_with_version(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart_dir.to_string_lossy().as_ref(),
            None,
            values_yaml,
        )
        .await
    } else {
        let version = current.summary().chart_version;
        cli.upgrade_with_version(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart_ref,
            Some(&version),
            values_yaml,
        )
        .await
    }
}

/// Writes the chart kept in a release (`chart` of the release JSON) as a chart directory under `dir`; returns it.
/// File names come from the cluster, so any name that would leave the directory is refused.
pub fn write_stored_chart(chart: &Value, dir: &Path) -> CoreResult<PathBuf> {
    let metadata = chart
        .get("metadata")
        .filter(|m| m.is_object())
        .ok_or_else(|| invalid("the release has no chart metadata"))?;
    let name = metadata
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let has_dependencies = metadata
        .get("dependencies")
        .and_then(Value::as_array)
        .is_some_and(|d| !d.is_empty());
    if has_dependencies {
        return Err(invalid(format!(
            "chart {name} has subcharts, which Helm does not keep in the release; enter the chart reference \
             (for example repo/{name}) to upgrade it"
        )));
    }
    let root = safe_join(dir, name)?;
    std::fs::create_dir_all(&root)?;
    std::fs::write(root.join("Chart.yaml"), serde_yaml::to_string(metadata)?)?;
    let values = chart.get("values").cloned().unwrap_or(Value::Null);
    std::fs::write(root.join("values.yaml"), super::values_to_yaml(&values)?)?;
    if let Some(schema) = chart.get("schema").and_then(Value::as_str) {
        std::fs::write(root.join("values.schema.json"), decode_b64(schema)?)?;
    }
    for list in ["templates", "files"] {
        for file in chart
            .get(list)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let name = file.get("name").and_then(Value::as_str).unwrap_or_default();
            let data = file.get("data").and_then(Value::as_str).unwrap_or_default();
            let path = safe_join(&root, name)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, decode_b64(data)?)?;
        }
    }
    Ok(root)
}

fn decode_b64(text: &str) -> CoreResult<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .map_err(|e| invalid(format!("a chart file is not base64: {e}")))
}

/// `base/relative`, refusing empty, absolute and `..` paths.
fn safe_join(base: &Path, relative: &str) -> CoreResult<PathBuf> {
    let rel = Path::new(relative);
    let ok = !relative.is_empty() && rel.components().all(|c| matches!(c, Component::Normal(_)));
    if ok {
        Ok(base.join(rel))
    } else {
        Err(invalid(format!(
            "unsafe file name in the stored chart: {relative:?}"
        )))
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(ErrorCode::Invalid, message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    #[test]
    fn positional_arguments_follow_a_double_dash() {
        let args = Args::new(&["uninstall"])
            .kube(Path::new("/tmp/kc"), "ctx", "ns")
            .arg("--dry-run")
            .into_vec();
        let args: Vec<_> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            [
                "uninstall",
                "--namespace",
                "ns",
                "--kubeconfig",
                "/tmp/kc",
                "--kube-context",
                "ctx",
                "--",
                "--dry-run"
            ]
        );
    }

    #[test]
    fn without_helm_in_path_it_is_missing() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(find_in_path(Some(empty.path().as_os_str())), None);
        assert_eq!(find_in_path(None), None);
        let status = HelmCli::default()
            .with_env("PATH", empty.path().as_os_str())
            .status();
        assert_eq!(
            status,
            HelmStatus {
                available: false,
                version: None,
                path: None
            }
        );
    }

    #[tokio::test]
    async fn a_call_without_helm_is_helm_missing() {
        let empty = tempfile::tempdir().unwrap();
        let cli = HelmCli::default().with_env("PATH", empty.path().as_os_str());
        let err = cli.repos().await.unwrap_err();
        assert_eq!(err.code, ErrorCode::HelmMissing);
        assert!(err.message.contains(INSTALL_URL));
        let err = HelmCli::default()
            .with_binary(empty.path().join("helm"))
            .search("x")
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::HelmMissing);
    }

    #[test]
    fn writes_the_stored_chart_back_as_a_directory() {
        let chart = json!({
            "metadata": { "name": "demo", "version": "0.1.0", "apiVersion": "v2", "appVersion": "1.0.0" },
            "templates": [{ "name": "templates/cm.yaml", "data": b64("kind: ConfigMap\n") }],
            "values": { "greeting": "hello" },
            "schema": b64("{\"type\":\"object\"}"),
            "files": [{ "name": "README.md", "data": b64("# demo\n") }]
        });
        let dir = tempfile::tempdir().unwrap();
        let root = write_stored_chart(&chart, dir.path()).unwrap();
        assert_eq!(root, dir.path().join("demo"));
        let read = |p: &str| std::fs::read_to_string(root.join(p)).unwrap();
        let meta: Value = serde_yaml::from_str(&read("Chart.yaml")).unwrap();
        assert_eq!(meta["appVersion"], "1.0.0");
        assert_eq!(read("values.yaml"), "greeting: hello\n");
        assert_eq!(read("templates/cm.yaml"), "kind: ConfigMap\n");
        assert_eq!(read("README.md"), "# demo\n");
        assert_eq!(read("values.schema.json"), "{\"type\":\"object\"}");
    }

    #[test]
    fn a_stored_chart_cannot_write_outside_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../evil.yaml", "/etc/evil", "templates/../../evil"] {
            let chart = json!({
                "metadata": { "name": "demo", "version": "0.1.0" },
                "templates": [{ "name": name, "data": b64("x") }]
            });
            let err = write_stored_chart(&chart, dir.path()).unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{name}");
        }
        let chart = json!({ "metadata": { "name": "../up", "version": "0.1.0" } });
        assert_eq!(
            write_stored_chart(&chart, dir.path()).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert!(!dir.path().parent().unwrap().join("evil.yaml").exists());
    }

    #[test]
    fn a_chart_with_subcharts_needs_a_reference() {
        let chart = json!({ "metadata": { "name": "app", "version": "1.0.0",
            "dependencies": [{ "name": "common", "version": "2.x", "repository": "https://charts.example" }] } });
        let dir = tempfile::tempdir().unwrap();
        let err = write_stored_chart(&chart, dir.path()).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        assert!(err.message.contains("repo/app"), "{}", err.message);
    }
}
