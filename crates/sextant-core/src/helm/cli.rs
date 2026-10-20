//! Calls to the `helm` binary. Every call that reaches a cluster passes `--kubeconfig <temp> --kube-context <ctx>`,
//! where the temporary kubeconfig (mode 0600) holds only that context and is deleted when the call is over;
//! credentials never appear on the command line. User values go through a temporary file (`-f`), not `--set`.
//! Positional arguments follow `--`, so a name starting with `-` cannot turn into a flag.
//!
//! A non-zero exit gives `CoreError { Other, <helm's stderr> }`; a missing binary gives `HelmMissing`.
//! Works with Helm 3 and Helm 4 (same flags, same JSON output, same release storage).

use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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

/// Whether an inherited variable must not reach `helm`. Variable names are case-insensitive on Windows (`helm_kubetoken`
/// is `HELM_KUBETOKEN` there), case-sensitive elsewhere.
fn redirects_helm(key: &OsStr) -> bool {
    redirects_helm_by(key, cfg!(windows))
}

fn redirects_helm_by(key: &OsStr, ignore_case: bool) -> bool {
    let key = key.to_string_lossy();
    let key = if ignore_case {
        key.to_ascii_uppercase()
    } else {
        key.into_owned()
    };
    key.starts_with("HELM_KUBE") || REDIRECTING_ENV.contains(&key.as_str())
}

/// Whether two environment variable names are the same variable on this platform.
fn same_env_name(a: &OsStr, b: &str) -> bool {
    if cfg!(windows) {
        a.to_string_lossy().eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// Whether `url` carries a login (`scheme://user:password@host/…`).
fn url_has_login(url: &str) -> bool {
    url_without_login(url) != url
}

/// `url` without the `user:password@` part of its authority (unchanged when there is none).
fn url_without_login(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_owned();
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    match rest[..end].rfind('@') {
        Some(at) => format!("{scheme}://{}", &rest[at + 1..]),
        None => url.to_owned(),
    }
}

/// `message` with every occurrence of `secret` hidden.
fn redact(message: String, secret: Option<&str>) -> String {
    match secret.filter(|s| !s.is_empty()) {
        Some(secret) if message.contains(secret) => message.replace(secret, "[hidden]"),
        _ => message,
    }
}

/// How often a running `helm` is checked for having exited.
const EXIT_POLL: Duration = Duration::from_millis(20);

/// A started `helm`, killed when this value is dropped while the process still runs: the call that started it was
/// dropped (its time limit passed, the MCP server stopped), so nobody waits for it any more.
struct KillOnDrop {
    child: Arc<Mutex<Child>>,
    killed: Arc<AtomicBool>,
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(None) = child.try_wait() {
            self.killed.store(true, Ordering::SeqCst);
            let _ = child.kill();
        }
    }
}

/// Starts `cmd`, retrying for a moment while the executable is busy (`ETXTBSY`): a binary just written, or being
/// replaced by an upgrade, can still be open for writing in another process (seen with a fake `helm` written while a
/// parallel test forks). The same rule as the cloud CLIs (`cloud::spawn_when_not_busy`), without blocking the runtime.
async fn spawn_when_not_busy(cmd: &mut Command) -> std::io::Result<Child> {
    let give_up = tokio::time::Instant::now() + Duration::from_secs(5);
    let mut pause = Duration::from_millis(5);
    loop {
        match cmd.spawn() {
            Err(e)
                if e.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && tokio::time::Instant::now() + pause < give_up =>
            {
                tokio::time::sleep(pause).await;
                pause = (pause * 2).min(Duration::from_millis(100));
            }
            spawned => return spawned,
        }
    }
}

/// Runs `cmd` to the end; `input` (if any) is written to its stdin, which is then closed. Waits without blocking the
/// runtime, and kills the process when the returned future is dropped before it has exited (kill on drop). `keep`
/// (temporary files the call reads) lives until the process has exited.
async fn run_child<K: Send + 'static>(
    mut cmd: Command,
    input: Option<String>,
    keep: K,
    limit: Option<usize>,
) -> std::io::Result<Output> {
    if input.is_some() {
        cmd.stdin(Stdio::piped());
    }
    let mut child = spawn_when_not_busy(&mut cmd).await?;
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        // `helm` may exit before reading (e.g. a refused flag); its exit status and stderr tell what happened.
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = stdin.write_all(input.as_bytes());
        });
    }
    // With a `limit`, one byte more than it is kept (to tell a larger output) and the rest is read and dropped, so
    // `helm` never blocks on a full pipe.
    let reader = move |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                match limit {
                    Some(max) => {
                        let _ = pipe.by_ref().take(max as u64 + 1).read_to_end(&mut bytes);
                        let _ = std::io::copy(&mut pipe, &mut std::io::sink());
                    }
                    None => {
                        let _ = pipe.read_to_end(&mut bytes);
                    }
                }
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
    let guard = KillOnDrop {
        child: Arc::new(Mutex::new(child)),
        killed: Arc::new(AtomicBool::new(false)),
    };
    let (child, killed) = (Arc::clone(&guard.child), Arc::clone(&guard.killed));
    let waited = tokio::task::spawn_blocking(move || {
        let status = loop {
            let exited = child.lock().unwrap_or_else(|e| e.into_inner()).try_wait();
            match exited {
                Ok(None) => std::thread::sleep(EXIT_POLL),
                other => break other,
            }
        };
        drop(keep);
        let status = status?.ok_or_else(|| std::io::Error::other("helm did not exit"))?;
        if killed.load(Ordering::SeqCst) {
            // Its pipes may still be held open by a process it started: they are left behind, not waited for.
            return Err(std::io::Error::other("helm was stopped"));
        }
        let bytes = |reader: std::thread::JoinHandle<Vec<u8>>| reader.join().unwrap_or_default();
        Ok(Output {
            status,
            stdout: bytes(stdout),
            stderr: bytes(stderr),
        })
    })
    .await;
    drop(guard);
    waited.map_err(std::io::Error::other)?
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

/// What a dry-run `install`/`upgrade` printed: the release's manifest, and whether Helm rendered it against the
/// cluster (`--dry-run=server`; `false` for a Helm before 3.13, whose `--dry-run` renders without the cluster).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    pub manifest: String,
    pub server_side: bool,
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
                    .find(|(k, _)| same_env_name(k, "PATH"))
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
        self.exec(args, keep, None).await
    }

    /// [`HelmCli::run`] with `secret_input` written to helm's stdin (a password: never an argument, which any
    /// process can read). The secret is hidden in whatever error comes back.
    async fn exec<K: Send + 'static>(
        &self,
        args: Args,
        keep: K,
        secret_input: Option<String>,
    ) -> CoreResult<String> {
        self.exec_full(args, keep, secret_input, None)
            .await
            .map(|(stdout, _)| stdout)
    }

    /// [`HelmCli::exec`] that also returns what `helm` printed to stderr on success (its warnings); with `limit`, an
    /// output (stdout or stderr) larger than that many bytes is an error.
    async fn exec_full<K: Send + 'static>(
        &self,
        args: Args,
        keep: K,
        secret_input: Option<String>,
        limit: Option<usize>,
    ) -> CoreResult<(String, String)> {
        let binary = self.binary().ok_or_else(helm_missing)?;
        let mut cmd = self.command(&binary);
        cmd.args(args.into_vec());
        let secret = secret_input.clone();
        let output = run_child(cmd, secret_input, keep, limit)
            .await
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => helm_missing(),
                _ => CoreError::other(format!("cannot run helm: {e}")),
            })?;
        if let Some(max) = limit
            && (output.stdout.len() > max || output.stderr.len() > max)
        {
            return Err(CoreError::other(format!(
                "helm printed more than {} KiB",
                max >> 10
            )));
        }
        if output.status.success() {
            return Ok((
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
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
        Err(CoreError::other(redact(message, secret.as_deref())))
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
            // A login kept in a URL (added outside Sextant) is not shown.
            Ok(out) => Ok(serde_json::from_str::<Vec<HelmRepo>>(&out)?
                .into_iter()
                .map(|r| HelmRepo {
                    url: url_without_login(&r.url),
                    ..r
                })
                .collect()),
            // Helm 3 fails with "no repositories to show"; Helm 4 prints `[]`.
            Err(e) if no_repositories(&e) => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// `helm repo add`. With a login, the user name is passed as `--username` and the password through stdin
    /// (`--password-stdin`); a URL carrying a login itself is refused (`invalid`), since helm would keep it in its
    /// repository list and show it everywhere the URL appears.
    pub async fn repo_add(
        &self,
        name: &str,
        url: &str,
        username: Option<&str>,
        password: Option<&str>,
    ) -> CoreResult<()> {
        if url_has_login(url) {
            return Err(invalid(
                "the repository URL contains a user name or password; remove them from the URL and enter them in \
                 the Username and Password fields",
            ));
        }
        let mut args = Args::new(&["repo", "add"]);
        let input = match (
            username.filter(|u| !u.is_empty()),
            password.filter(|p| !p.is_empty()),
        ) {
            (Some(user), password) => {
                // `--flag=value`: a user name starting with `-` stays a value.
                args = args
                    .switch(&format!("--username={user}"))
                    .switch("--password-stdin");
                Some(password.unwrap_or_default().to_owned())
            }
            (None, Some(_)) => {
                return Err(invalid(
                    "a repository password needs a user name: fill in the Username field",
                ));
            }
            (None, None) => None,
        };
        self.exec(args.arg(name).arg(url), (), input)
            .await
            .map(drop)
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

    /// The manifest `helm upgrade` would apply, without applying it: `--dry-run=server` (Helm renders against the
    /// cluster — `lookup` works — and installs nothing) with `--output json`; the same flags as
    /// [`HelmCli::upgrade_with_version`]. A Helm older than 3.13, which knows only `--dry-run`, is asked again with it.
    #[allow(clippy::too_many_arguments)]
    pub async fn render_upgrade(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        chart_ref: &str,
        version: Option<&str>,
        values_yaml: &str,
    ) -> CoreResult<Rendered> {
        let args = |dry_run: &str| {
            Args::new(&["upgrade"])
                .kube(kc, ctx, ns)
                .switch("--reset-values")
                .switch(dry_run)
                .flag("--output", "json")
        };
        self.render(args, release, chart_ref, version, values_yaml)
            .await
    }

    /// The manifest `helm install` would apply, without installing (see [`HelmCli::render_upgrade`]).
    #[allow(clippy::too_many_arguments)]
    pub async fn render_install(
        &self,
        kc: &Path,
        ctx: &str,
        ns: &str,
        release: &str,
        chart: &str,
        version: Option<&str>,
        values_yaml: &str,
    ) -> CoreResult<Rendered> {
        let args = |dry_run: &str| {
            Args::new(&["install"])
                .kube(kc, ctx, ns)
                .switch(dry_run)
                .flag("--output", "json")
        };
        self.render(args, release, chart, version, values_yaml)
            .await
    }

    /// Runs a dry-run `install`/`upgrade` built by `args` and returns the `manifest` of the release it prints.
    async fn render(
        &self,
        args: impl Fn(&str) -> Args,
        release: &str,
        chart: &str,
        version: Option<&str>,
        values_yaml: &str,
    ) -> CoreResult<Rendered> {
        let attempt = |dry_run: &'static str| {
            let values = values_file(values_yaml);
            let mut call = args(dry_run);
            if let Some(v) = version.filter(|v| !v.is_empty()) {
                call = call.flag("--version", v);
            }
            async move {
                let values = values?;
                if let Some(file) = &values {
                    call = call.flag("--values", file.path());
                }
                self.run(call.arg(release).arg(chart), values).await
            }
        };
        let (printed, server_side) = match attempt("--dry-run=server").await {
            Err(e) if e.message.contains("invalid argument \"server\"") => {
                (attempt("--dry-run").await?, false)
            }
            other => (other?, true),
        };
        let release: Value = serde_json::from_str(printed.trim())
            .map_err(|e| CoreError::other(format!("helm printed no release to compare: {e}")))?;
        let manifest = release
            .get("manifest")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Ok(Rendered {
            manifest,
            server_side,
        })
    }

    /// Every version of the charts named `chart` in the added repositories, read from Helm's local copies of their
    /// indexes (no network): `helm search repo --regexp --versions --devel`, one call for every repository. Helm
    /// matches the pattern against `<chart>\v<repo>/<chart>\v<description>…` lines, so `(^|/)<chart>(\v|$)` finds
    /// that name (and only names that end the same way, which the caller filters out). Prereleases are included
    /// (`--devel`); the caller decides about them. Also returns Helm's warnings (a repository whose index is
    /// missing or broken). The output is limited to [`SEARCH_OUTPUT_LIMIT`].
    pub async fn chart_versions(&self, chart: &str) -> CoreResult<(Vec<ChartHit>, String)> {
        let pattern = format!("(^|/){}(\\v|$)", regex_escape(&chart.to_lowercase()));
        let args = Args::new(&["search", "repo"])
            .switch("--regexp")
            .switch("--versions")
            .switch("--devel")
            .flag("--output", "json")
            .arg(pattern);
        let (out, warnings) = match self
            .exec_full(args, (), None, Some(SEARCH_OUTPUT_LIMIT))
            .await
        {
            Ok(printed) => printed,
            Err(e) if no_repositories(&e) => return Ok((Vec::new(), String::new())),
            Err(e) => return Err(e),
        };
        if out.trim().is_empty() {
            return Ok((Vec::new(), warnings));
        }
        let raw: Vec<RawHit> = serde_json::from_str(&out)?;
        let hits = raw
            .into_iter()
            .map(|h| ChartHit {
                name: h.name,
                version: h.version,
                app_version: h.app_version,
                description: h.description,
            })
            .collect();
        Ok((hits, warnings))
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

/// The most one `helm search` may print (stdout or stderr) for [`HelmCli::chart_versions`].
pub const SEARCH_OUTPUT_LIMIT: usize = 8 << 20;

/// `text` with every character a Go regular expression gives a meaning escaped.
fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii_punctuation() {
            out.push('\\');
        }
        out.push(c);
    }
    out
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
    upgrade_release_to(cli, mgr, cluster, ns, release, chart_ref, None, values_yaml).await
}

/// The chart version an upgrade pins: `version` when given (a newer chart, #209; it needs `chart_ref`, since the
/// chart stored in the release is only the installed version), else the release's own chart version.
fn upgrade_version(
    current: &super::StoredRelease,
    chart_ref: &str,
    version: Option<&str>,
) -> CoreResult<Option<String>> {
    match version.map(str::trim).filter(|v| !v.is_empty()) {
        Some(_) if chart_ref.is_empty() => Err(invalid(
            "a chart version needs a chart reference (repo/chart, a path or an oci:// reference)",
        )),
        Some(v) => Ok(Some(v.to_owned())),
        None if chart_ref.is_empty() => Ok(None),
        None => Ok(Some(current.summary().chart_version)),
    }
}

/// [`upgrade_release`] to chart `version` of `chart_ref` (`None`: the release's chart version).
#[allow(clippy::too_many_arguments)]
pub async fn upgrade_release_to(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart_ref: &str,
    version: Option<&str>,
    values_yaml: &str,
) -> CoreResult<()> {
    let current = super::stored_release(mgr, cluster, ns, release, None).await?;
    let chart_ref = chart_ref.trim();
    let pinned = upgrade_version(&current, chart_ref, version)?;
    let target = kube_target(mgr, cluster)?;
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
        cli.upgrade_with_version(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart_ref,
            pinned.as_deref(),
            values_yaml,
        )
        .await
    }
}

/// What [`upgrade_release`] would change: the release's current manifest (read from its stored revision, which is
/// what `helm get manifest` prints) against the one Helm renders for the same chart and the new values. Secrets are
/// shown without their values ([`diff::manifest_diff`]).
#[allow(clippy::too_many_arguments)]
pub async fn preview_upgrade(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart_ref: &str,
    values_yaml: &str,
) -> CoreResult<super::diff::HelmManifestDiff> {
    preview_upgrade_to(cli, mgr, cluster, ns, release, chart_ref, None, values_yaml).await
}

/// What [`upgrade_release_to`] would change (see [`preview_upgrade`]).
#[allow(clippy::too_many_arguments)]
pub async fn preview_upgrade_to(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart_ref: &str,
    version: Option<&str>,
    values_yaml: &str,
) -> CoreResult<super::diff::HelmManifestDiff> {
    let current = super::stored_release(mgr, cluster, ns, release, None).await?;
    let chart_ref = chart_ref.trim();
    let pinned = upgrade_version(&current, chart_ref, version)?;
    let target = kube_target(mgr, cluster)?;
    let proposed = if chart_ref.is_empty() {
        let dir = tempfile::tempdir()?;
        let chart_dir = write_stored_chart(&current.chart, dir.path())?;
        cli.render_upgrade(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart_dir.to_string_lossy().as_ref(),
            None,
            values_yaml,
        )
        .await?
    } else {
        cli.render_upgrade(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart_ref,
            pinned.as_deref(),
            values_yaml,
        )
        .await?
    };
    Ok(
        super::diff::manifest_diff(&current.manifest, &proposed.manifest)
            .rendered(proposed.server_side),
    )
}

/// What [`install_chart`] would apply, against the manifest of a release of that name already in `ns` (empty when
/// there is none).
#[allow(clippy::too_many_arguments)]
pub async fn preview_install(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart: &str,
    version: Option<&str>,
    values_yaml: &str,
) -> CoreResult<super::diff::HelmManifestDiff> {
    let values = if values_yaml.trim().is_empty() {
        String::new()
    } else {
        changed_values(&cli.show_values(chart, version).await?, values_yaml)?
    };
    let current = if super::release_history(mgr, cluster, ns, release)
        .await?
        .is_empty()
    {
        String::new()
    } else {
        super::stored_release(mgr, cluster, ns, release, None)
            .await?
            .manifest
    };
    let target = kube_target(mgr, cluster)?;
    let proposed = cli
        .render_install(
            &target.kubeconfig,
            &target.context,
            ns,
            release,
            chart,
            version,
            &values,
        )
        .await?;
    Ok(super::diff::manifest_diff(&current, &proposed.manifest).rendered(proposed.server_side))
}

/// `helm install` of `chart` keeping as the release's user values only what `values_yaml` changes relative to the
/// chart's default values (the dialog starts from the whole default file).
#[allow(clippy::too_many_arguments)]
pub async fn install_chart(
    cli: &HelmCli,
    mgr: &ClusterManager,
    cluster: &ClusterId,
    ns: &str,
    release: &str,
    chart: &str,
    version: Option<&str>,
    values_yaml: &str,
) -> CoreResult<()> {
    let values = if values_yaml.trim().is_empty() {
        String::new()
    } else {
        changed_values(&cli.show_values(chart, version).await?, values_yaml)?
    };
    let target = kube_target(mgr, cluster)?;
    cli.install(
        &target.kubeconfig,
        &target.context,
        ns,
        release,
        chart,
        version,
        &values,
    )
    .await
}

/// What `edited` changes relative to `defaults` (both values YAML), as YAML for `helm -f`; empty when nothing
/// changes.
///
/// Both texts are read the way Helm reads them — YAML 1.1 (see [`parse_values`]) — and the result is written so
/// that Helm reads back the same values and types (see [`write_values`]). Maps are compared key by key,
/// recursively; lists and scalars are changed or not as a whole. A default key left out of `edited` keeps its
/// default, as Helm merges user values into the defaults anyway (`null` removes one). Comments, formatting and key
/// order are not changes.
pub fn changed_values(defaults: &str, edited: &str) -> CoreResult<String> {
    let edited = parse_values(edited)?;
    if edited.is_null() {
        return Ok(String::new());
    }
    match values_diff(&edited, &parse_values(defaults)?) {
        Some(changed) => {
            let mut out = String::new();
            write_values(&changed, &mut out);
            out.push('\n');
            Ok(out)
        }
        None => Ok(String::new()),
    }
}

/// Values YAML read as Helm reads it: YAML 1.1 (go-yaml v2), where a plain `y`/`yes`/`on` (and `n`/`no`/`off`, in
/// any of their spellings) is a boolean, `0644` is octal, `1_000` is a number — serde_yaml alone reads YAML 1.2.
/// Quoted, block and explicitly tagged scalars stay text.
fn parse_values(text: &str) -> CoreResult<serde_yaml::Value> {
    if text.trim().is_empty() {
        return Ok(serde_yaml::Value::Null);
    }
    use serde::de::DeserializeSeed as _;
    let seed = Yaml11 {
        src: text,
        tagged: false,
        key: false,
    };
    Ok(seed.deserialize(serde_yaml::Deserializer::from_str(text))?)
}

/// Reads a YAML node of `src` with YAML 1.1 types. serde_yaml resolves plain scalars by YAML 1.2 rules, which agree
/// with YAML 1.1 on null, `true`/`false` and the numbers both know; any other plain scalar comes as a string
/// borrowed from `src`, and its position there tells whether it was written plain (then resolved here) or quoted.
#[derive(Clone, Copy)]
struct Yaml11<'s> {
    src: &'s str,
    /// Inside a local tag (`!foo …`): scalars stay as serde_yaml reads them.
    tagged: bool,
    /// A map key: a plain `<<` (or `!!merge <<`) is the merge key, read as [`merge_key`].
    key: bool,
}

impl Yaml11<'_> {
    /// Whether `value` is a plain scalar of `src` without an explicit tag (`!!str yes` is text).
    fn is_plain(&self, value: &str) -> bool {
        self.tag_of(value) == Some("")
    }

    /// The explicit tag of `value`, an unquoted scalar of `src` (`""` without one); `None` when it is quoted or not
    /// borrowed from `src`.
    fn tag_of(&self, value: &str) -> Option<&str> {
        let start = self.src.as_ptr() as usize;
        let offset = (value.as_ptr() as usize).checked_sub(start)?;
        if offset + value.len() > self.src.len() || !self.src.is_char_boundary(offset) {
            return None;
        }
        if self.src[..offset].ends_with(['"', '\'']) {
            return None;
        }
        let before = self.src[..offset].trim_end_matches([' ', '\t']);
        let token = before
            .rfind([' ', '\t', '\n', '\r', '[', '{', ','])
            .map_or(before, |i| &before[i + 1..]);
        Some(if token.starts_with('!') { token } else { "" })
    }

    /// Whether `value` is the merge key: in a key, a plain `<<` or one tagged `!!merge`.
    fn is_merge_key(&self, value: &str) -> bool {
        self.key && value == "<<" && matches!(self.tag_of(value), Some("" | "!!merge"))
    }
}

impl<'de> serde::de::DeserializeSeed<'de> for Yaml11<'_> {
    type Value = serde_yaml::Value;

    fn deserialize<D: serde::Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
        de.deserialize_any(self)
    }
}

impl<'de> serde::de::Visitor<'de> for Yaml11<'_> {
    type Value = serde_yaml::Value;

    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("YAML values")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Null)
    }

    fn visit_none<E>(self) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Null)
    }

    fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Number(v.into()))
    }

    fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Number(v.into()))
    }

    // Beyond 64 bits YAML 1.1 (Go) reads a number as a float.
    fn visit_i128<E>(self, v: i128) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Number((v as f64).into()))
    }

    fn visit_u128<E>(self, v: u128) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Number((v as f64).into()))
    }

    fn visit_f64<E>(self, v: f64) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::Number(v.into()))
    }

    fn visit_borrowed_str<E>(self, v: &'de str) -> Result<Self::Value, E> {
        if !self.tagged && self.is_merge_key(v) {
            Ok(merge_key())
        } else if !self.tagged && self.is_plain(v) {
            Ok(resolve_plain_yaml11(v))
        } else {
            Ok(serde_yaml::Value::String(v.to_owned()))
        }
    }

    // Not borrowed: quoted with escapes, a block scalar or a folded multi-line plain scalar — text either way.
    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
        Ok(serde_yaml::Value::String(v.to_owned()))
    }

    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let item = Yaml11 {
            tagged: false,
            key: false,
            ..self
        };
        let mut items = Vec::new();
        while let Some(value) = seq.next_element_seed(item)? {
            items.push(value);
        }
        Ok(serde_yaml::Value::Sequence(items))
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let key = Yaml11 {
            tagged: false,
            key: true,
            ..self
        };
        let node = Yaml11 {
            tagged: false,
            key: false,
            ..self
        };
        let mut mapping = serde_yaml::Mapping::new();
        let mut explicit = std::collections::HashSet::new();
        while let Some(key) = map.next_key_seed(key)? {
            let value = map.next_value_seed(node)?;
            if key == merge_key() {
                merge_into(&mut mapping, value)?;
                continue;
            }
            if !explicit.insert(key.clone()) {
                return Err(serde::de::Error::custom(
                    "a key appears twice in the values (YAML 1.1: `off` and `false` are the same key)",
                ));
            }
            mapping.insert(key, value);
        }
        Ok(serde_yaml::Value::Mapping(mapping))
    }

    // A local tag (`!foo value`): the value without the tag.
    fn visit_enum<A: serde::de::EnumAccess<'de>>(self, data: A) -> Result<Self::Value, A::Error> {
        use serde::de::VariantAccess as _;
        let (_tag, variant) = data.variant::<String>()?;
        variant.newtype_variant_seed(Yaml11 {
            tagged: true,
            key: false,
            ..self
        })
    }
}

/// The merge key `<<` as [`Yaml11`] reads it in a key: a value no YAML text gives otherwise (its local tags are
/// dropped), told apart in [`Yaml11::visit_map`].
fn merge_key() -> serde_yaml::Value {
    serde_yaml::Value::Tagged(Box::new(serde_yaml::value::TaggedValue {
        tag: serde_yaml::value::Tag::new("!!merge"),
        value: serde_yaml::Value::Null,
    }))
}

/// go-yaml v2's map merge: the keys of a map — or of each map in a list, the last first, so the earlier ones win —
/// set into `mapping` over what is there; keys after the merge key replace them in turn.
fn merge_into<E: serde::de::Error>(
    mapping: &mut serde_yaml::Mapping,
    value: serde_yaml::Value,
) -> Result<(), E> {
    let want_map = || E::custom("map merge requires map or sequence of maps as the value");
    let maps = match value {
        serde_yaml::Value::Mapping(map) => vec![map],
        serde_yaml::Value::Sequence(items) => items
            .into_iter()
            .rev()
            .map(|item| match item {
                serde_yaml::Value::Mapping(map) => Ok(map),
                _ => Err(want_map()),
            })
            .collect::<Result<_, _>>()?,
        _ => return Err(want_map()),
    };
    for map in maps {
        for (k, v) in map {
            mapping.insert(k, v);
        }
    }
    Ok(())
}

/// A plain scalar that YAML 1.2 left as text, typed by the YAML 1.1 rules of go-yaml v2 (`resolve`): the boolean
/// words; for text starting with a digit or sign, Go's `ParseInt(s, 0, 64)` / `ParseUint` with `_` removed (so
/// `0644` is octal and `0x`, `0o`, `0b` prefixes work), then a float of the YAML 1.1 shape.
fn resolve_plain_yaml11(v: &str) -> serde_yaml::Value {
    use serde_yaml::Value as Y;
    match v {
        "y" | "Y" | "yes" | "Yes" | "YES" | "on" | "On" | "ON" => return Y::Bool(true),
        "n" | "N" | "no" | "No" | "NO" | "off" | "Off" | "OFF" => return Y::Bool(false),
        _ => {}
    }
    let float = |t: &str| {
        yaml11_float_shape(t)
            .then(|| t.parse::<f64>().ok())
            .flatten()
            .filter(|f| f.is_finite())
    };
    match v.as_bytes().first() {
        Some(b'0'..=b'9' | b'+' | b'-') => {
            let plain = v.replace('_', "");
            if let Some(number) = go_parse_int(&plain) {
                return Y::Number(number);
            }
            if let Some(f) = float(&plain) {
                return Y::Number(f.into());
            }
        }
        Some(b'.') => {
            if let Some(f) = float(v) {
                return Y::Number(f.into());
            }
        }
        _ => {}
    }
    Y::String(v.to_owned())
}

/// Go's `strconv.ParseInt(s, 0, 64)`, then `ParseUint(s, 0, 64)` (which takes no sign).
fn go_parse_int(s: &str) -> Option<serde_yaml::Number> {
    let (sign, body) = match s.as_bytes().first() {
        Some(b'-') => (Some('-'), &s[1..]),
        Some(b'+') => (Some('+'), &s[1..]),
        _ => (None, s),
    };
    let prefixed = |p: [&str; 2]| body.strip_prefix(p[0]).or_else(|| body.strip_prefix(p[1]));
    let (radix, digits) = if let Some(d) = prefixed(["0x", "0X"]) {
        (16, d)
    } else if let Some(d) = prefixed(["0o", "0O"]) {
        (8, d)
    } else if let Some(d) = prefixed(["0b", "0B"]) {
        (2, d)
    } else if body.len() > 1 && body.starts_with('0') {
        (8, &body[1..])
    } else {
        (10, body)
    };
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    let magnitude = u64::from_str_radix(digits, radix).ok()?;
    match sign {
        Some('-') => i64::try_from(-i128::from(magnitude)).ok().map(Into::into),
        Some(_) => i64::try_from(magnitude).ok().map(Into::into),
        None => Some(match i64::try_from(magnitude) {
            Ok(i) => i.into(),
            Err(_) => magnitude.into(),
        }),
    }
}

/// go-yaml v2's float shape: `^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$`.
fn yaml11_float_shape(s: &str) -> bool {
    let digits = |t: &str| t.bytes().all(|b| b.is_ascii_digit());
    let s = s.strip_prefix(['-', '+']).unwrap_or(s);
    let (mantissa, exponent) = match s.find(['e', 'E']) {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let mantissa_ok = match mantissa.strip_prefix('.') {
        Some(fraction) => !fraction.is_empty() && digits(fraction),
        None => {
            let (int, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            !int.is_empty() && digits(int) && digits(fraction)
        }
    };
    let exponent_ok = exponent.is_none_or(|e| {
        let e = e.strip_prefix(['-', '+']).unwrap_or(e);
        !e.is_empty() && digits(e)
    });
    mantissa_ok && exponent_ok
}

/// Writes values in YAML flow style that YAML 1.1 and 1.2 read alike: every string double-quoted, numbers and
/// booleans in their unambiguous spelling.
fn write_values(value: &serde_yaml::Value, out: &mut String) {
    use serde_yaml::Value as Y;
    match value {
        Y::Null => out.push_str("null"),
        Y::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Y::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.is_nan() {
                    out.push_str(".nan");
                } else if f.is_infinite() {
                    out.push_str(if f > 0.0 { ".inf" } else { "-.inf" });
                } else {
                    // `{:?}` always has a `.` or an exponent ("8.0", "1e300"): a float to YAML 1.1 too.
                    out.push_str(&format!("{f:?}"));
                }
            }
        }
        Y::String(s) => super::write_quoted(s, out),
        Y::Sequence(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_values(item, out);
            }
            out.push(']');
        }
        Y::Mapping(map) => {
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_values(key, out);
                out.push_str(": ");
                write_values(item, out);
            }
            out.push('}');
        }
        Y::Tagged(tagged) => write_values(&tagged.value, out),
    }
}

/// The part of `edited` that differs from `default`; `None` when nothing does.
fn values_diff(
    edited: &serde_yaml::Value,
    default: &serde_yaml::Value,
) -> Option<serde_yaml::Value> {
    use serde_yaml::Value as Y;
    match (edited, default) {
        (Y::Mapping(edited), Y::Mapping(default)) => {
            let mut changed = serde_yaml::Mapping::new();
            for (key, value) in edited {
                let diff = match default.get(key) {
                    Some(default) => values_diff(value, default),
                    None => Some(value.clone()),
                };
                if let Some(diff) = diff {
                    changed.insert(key.clone(), diff);
                }
            }
            (!changed.is_empty()).then_some(Y::Mapping(changed))
        }
        _ => (edited != default).then(|| edited.clone()),
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
    fn on_windows_redirecting_variables_are_matched_without_case() {
        let windows = |k: &str| redirects_helm_by(OsStr::new(k), true);
        for key in [
            "helm_kubetoken",
            "Helm_KubeApiServer",
            "HELM_KUBEASUSER",
            "helm_kube_future_flag",
            "Helm_Namespace",
            "helm_driver",
            "KubeConfig",
        ] {
            assert!(windows(key), "{key} must not reach helm on Windows");
        }
        for key in ["HELM_CONFIG_HOME", "helm_cache_home", "Path", "KUBECONFIGX"] {
            assert!(!windows(key), "{key} is kept");
        }
        // Elsewhere names are case-sensitive: helm reads only the upper-case ones.
        let unix = |k: &str| redirects_helm_by(OsStr::new(k), false);
        assert!(unix("HELM_KUBETOKEN") && unix("KUBECONFIG") && unix("HELM_KUBE_FUTURE"));
        assert!(!unix("helm_kubetoken") && !unix("Helm_KubeApiServer") && !unix("kubeconfig"));
    }

    #[test]
    fn changed_values_keep_only_what_differs_from_the_defaults() {
        let defaults = "# Defaults\nimage:\n  repository: nginx\n  tag: \"1.25\"\nports: [80, 443]\nreplicas: 1\n";
        assert_eq!(changed_values(defaults, defaults).unwrap(), "");
        assert_eq!(changed_values(defaults, "").unwrap(), "");
        assert_eq!(
            changed_values(defaults, &defaults.replace("1.25", "1.27")).unwrap(),
            "{\"image\": {\"tag\": \"1.27\"}}\n"
        );
        // A list is one value; a new key is a change; a missing key keeps its default.
        assert_eq!(
            changed_values(defaults, "ports: [80]\nextra: {enabled: true}\n").unwrap(),
            "{\"ports\": [80], \"extra\": {\"enabled\": true}}\n"
        );
        // `null` removes a default in Helm, so it is a change.
        assert_eq!(
            changed_values(defaults, "image: null\n").unwrap(),
            "{\"image\": null}\n"
        );
        assert_eq!(
            changed_values(defaults, "replicas: [").unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    /// Helm reads values files as YAML 1.1: a plain `yes`, `on`, `N`, `off` is a boolean, `0644` is octal 420,
    /// `1_000` is 1000, a plain key `off` is `false` — while quoted text stays text. What `changed_values` writes
    /// must mean to Helm exactly what the user typed (expected values worked out by hand from the YAML 1.1 types).
    #[test]
    fn changed_values_mean_to_helm_what_the_user_typed() {
        let defaults = "replicas: 1\n";
        let cases = [
            ("q: \"yes\"\n", r#"{"q": "yes"}"#),
            ("q: 'on'\n", r#"{"q": "on"}"#),
            ("q: \"N\"\n", r#"{"q": "N"}"#),
            ("q: \"off\"\n", r#"{"q": "off"}"#),
            ("q: yes\n", r#"{"q": true}"#),
            ("q: On\n", r#"{"q": true}"#),
            ("q: N\n", r#"{"q": false}"#),
            ("q: off\n", r#"{"q": false}"#),
            ("q: 0644\n", r#"{"q": 420}"#),
            ("q: -0644\n", r#"{"q": -420}"#),
            ("q: \"0644\"\n", r#"{"q": "0644"}"#),
            ("q: 1_000\n", r#"{"q": 1000}"#),
            ("q: \"1_000\"\n", r#"{"q": "1_000"}"#),
            ("q: 0X1F\n", r#"{"q": 31}"#),
            ("q: 08\n", r#"{"q": 8.0}"#),
            ("q: 1_000.5\n", r#"{"q": 1000.5}"#),
            ("q: .5\n", r#"{"q": 0.5}"#),
            ("q: .inf\n", r#"{"q": .inf}"#),
            ("q: ~\n", r#"{"q": null}"#),
            ("q: \"true\"\n", r#"{"q": "true"}"#),
            ("q: !!str yes\n", r#"{"q": "yes"}"#),
            ("q: 1.2.3\n", r#"{"q": "1.2.3"}"#),
            ("q: 2026-10-12\n", r#"{"q": "2026-10-12"}"#),
            ("q: \"a \\\"b\\\" \\u007f\"\n", r#"{"q": "a \"b\" \u007F"}"#),
            (
                "q: \"a\\Lb\\Pc\\Nd\"\n",
                r#"{"q": "a\u2028b\u2029c\u0085d"}"#,
            ),
            ("\"off\": x\n", r#"{"off": "x"}"#),
            ("off: x\n", r#"{false: "x"}"#),
            ("q: [yes, \"no\", 010]\n", r#"{"q": [true, "no", 8]}"#),
        ];
        for (edited, expected) in cases {
            assert_eq!(
                changed_values(defaults, edited).unwrap(),
                format!("{expected}\n"),
                "{edited}"
            );
        }
        // Same value as the default, read the YAML 1.1 way: not a change.
        assert_eq!(
            changed_values("on: true\nmode: 420\n", "on: yes\nmode: 0644\n").unwrap(),
            ""
        );
    }

    /// A plain `<<` key merges a map (or a list of maps) into its map the way go-yaml v2 does, so the changed
    /// values mean to Helm what `helm -f` of the edited text means: keys in document order, a later one replacing an
    /// earlier one (explicit or merged); in a list of maps the earlier map wins; a quoted `"<<"` is an ordinary key.
    /// Expected values are what `helm template` with `{{ toJson .Values }}` printed for the same texts (helm v4.3).
    #[test]
    fn merge_keys_are_applied_as_helm_applies_them() {
        let defaults = "common: &c {tag: \"1.0\"}\nweb: {<<: *c, port: 80}\n";
        let edited = "common: &c {tag: \"2.0\"}\nweb: {<<: *c, port: 80}\n";
        assert_eq!(
            changed_values(defaults, edited).unwrap(),
            "{\"common\": {\"tag\": \"2.0\"}, \"web\": {\"tag\": \"2.0\"}}\n"
        );
        assert_eq!(changed_values(defaults, defaults).unwrap(), "");

        let edited = "a: &a {x: 1, k: 1}\nb: &b {x: 2, z: 2}\nm1: {x: 0, <<: *a}\nm2: {<<: *a, x: 0}\n\
            m3: {<<: [*a, *b]}\nm4: {<<: [*b, *a], w: 3}\nm5: {\"<<\": *a}\nm6: {<<: *a, <<: {x: 3}}\n\
            m7: {!!merge <<: *b}\nm8: {? << : *b, <<: []}\nm9:\n  <<: *a\n  sub: {<<: *b}\n";
        let from_helm: serde_json::Value = serde_json::from_str(
            r#"{"a":{"k":1,"x":1},"b":{"x":2,"z":2},"m1":{"k":1,"x":1},"m2":{"k":1,"x":0},
            "m3":{"k":1,"x":1,"z":2},"m4":{"k":1,"w":3,"x":2,"z":2},"m5":{"<<":{"k":1,"x":1}},
            "m6":{"k":1,"x":3},"m7":{"x":2,"z":2},"m8":{"x":2,"z":2},
            "m9":{"sub":{"x":2,"z":2},"k":1,"x":1}}"#,
        )
        .unwrap();
        let changed = changed_values("replicas: 1\n", edited).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&changed).unwrap(),
            from_helm,
            "{changed}"
        );

        // helm: "map merge requires map or sequence of maps as the value".
        for edited in [
            "m: {<<: 1}\n",
            "n: &n ~\nm: {<<: *n}\n",
            "m: {<<: [{x: 1}, 2]}\n",
            "a: &a [1]\nm: {<<: *a}\n",
        ] {
            assert_eq!(
                changed_values("replicas: 1\n", edited).unwrap_err().code,
                ErrorCode::Invalid,
                "{edited}"
            );
        }
        // Not a key: plain text.
        assert_eq!(
            changed_values("replicas: 1\n", "q: <<\nr: [<<]\n").unwrap(),
            "{\"q\": \"<<\", \"r\": [\"<<\"]}\n"
        );
    }

    /// The values "Edit values" shows (`values_to_yaml` of the config Helm stored) read back by Helm's YAML 1.1
    /// rules give the same config: same values, same types.
    #[test]
    fn shown_values_read_by_helm_give_back_the_stored_config() {
        let configs = [
            json!({ "q": "yes", "p": true, "letter": "N", "flag": false, "on": "On" }),
            json!({ "mode": "0644", "octal": 420, "count": "1_000", "big": 1000, "hex": "0x1F", "eight": "08" }),
            json!({ "off": "x", "false": "y", "null": "null", "tilde": "~", "empty": "" }),
            json!({ "stamp": "2026-10-12", "version": "1.25", "semver": "1.2.3", "inf": ".inf", "float": 8.0 }),
            json!({ "multi": "a\nb # c: d", "dash": "-", "lead": " x", "colon": "x: y", "hash": "#c", "end": "x:" }),
            json!({ "image": "nginx:1.25", "path": "/a/b", "text": "Hello, world (1)", "pct": "50%" }),
            json!({ "list": ["on", 2, "3", { "y": "~" }, [true, "no"]], "nested": { "y": { "deep": "Off" } } }),
            json!({ "ctl": "a\u{7f}b\tc\"d\\e", "uni": "Привет", "emptyList": [], "emptyMap": {}, "nil": null }),
        ];
        for config in configs {
            let shown = super::super::values_to_yaml(&config).unwrap();
            let read = parse_values(&shown).unwrap();
            assert_eq!(read, serde_yaml::to_value(&config).unwrap(), "{shown}");
        }
        // Plain text stays plain to read and edit.
        assert_eq!(
            super::super::values_to_yaml(
                &json!({ "greeting": "hi there", "image": { "tag": "1.25" }, "ports": [80] })
            )
            .unwrap(),
            "greeting: hi there\nimage:\n  tag: \"1.25\"\nports:\n- 80\n"
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

    /// A fake `helm` in `dir` that writes its PID to `dir/pid` and then sleeps for 30 s (as the same process).
    #[cfg(unix)]
    fn sleeping_helm(dir: &Path) -> (HelmCli, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let pid = dir.join("pid");
        let fake = dir.join("helm");
        std::fs::write(
            &fake,
            format!("#!/bin/sh\necho $$ > '{}'\nexec sleep 30\n", pid.display()),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        (HelmCli::default().with_binary(fake), pid)
    }

    #[cfg(unix)]
    fn alive(pid: &str) -> bool {
        Command::new("kill")
            .args(["-0", pid])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// Dropping a call (its caller gave up: a time limit, a stopped MCP server) kills the `helm` it started.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_dropped_call_kills_its_helm() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, pid_file) = sleeping_helm(dir.path());
        let mut call = Box::pin(cli.uninstall(Path::new("/nonexistent"), "ctx", "ns", "web"));
        let pid = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                tokio::select! {
                    result = &mut call => panic!("helm ended: {result:?}"),
                    () = tokio::time::sleep(Duration::from_millis(20)) => {}
                }
                let pid = std::fs::read_to_string(&pid_file).unwrap_or_default();
                if !pid.trim().is_empty() {
                    return pid.trim().to_owned();
                }
            }
        })
        .await
        .expect("helm did not start");
        assert!(alive(&pid));
        drop(call);
        for _ in 0..250 {
            if !alive(&pid) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let _ = Command::new("kill").args(["-9", &pid]).status();
        panic!("helm {pid} outlived its call");
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

    /// A fake `helm` in `dir` that writes its arguments (one per line) and its `KUBECONFIG`/`HELM_KUBETOKEN` to
    /// `dir/args`, then runs `body`.
    #[cfg(unix)]
    fn recording_helm(dir: &Path, body: &str) -> (HelmCli, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let record = dir.join("args");
        let fake = dir.join("helm");
        std::fs::write(
            &fake,
            format!(
                "#!/bin/sh\nfor a in \"$@\"; do echo \"$a\"; done >> '{r}'\necho \"env:${{KUBECONFIG:-}}${{HELM_KUBETOKEN:-}}\" >> '{r}'\n{body}\n",
                r = record.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        (HelmCli::default().with_binary(fake), record)
    }

    /// A preview renders with a server-side dry run and JSON output, through the given kubeconfig, never with a
    /// `KUBECONFIG` or `HELM_KUBE*` of the app; the release's manifest is what comes back.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_preview_renders_with_a_server_dry_run_and_reads_the_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, record) = recording_helm(
            dir.path(),
            r#"printf '%s' '{"name":"web","manifest":"---\nkind: ConfigMap\n"}'"#,
        );
        // Whatever `KUBECONFIG` the test runs with never reaches helm (the scrubbing itself is tested with a set
        // environment in `tests/helm.rs`).
        let kc = dir.path().join("kc");
        let manifest = cli
            .render_upgrade(
                &kc,
                "ctx",
                "ns",
                "web",
                "repo/app",
                Some("1.2.3"),
                "replicas: 3\n",
            )
            .await;
        let rendered = manifest.unwrap();
        assert_eq!(rendered.manifest, "---\nkind: ConfigMap\n");
        assert!(rendered.server_side);
        let args = std::fs::read_to_string(&record).unwrap();
        let lines: Vec<&str> = args.lines().collect();
        assert_eq!(&lines[..2], ["upgrade", "--namespace"]);
        for expected in [
            "--dry-run=server",
            "--reset-values",
            "--kube-context",
            "1.2.3",
        ] {
            assert!(lines.contains(&expected), "{args}");
        }
        let at = |flag: &str| lines.iter().position(|l| *l == flag).unwrap();
        assert_eq!(lines[at("--output") + 1], "json");
        assert_eq!(lines[at("--kubeconfig") + 1], kc.display().to_string());
        assert_eq!(&lines[at("--")..at("--") + 3], ["--", "web", "repo/app"]);
        assert!(lines.contains(&"env:"), "{args}");
    }

    /// A Helm without `--dry-run=server` (before 3.13) is asked again with `--dry-run`.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_older_helm_renders_with_a_plain_dry_run() {
        let dir = tempfile::tempdir().unwrap();
        let (cli, record) = recording_helm(
            dir.path(),
            r#"case "$*" in *--dry-run=server*) echo 'Error: invalid argument "server" for "--dry-run" flag' >&2; exit 1;; esac
printf '%s' '{"manifest":"kind: Secret\n"}'"#,
        );
        let manifest = cli
            .render_install(Path::new("/kc"), "ctx", "ns", "web", "repo/app", None, "")
            .await
            .unwrap();
        assert_eq!(manifest.manifest, "kind: Secret\n");
        assert!(!manifest.server_side);
        let args = std::fs::read_to_string(&record).unwrap();
        assert!(args.lines().any(|l| l == "--dry-run"), "{args}");
        assert!(!args.contains("--values"), "{args}");
        assert!(!args.contains("--create-namespace"), "{args}");
    }

    /// An upgrade keeps the release's chart version unless a newer one is picked (#209), which needs a reference.
    #[test]
    fn an_upgrade_pins_the_picked_version_or_the_installed_one() {
        let current = super::super::StoredRelease {
            chart: json!({ "metadata": { "name": "app", "version": "1.0.0" } }),
            ..Default::default()
        };
        assert_eq!(upgrade_version(&current, "", None).unwrap(), None);
        assert_eq!(
            upgrade_version(&current, "repo/app", None)
                .unwrap()
                .as_deref(),
            Some("1.0.0")
        );
        assert_eq!(
            upgrade_version(&current, "repo/app", Some(" 1.2.0 "))
                .unwrap()
                .as_deref(),
            Some("1.2.0")
        );
        assert_eq!(
            upgrade_version(&current, "repo/app", Some(""))
                .unwrap()
                .as_deref(),
            Some("1.0.0")
        );
        let err = upgrade_version(&current, "", Some("1.2.0")).unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
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
