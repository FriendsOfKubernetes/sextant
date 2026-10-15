//! Kubeconfig sources and the clusters (contexts) they describe.
//!
//! Sources are `KUBECONFIG` (every file of the list) or, without it, `~/.kube/config`, plus files the user added
//! or pasted. Every context of every source is one cluster in the rail. Credentials stay inside this module and
//! [`crate::cluster`]: [`ClusterInfo`] carries names and the server URL only, and error messages never quote the
//! kubeconfig text.

use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};

use kube::config::{Kubeconfig, KubeconfigError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};

/// Where a kubeconfig file came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SourceKind {
    /// `~/.kube/config`
    Default,
    /// A file listed in `KUBECONFIG`.
    Env,
    /// A file the user added with "Add kubeconfig file".
    AddedFile,
    /// Text the user pasted; stored in the app data directory.
    Pasted,
    /// Clusters imported from a cloud CLI (`aws`, `gcloud`, `az`); Sextant's own file `cloud-<provider>.yaml` in the
    /// app data directory.
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KubeconfigSource {
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
    /// Why the source cannot be read right now (`null` when it is fine). Filled by
    /// [`KubeconfigRegistry::sources`]; never stored in the settings.
    #[serde(default)]
    pub error: Option<CoreError>,
}

/// Stable cluster id: hex `sha256(normalized source path + "\0" + context)[..16]` (see `normalized_path`).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClusterId(pub String);

impl ClusterId {
    /// The id of `context` in the kubeconfig file at `source_path`.
    pub fn for_context(source_path: &Path, context: &str) -> Self {
        let mut bytes = normalized_path(source_path)
            .as_os_str()
            .as_encoded_bytes()
            .to_vec();
        bytes.push(0);
        bytes.extend_from_slice(context.as_bytes());
        Self(short_hash(&bytes))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for ClusterId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ClusterId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ClusterId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

/// One kubeconfig context as shown in the cluster rail. Never carries credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ClusterInfo {
    pub id: ClusterId,
    pub context: String,
    pub cluster_name: String,
    pub server: String,
    pub user: String,
    pub namespace: Option<String>,
    pub source_id: String,
}

/// Where the default sources are looked up: the `KUBECONFIG` value and the home directory.
/// Captured from the process at [`KubeconfigRegistry::new`]; tests replace it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct KubeconfigEnv {
    pub kubeconfig: Option<OsString>,
    pub home: Option<PathBuf>,
}

impl KubeconfigEnv {
    pub fn from_process() -> Self {
        Self {
            kubeconfig: std::env::var_os("KUBECONFIG"),
            home: std::env::home_dir(),
        }
    }
}

/// All kubeconfig sources: `KUBECONFIG` / `~/.kube/config` plus files the user added or pasted.
#[derive(Debug, Clone)]
pub struct KubeconfigRegistry {
    extra_sources: Vec<KubeconfigSource>,
    pasted_dir: PathBuf,
    env: KubeconfigEnv,
}

impl KubeconfigRegistry {
    /// `extra_sources` are the added/pasted sources saved in the settings; `pasted_dir` receives pasted text.
    pub fn new(extra_sources: Vec<KubeconfigSource>, pasted_dir: PathBuf) -> Self {
        Self {
            extra_sources,
            pasted_dir,
            env: KubeconfigEnv::from_process(),
        }
    }

    /// Replaces where `KUBECONFIG` and the home directory are taken from (tests, isolated environments).
    pub fn with_env(mut self, env: KubeconfigEnv) -> Self {
        self.env = env;
        self
    }

    pub fn set_env(&mut self, env: KubeconfigEnv) {
        self.env = env;
    }

    /// Every source, the checked default locations first (they are listed even when the file is missing), each with
    /// the error that keeps it from being read right now (`error`; a missing default file is not an error). Re-reads
    /// the files.
    pub fn sources(&self) -> Vec<KubeconfigSource> {
        let (_, errors) = self.load();
        let mut sources = self.listed_sources();
        for source in &mut sources {
            source.error = errors
                .iter()
                .find(|(id, _)| *id == source.id)
                .map(|(_, err)| err.clone());
        }
        sources
    }

    /// Every source without reading the files.
    fn listed_sources(&self) -> Vec<KubeconfigSource> {
        let mut sources = self.default_sources();
        for extra in &self.extra_sources {
            if !sources.iter().any(|s| s.path == extra.path) {
                sources.push(extra.clone());
            }
        }
        sources
    }

    /// Sources the user added or pasted — what the settings store.
    pub fn added_sources(&self) -> Vec<KubeconfigSource> {
        self.extra_sources.clone()
    }

    /// `KUBECONFIG` files, or `~/.kube/config` when the variable is unset or empty.
    fn default_sources(&self) -> Vec<KubeconfigSource> {
        let mut sources: Vec<KubeconfigSource> = Vec::new();
        if let Some(value) = &self.env.kubeconfig {
            for path in std::env::split_paths(value).filter(|p| !p.as_os_str().is_empty()) {
                if !sources.iter().any(|s| s.path == path) {
                    sources.push(source(path, SourceKind::Env));
                }
            }
        }
        if sources.is_empty()
            && let Some(home) = &self.env.home
        {
            sources.push(source(
                home.join(".kube").join("config"),
                SourceKind::Default,
            ));
        }
        sources
    }

    /// Reads every source. `KUBECONFIG` files are merged the way kubectl does (the first file to define a name
    /// wins), so a context may use a user from another file of the list. A missing default file is skipped
    /// quietly; every other source that cannot be read or merged is skipped and its error is returned with its
    /// source id.
    fn load(&self) -> (Vec<Loaded>, Vec<(String, CoreError)>) {
        let mut loaded = Vec::new();
        let mut errors: Vec<(String, CoreError)> = Vec::new();
        let mut env_merged: Option<Kubeconfig> = None;
        let mut env_files: Vec<(KubeconfigSource, Kubeconfig)> = Vec::new();

        for src in self.listed_sources() {
            let is_default = matches!(src.kind, SourceKind::Default | SourceKind::Env);
            if is_default && !src.path.exists() {
                continue;
            }
            let config = match Kubeconfig::read_from(&src.path) {
                Ok(config) => config,
                Err(err) => {
                    errors.push((src.id.clone(), kubeconfig_error(err)));
                    continue;
                }
            };
            if src.kind == SourceKind::Env {
                match env_merged.take() {
                    None => env_merged = Some(config.clone()),
                    Some(merged) => match merged.clone().merge(config.clone()) {
                        Ok(next) => env_merged = Some(next),
                        Err(err) => {
                            errors.push((src.id.clone(), kubeconfig_error(err)));
                            env_merged = Some(merged);
                            continue;
                        }
                    },
                }
                env_files.push((src, config));
            } else {
                loaded.push(Loaded {
                    source: src,
                    own: config.clone(),
                    resolve: config,
                });
            }
        }

        // Contexts belong to the first `KUBECONFIG` file that defines them; names resolve in the merged config.
        if let Some(merged) = env_merged {
            let mut seen = std::collections::HashSet::new();
            let mut env_loaded = Vec::new();
            for (src, mut own) in env_files {
                own.contexts.retain(|c| seen.insert(c.name.clone()));
                env_loaded.push(Loaded {
                    source: src,
                    own,
                    resolve: merged.clone(),
                });
            }
            loaded.splice(0..0, env_loaded);
        }
        (loaded, errors)
    }

    /// Re-reads the files and lists every context. Fails only when no context could be listed and a source has an
    /// error (that error); otherwise the errors are on [`Self::sources`].
    pub fn clusters(&self) -> CoreResult<Vec<ClusterInfo>> {
        let (loaded, errors) = self.load();
        let clusters: Vec<ClusterInfo> = loaded.iter().flat_map(Loaded::clusters).collect();
        match errors.into_iter().next() {
            Some((_, err)) if clusters.is_empty() => Err(err),
            _ => Ok(clusters),
        }
    }

    /// Adds a kubeconfig file chosen by the user. The file must parse and have at least one context.
    /// Adding a file that is already a source returns that source.
    pub fn add_file(&mut self, path: PathBuf) -> CoreResult<KubeconfigSource> {
        let path = std::fs::canonicalize(&path).map_err(|e| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("cannot open {}: {e}", path.display()),
            )
        })?;
        if let Some(existing) = self.listed_sources().into_iter().find(|s| s.path == path) {
            return Ok(existing);
        }
        let config = Kubeconfig::read_from(&path).map_err(kubeconfig_error)?;
        ensure_contexts(&config)?;
        let added = source(path, SourceKind::AddedFile);
        self.extra_sources.push(added.clone());
        Ok(added)
    }

    /// Saves pasted kubeconfig text to the data directory (mode 0600) and adds it as a source.
    pub fn add_pasted(&mut self, text: &str) -> CoreResult<KubeconfigSource> {
        let config = Kubeconfig::from_yaml(text).map_err(kubeconfig_error)?;
        ensure_contexts(&config)?;

        std::fs::create_dir_all(&self.pasted_dir)?;
        let mut file = tempfile::Builder::new()
            .prefix("pasted-")
            .suffix(".yaml")
            .tempfile_in(&self.pasted_dir)?;
        restrict_permissions(file.path())?;
        file.write_all(text.as_bytes())?;
        file.as_file().sync_all()?;
        let (_, path) = file.keep().map_err(|e| CoreError::from(e.error))?;

        let added = source(path, SourceKind::Pasted);
        self.extra_sources.push(added.clone());
        Ok(added)
    }

    /// Merges the contexts of `entries` (with their clusters and users) into Sextant's own kubeconfig `file_name` in
    /// the data directory (mode 0600) and registers that file as a [`SourceKind::Cloud`] source (once). Entries with
    /// the same names are replaced, so importing a cluster again does not add a second context. `file_name` is a bare
    /// file name (`cloud-aws.yaml`).
    pub fn add_cloud(
        &mut self,
        file_name: &str,
        entries: &Kubeconfig,
    ) -> CoreResult<KubeconfigSource> {
        let bare = Path::new(file_name)
            .file_name()
            .is_some_and(|name| name == std::ffi::OsStr::new(file_name));
        let stem = file_name.strip_suffix(".yaml").unwrap_or_default();
        if !bare
            || stem.is_empty()
            || !stem
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Err(CoreError::new(
                ErrorCode::Invalid,
                format!("not a kubeconfig file name: {file_name:?}"),
            ));
        }
        ensure_contexts(entries)?;

        let path = self.pasted_dir.join(file_name);
        let mut config = if path.exists() {
            Kubeconfig::read_from(&path).map_err(kubeconfig_error)?
        } else {
            Kubeconfig {
                api_version: Some("v1".to_owned()),
                kind: Some("Config".to_owned()),
                ..Default::default()
            }
        };
        for named in &entries.contexts {
            config.contexts.retain(|c| c.name != named.name);
        }
        for named in &entries.clusters {
            config.clusters.retain(|c| c.name != named.name);
        }
        for named in &entries.auth_infos {
            config.auth_infos.retain(|u| u.name != named.name);
        }
        config.contexts.extend(entries.contexts.iter().cloned());
        config.clusters.extend(entries.clusters.iter().cloned());
        config.auth_infos.extend(entries.auth_infos.iter().cloned());
        if config.current_context.is_none() {
            config.current_context = config.contexts.first().map(|c| c.name.clone());
        }

        // A new private file next to the old one, then renamed over it: a crash never leaves half a kubeconfig.
        std::fs::create_dir_all(&self.pasted_dir)?;
        let yaml = serde_yaml::to_string(&config)?;
        let mut file = tempfile::Builder::new()
            .prefix(".cloud-")
            .suffix(".yaml")
            .tempfile_in(&self.pasted_dir)?;
        restrict_permissions(file.path())?;
        file.write_all(yaml.as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(&path).map_err(|e| CoreError::from(e.error))?;

        if let Some(existing) = self.listed_sources().into_iter().find(|s| s.path == path) {
            return Ok(existing);
        }
        let added = source(path, SourceKind::Cloud);
        self.extra_sources.push(added.clone());
        Ok(added)
    }

    /// Forgets an added, pasted or cloud source; a pasted or cloud file (Sextant's own copy) is deleted. `KUBECONFIG` and `~/.kube/config` cannot
    /// be removed.
    pub fn remove_source(&mut self, source_id: &str) -> CoreResult<()> {
        let Some(index) = self.extra_sources.iter().position(|s| s.id == source_id) else {
            return Err(
                if self.default_sources().iter().any(|s| s.id == source_id) {
                    CoreError::new(
                        ErrorCode::Invalid,
                        "KUBECONFIG and ~/.kube/config cannot be removed",
                    )
                } else {
                    CoreError::new(ErrorCode::NotFound, "no such kubeconfig source")
                },
            );
        };
        let removed = self.extra_sources.remove(index);
        let own_file = matches!(removed.kind, SourceKind::Pasted | SourceKind::Cloud);
        if own_file && removed.path.starts_with(&self.pasted_dir) {
            match std::fs::remove_file(&removed.path) {
                Err(err) if err.kind() != std::io::ErrorKind::NotFound => return Err(err.into()),
                _ => {}
            }
        }
        Ok(())
    }

    /// A kubeconfig with just this context, `current-context` set to it.
    pub fn kubeconfig_for(&self, id: &ClusterId) -> CoreResult<Kubeconfig> {
        let (loaded, _) = self.load();
        for entry in &loaded {
            for ctx in &entry.own.contexts {
                if ClusterId::for_context(&entry.source.path, &ctx.name) == *id {
                    return Ok(single_context(&entry.resolve, &ctx.name));
                }
            }
        }
        Err(CoreError::new(
            ErrorCode::NotFound,
            "the cluster is no longer in the kubeconfig; refresh the list",
        ))
    }

    /// SHA-256 (lowercase hex) of the certificate authority the cluster entry of `id` trusts now
    /// ([`certificate_authority_sha256_of`]).
    pub fn certificate_authority_sha256(&self, id: &ClusterId) -> CoreResult<Option<String>> {
        certificate_authority_sha256_of(&self.kubeconfig_for(id)?)
    }

    /// The [`ServerBinding`] the cluster entry of `id` gives now ([`ServerBinding::of`]).
    pub fn server_binding(&self, id: &ClusterId) -> CoreResult<ServerBinding> {
        ServerBinding::of(&self.kubeconfig_for(id)?)
    }

    /// Writes [`Self::kubeconfig_for`] to a temporary file with mode 0600 (for the terminal and `helm`), named
    /// [`TEMP_KUBECONFIG_PREFIX`]`<pid>-*` (this process's ID) in the system temp directory.
    pub fn write_temp_kubeconfig(&self, id: &ClusterId) -> CoreResult<tempfile::TempPath> {
        let config = self.kubeconfig_for(id)?;
        let yaml = serde_yaml::to_string(&config)?;
        let prefix = format!("{TEMP_KUBECONFIG_PREFIX}{}-", std::process::id());
        let mut file = tempfile::Builder::new()
            .prefix(&prefix)
            .suffix(".yaml")
            .tempfile()?;
        restrict_permissions(file.path())?;
        file.write_all(yaml.as_bytes())?;
        file.as_file().sync_all()?;
        Ok(file.into_temp_path())
    }
}

/// Name prefix of the temporary kubeconfig files ([`KubeconfigRegistry::write_temp_kubeconfig`]).
pub const TEMP_KUBECONFIG_PREFIX: &str = "sextant-kubeconfig-";

/// How old a temporary kubeconfig without a PID in its name (written by Sextant before 0.6) must be to be removed.
const OLD_TEMP_KUBECONFIG_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Removes temporary kubeconfig files left in `dir` by a Sextant that did not exit cleanly (a crash, a killed
/// process): [`TEMP_KUBECONFIG_PREFIX`]`<pid>-*` of a process that no longer runs — another running Sextant keeps its
/// files — and, of the older names without a PID, those older than a day. Only regular files of the current user are
/// touched; when it cannot be told whether a process runs, its files stay. Returns how many were removed. Called once
/// at start with [`std::env::temp_dir`].
pub fn remove_stale_temp_kubeconfigs(dir: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let Some(owner) = current_owner(dir) else {
        return 0;
    };
    let mut alive: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    let now = std::time::SystemTime::now();
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix(TEMP_KUBECONFIG_PREFIX)?.to_owned();
            // `DirEntry::metadata` does not follow symlinks: a link is never a regular file here.
            let meta = entry.metadata().ok()?;
            (meta.is_file() && owner.owns(&meta)).then_some((entry.path(), rest, meta))
        })
        .filter(|(_, rest, meta)| match temp_kubeconfig_pid(rest) {
            Some(pid) => !*alive.entry(pid).or_insert_with(|| process_runs(pid)),
            None => meta
                .modified()
                .ok()
                .and_then(|at| now.duration_since(at).ok())
                .is_some_and(|age| age > OLD_TEMP_KUBECONFIG_AGE),
        })
        .filter(|(path, _, _)| std::fs::remove_file(path).is_ok())
        .count()
}

/// The PID in a temporary kubeconfig's name after [`TEMP_KUBECONFIG_PREFIX`] (`<pid>-<random>`); `None` for the older
/// names without one (`<random>`, letters and digits only).
fn temp_kubeconfig_pid(rest: &str) -> Option<u32> {
    let (pid, _) = rest.split_once('-')?;
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    pid.parse().ok()
}

/// Whether a process with `pid` runs (whatever program it is). `true` when that cannot be told, so nothing of a live
/// process is ever removed.
fn process_runs(pid: u32) -> bool {
    pid == std::process::id() || os_process_runs(pid).unwrap_or(true)
}

/// `kill(pid, 0)` (no process is started, no signal is sent): `ESRCH` — no such process. `EPERM` — a process of
/// another user has this PID, so it is not the Sextant that wrote this user's file, which has exited: counted as not
/// running (the meaning `kill -0` had before). Any other error tells nothing.
#[cfg(unix)]
fn os_process_runs(pid: u32) -> Option<bool> {
    use rustix::io::Errno;
    let pid = rustix::process::Pid::from_raw(i32::try_from(pid).ok()?)?;
    match rustix::process::test_kill_process(pid) {
        Ok(()) => Some(true),
        Err(Errno::SRCH | Errno::PERM) => Some(false),
        Err(_) => None,
    }
}

/// `OpenProcess` (no process is started): no such PID — it does not run; access denied — some process (of another
/// user or protected) has it, so it runs; a handle — it runs until it has an exit code. A process whose exit code is
/// `STILL_ACTIVE` (259) counts as running. Any other failure tells nothing.
#[cfg(windows)]
fn os_process_runs(pid: u32) -> Option<bool> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: a plain query with no pointers; the returned handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        // SAFETY: reads this thread's last error, set by the failed `OpenProcess` above.
        return match unsafe { GetLastError() } {
            ERROR_INVALID_PARAMETER => Some(false),
            ERROR_ACCESS_DENIED => Some(true),
            _ => None,
        };
    }
    let mut code = 0u32;
    // SAFETY: `handle` is a live process handle and `code` a valid place for the exit code.
    let read = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    // SAFETY: `handle` was opened above and is closed once.
    unsafe { CloseHandle(handle) };
    read.then_some(code == STILL_ACTIVE as u32)
}

/// Elsewhere nothing tells whether another process runs.
#[cfg(not(any(unix, windows)))]
fn os_process_runs(_pid: u32) -> Option<bool> {
    None
}

/// Who the current user is, as file ownership in `dir` sees it.
#[cfg(unix)]
struct Owner(u32);

#[cfg(unix)]
impl Owner {
    fn owns(&self, meta: &std::fs::Metadata) -> bool {
        use std::os::unix::fs::MetadataExt;
        meta.uid() == self.0
    }
}

/// The owner of a file this process creates in `dir` (its effective user), without calling into libc. `None` when
/// nothing can be created there — then nothing could be removed either.
#[cfg(unix)]
fn current_owner(dir: &Path) -> Option<Owner> {
    use std::os::unix::fs::MetadataExt;
    let probe = tempfile::tempfile_in(dir).ok()?;
    Some(Owner(probe.metadata().ok()?.uid()))
}

/// On Windows the temp directory (`%TEMP%`, in the user's profile) belongs to the user: everything in it is theirs.
#[cfg(not(unix))]
struct Owner;

#[cfg(not(unix))]
impl Owner {
    fn owns(&self, _meta: &std::fs::Metadata) -> bool {
        true
    }
}

#[cfg(not(unix))]
fn current_owner(_dir: &Path) -> Option<Owner> {
    Some(Owner)
}

/// One readable source: its own contexts, and the config their names resolve in.
struct Loaded {
    source: KubeconfigSource,
    own: Kubeconfig,
    resolve: Kubeconfig,
}

impl Loaded {
    fn clusters(&self) -> Vec<ClusterInfo> {
        self.own
            .contexts
            .iter()
            .map(|named| {
                let ctx = named.context.clone().unwrap_or_default();
                let server = self
                    .resolve
                    .clusters
                    .iter()
                    .find(|c| c.name == ctx.cluster)
                    .and_then(|c| c.cluster.as_ref())
                    .and_then(|c| c.server.clone())
                    .unwrap_or_default();
                ClusterInfo {
                    id: ClusterId::for_context(&self.source.path, &named.name),
                    context: named.name.clone(),
                    cluster_name: ctx.cluster,
                    server,
                    user: ctx.user.unwrap_or_default(),
                    namespace: ctx.namespace,
                    source_id: self.source.id.clone(),
                }
            })
            .collect()
    }
}

fn source(path: PathBuf, kind: SourceKind) -> KubeconfigSource {
    KubeconfigSource {
        id: short_hash(normalized_path(&path).as_os_str().as_encoded_bytes()),
        path,
        kind,
        error: None,
    }
}

fn ensure_contexts(config: &Kubeconfig) -> CoreResult<()> {
    if config.contexts.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Kubeconfig,
            "the kubeconfig has no contexts",
        ));
    }
    Ok(())
}

/// `config` reduced to one context, its cluster and its user. Missing references are left out; connecting
/// then reports them.
fn single_context(config: &Kubeconfig, context: &str) -> Kubeconfig {
    let named = config.contexts.iter().find(|c| c.name == context).cloned();
    let (cluster, user) = named
        .as_ref()
        .and_then(|n| n.context.as_ref())
        .map(|c| (Some(c.cluster.clone()), c.user.clone()))
        .unwrap_or_default();
    Kubeconfig {
        api_version: Some("v1".to_owned()),
        kind: Some("Config".to_owned()),
        clusters: config
            .clusters
            .iter()
            .filter(|c| Some(&c.name) == cluster.as_ref())
            .cloned()
            .collect(),
        auth_infos: config
            .auth_infos
            .iter()
            .filter(|u| Some(&u.name) == user.as_ref())
            .cloned()
            .collect(),
        contexts: named.into_iter().collect(),
        current_context: Some(context.to_owned()),
        ..Default::default()
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> CoreResult<()> {
    // Files in the user's profile and temp directory are private to the user on Windows.
    Ok(())
}

/// The path as it is hashed into ids, so the same file gets the same id however its path arrived (`KUBECONFIG`,
/// `~/.kube/config`, a canonicalized added file): redundant separators and `.` components are dropped, and on
/// Windows `/` becomes `\`, a verbatim prefix (`\\?\C:\`, what `canonicalize` returns) becomes a plain one and the
/// drive letter is upper-cased. `..` is kept: without touching the file system it cannot be resolved.
fn normalized_path(path: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(d) | Prefix::VerbatimDisk(d) => {
                    out.push(format!("{}:", char::from(d.to_ascii_uppercase())));
                }
                Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                    out.push(format!(
                        r"\\{}\{}",
                        server.to_string_lossy(),
                        share.to_string_lossy()
                    ));
                }
                _ => out.push(component.as_os_str()),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The API server a kubeconfig cluster entry names, as a saved Argo CD login is bound to it (#109): the entry's
/// `server` (without a trailing `/`) and the SHA-256 of the certificate authority it trusts
/// ([`certificate_authority_sha256_of`], `None` when it names none — then the URL alone is the binding). Taken from the
/// kubeconfig a connection is made with ([`crate::ClusterManager::server_binding`]); serialized `{"server","caSha256"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerBinding {
    pub server: String,
    pub ca_sha256: Option<String>,
}

impl ServerBinding {
    /// The binding of the (only, or first) cluster of `config` — a [`KubeconfigRegistry::kubeconfig_for`] result.
    /// A CA that cannot be read or an entry without a server is an error.
    pub fn of(config: &Kubeconfig) -> CoreResult<Self> {
        let server = config
            .clusters
            .first()
            .and_then(|c| c.cluster.as_ref())
            .and_then(|c| c.server.as_deref())
            .map(|s| s.trim().trim_end_matches('/'))
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::Kubeconfig,
                    "the kubeconfig cluster has no server",
                )
            })?;
        Ok(Self {
            server: server.to_owned(),
            ca_sha256: certificate_authority_sha256_of(config)?,
        })
    }
}

/// SHA-256 (lowercase hex) of the certificate authority the (only, or first) cluster of `config` trusts —
/// `certificate-authority-data`, else the file `certificate-authority` names — taken over the DER bytes of its PEM
/// certificates, so another spelling of the same certificates hashes the same (over the bytes as they are when they
/// hold no PEM certificate). `None` when the entry names no CA (the system's roots, or `insecure-skip-tls-verify`); a
/// CA that cannot be read is an error, never `None`.
pub fn certificate_authority_sha256_of(config: &Kubeconfig) -> CoreResult<Option<String>> {
    use base64::Engine as _;
    let Some(cluster) = config.clusters.first().and_then(|c| c.cluster.as_ref()) else {
        return Ok(None);
    };
    let unreadable = || {
        CoreError::new(
            ErrorCode::Kubeconfig,
            "the certificate authority of the kubeconfig cluster cannot be read",
        )
    };
    let bytes = match (
        &cluster.certificate_authority_data,
        &cluster.certificate_authority,
    ) {
        (Some(data), _) => base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|_| unreadable())?,
        (None, Some(file)) => std::fs::read(file).map_err(|_| unreadable())?,
        (None, None) => return Ok(None),
    };
    let certificates = pem_certificates(&bytes);
    let mut digest = Sha256::new();
    if certificates.is_empty() {
        digest.update(&bytes);
    } else {
        for der in &certificates {
            digest.update(der);
        }
    }
    Ok(Some(
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    ))
}

/// The DER bytes of every `CERTIFICATE` block of PEM text, in order; a block that is not base64 is skipped.
fn pem_certificates(bytes: &[u8]) -> Vec<Vec<u8>> {
    use base64::Engine as _;
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let text = String::from_utf8_lossy(bytes);
    let mut rest = text.as_ref();
    let mut out = Vec::new();
    while let Some(start) = rest.find(BEGIN) {
        let body = &rest[start + BEGIN.len()..];
        let Some(end) = body.find(END) else {
            break;
        };
        let compact: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
        if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(compact) {
            out.push(der);
        }
        rest = &body[end + END.len()..];
    }
    out
}

/// First 16 hex digits of sha256.
fn short_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Maps a kubeconfig error without quoting the file: a YAML parse error would otherwise show the offending line,
/// which may hold a token or a key.
pub fn kubeconfig_error(err: KubeconfigError) -> CoreError {
    let message = match &err {
        KubeconfigError::Parse(parse) => match parse.location() {
            Some(loc) => format!(
                "the kubeconfig is not valid YAML (line {}, column {})",
                loc.line(),
                loc.column()
            ),
            None => "the kubeconfig is not valid YAML".to_owned(),
        },
        other => other.to_string(),
    };
    CoreError::new(ErrorCode::Kubeconfig, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A process that runs until killed (`long`) or one that exits at once.
    fn spawn_process(long: bool) -> std::process::Child {
        use std::process::{Command, Stdio};
        #[cfg(unix)]
        let mut command = if long {
            let mut c = Command::new("sleep");
            c.arg("60");
            c
        } else {
            Command::new("true")
        };
        #[cfg(windows)]
        let mut command = {
            let mut c = Command::new("cmd");
            c.args([
                "/C",
                if long {
                    "ping -n 60 127.0.0.1"
                } else {
                    "exit 0"
                },
            ]);
            c
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    /// The PID of a process that has exited and been reaped.
    fn exited_pid() -> u32 {
        let mut child = spawn_process(false);
        child.wait().unwrap();
        child.id()
    }

    #[test]
    fn only_temp_kubeconfigs_of_dead_processes_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let mut running = spawn_process(true);
        let exited = exited_pid();
        let day_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(25 * 3600);
        let write = |name: &str| {
            let path = dir.path().join(name);
            std::fs::write(&path, "token: leaked").unwrap();
            path
        };
        let stale = [
            write(&format!("sextant-kubeconfig-{exited}-abc123.yaml")),
            write(&format!("sextant-kubeconfig-{exited}-x")),
        ];
        // The old name without a PID: removed only once it is older than a day.
        let old_format = write("sextant-kubeconfig-AbC123.yaml");
        std::fs::File::options()
            .write(true)
            .open(&old_format)
            .unwrap()
            .set_modified(day_ago)
            .unwrap();
        let kept_files = [
            // This process and another running Sextant.
            write(&format!(
                "sextant-kubeconfig-{}-abc123.yaml",
                std::process::id()
            )),
            write(&format!("sextant-kubeconfig-{}-def456.yaml", running.id())),
            write("sextant-kubeconfig-XyZ789.yaml"),
            write("other-kubeconfig-abc.yaml"),
            write("my-sextant-kubeconfig-1.yaml"),
        ];
        let kept_dir = dir.path().join(format!("sextant-kubeconfig-{exited}-dir"));
        std::fs::create_dir(&kept_dir).unwrap();

        let removed = remove_stale_temp_kubeconfigs(dir.path());
        let _ = running.kill();
        let _ = running.wait();

        for path in stale.iter().chain([&old_format]) {
            assert!(!path.exists(), "{} was left", path.display());
        }
        for path in &kept_files {
            assert!(path.exists(), "{} was removed", path.display());
        }
        assert!(kept_dir.is_dir(), "directories are not touched");
        assert_eq!(removed, 3);
        // A missing directory is nothing to clean.
        assert_eq!(
            remove_stale_temp_kubeconfigs(&dir.path().join("missing")),
            0
        );
    }

    const SECRET_TOKEN: &str = "s3cr3t-t0ken-value";

    /// Two contexts: `alpha` (token) and `beta` (inline client certificate), `alpha` is current.
    fn two_contexts() -> String {
        format!(
            r#"apiVersion: v1
kind: Config
clusters:
  - name: alpha-cluster
    cluster:
      server: https://alpha.example:6443
      insecure-skip-tls-verify: true
  - name: beta-cluster
    cluster:
      server: https://beta.example:6443
users:
  - name: alpha-user
    user:
      token: {SECRET_TOKEN}
  - name: beta-user
    user:
      client-certificate-data: Y2VydA==
      client-key-data: a2V5
contexts:
  - name: alpha
    context:
      cluster: alpha-cluster
      user: alpha-user
      namespace: team-a
  - name: beta
    context:
      cluster: beta-cluster
      user: beta-user
current-context: alpha
"#
        )
    }

    fn one_context(name: &str, server: &str) -> String {
        format!(
            r#"apiVersion: v1
kind: Config
clusters:
  - name: {name}-cluster
    cluster:
      server: {server}
users:
  - name: {name}-user
    user:
      username: admin
      password: hunter2
contexts:
  - name: {name}
    context:
      cluster: {name}-cluster
      user: {name}-user
current-context: {name}
"#
        )
    }

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        /// `name` is a `/`-separated relative path; it is split so the result is built with the OS separator,
        /// the way the code under test builds its own paths.
        fn path(&self, name: &str) -> PathBuf {
            name.split('/')
                .fold(self.dir.path().to_path_buf(), |path, part| path.join(part))
        }

        fn write(&self, name: &str, text: &str) -> PathBuf {
            let path = self.path(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            path
        }

        fn home(&self) -> PathBuf {
            self.path("home")
        }

        /// A registry without `KUBECONFIG`, home in the temp dir.
        fn registry(&self) -> KubeconfigRegistry {
            self.registry_with(Vec::new(), None)
        }

        fn registry_with(
            &self,
            extra: Vec<KubeconfigSource>,
            kubeconfig: Option<OsString>,
        ) -> KubeconfigRegistry {
            KubeconfigRegistry::new(extra, self.path("data/kubeconfigs")).with_env(KubeconfigEnv {
                kubeconfig,
                home: Some(self.home()),
            })
        }
    }

    fn contexts(clusters: &[ClusterInfo]) -> Vec<&str> {
        clusters.iter().map(|c| c.context.as_str()).collect()
    }

    #[test]
    fn the_certificate_authority_of_an_entry_is_hashed_over_its_certificates() {
        use base64::Engine as _;
        let fx = Fixture::new();
        let b64 = |v: &[u8]| base64::engine::general_purpose::STANDARD.encode(v);
        // Two PEM spellings of one certificate (DER bytes "ca-der"): other line breaks, a missing final newline.
        let pem = format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            b64(b"ca-der")
        );
        let respelled = format!(
            "-----BEGIN CERTIFICATE-----\r\n{}\r\n-----END CERTIFICATE-----",
            b64(b"ca-der")
        );
        fx.write("ca.crt", &respelled);
        let ca_file = fx.path("ca.crt");
        let kubeconfig = format!(
            r#"apiVersion: v1
kind: Config
clusters:
  - name: data
    cluster: {{ server: "https://a.example:6443", certificate-authority-data: "{data}" }}
  - name: file
    cluster: {{ server: "https://a.example:6443", certificate-authority: "{file}" }}
  - name: other
    cluster: {{ server: "https://a.example:6443", certificate-authority-data: "{other}" }}
  - name: none
    cluster: {{ server: "https://a.example:6443" }}
  - name: missing
    cluster: {{ server: "https://a.example:6443", certificate-authority: "{missing}" }}
users:
  - name: me
    user: {{}}
contexts:
  - {{ name: data, context: {{ cluster: data, user: me }} }}
  - {{ name: file, context: {{ cluster: file, user: me }} }}
  - {{ name: other, context: {{ cluster: other, user: me }} }}
  - {{ name: none, context: {{ cluster: none, user: me }} }}
  - {{ name: missing, context: {{ cluster: missing, user: me }} }}
"#,
            data = b64(pem.as_bytes()),
            file = ca_file.display().to_string().replace('\\', "/"),
            other = b64(format!(
                "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
                b64(b"other")
            )
            .as_bytes()),
            missing = fx
                .path("nowhere.crt")
                .display()
                .to_string()
                .replace('\\', "/"),
        );
        let path = fx.write("home/.kube/config", &kubeconfig);
        let registry = fx.registry();
        let ca = |context: &str| {
            registry.certificate_authority_sha256(&ClusterId::for_context(&path, context))
        };
        // printf 'ca-der' | sha256sum
        let data = ca("data").unwrap().unwrap();
        assert_eq!(
            data,
            "9e7d0b95ce1401718101be73ed16d45f90f75aa5beea977101f24860ce2c8a9b"
        );
        assert_eq!(ca("file").unwrap().as_deref(), Some(data.as_str()));
        assert_ne!(ca("other").unwrap().as_deref(), Some(data.as_str()));
        assert_eq!(ca("none").unwrap(), None);
        assert!(ca("missing").is_err(), "an unreadable CA is not \"no CA\"");
        assert!(ca("gone").is_err());
    }

    #[test]
    fn cluster_id_is_sha256_of_path_and_context() {
        // The hashed path is normalized: `/tmp/a` stays as is on Unix and becomes `\tmp\a` on Windows.
        // Unix:    printf '/tmp/a\0ctx' | sha256sum | cut -c1-16
        // Windows: printf '\\tmp\\a\0ctx' | sha256sum | cut -c1-16
        let expected = if cfg!(windows) {
            "5f4ba2ecb318bd7d"
        } else {
            "e3b2065058c31c9b"
        };
        assert_eq!(
            ClusterId::for_context(Path::new("/tmp/a"), "ctx").as_str(),
            expected
        );
    }

    #[test]
    fn cluster_id_does_not_depend_on_how_the_path_is_spelled() {
        let plain = ClusterId::for_context(Path::new("/tmp/a/kube"), "ctx");
        assert_eq!(
            ClusterId::for_context(Path::new("/tmp//a/./kube"), "ctx"),
            plain
        );
        assert_eq!(
            ClusterId::for_context(&Path::new("/tmp").join("a").join("kube"), "ctx"),
            plain
        );
        assert_ne!(
            ClusterId::for_context(Path::new("/tmp/a/other"), "ctx"),
            plain
        );
        assert_ne!(
            ClusterId::for_context(Path::new("/tmp/a/kube"), "other"),
            plain
        );
    }

    #[cfg(windows)]
    #[test]
    fn cluster_id_is_the_same_for_slashes_verbatim_prefix_and_drive_case() {
        let backslash = ClusterId::for_context(Path::new(r"C:\Users\me\.kube\config"), "ctx");
        for spelling in [
            "C:/Users/me/.kube/config",
            r"C:\Users/me\.kube/config",
            r"c:\Users\me\.kube\config",
            r"\\?\C:\Users\me\.kube\config",
        ] {
            assert_eq!(
                ClusterId::for_context(Path::new(spelling), "ctx"),
                backslash,
                "{spelling}"
            );
        }
    }

    #[test]
    fn default_kubeconfig_lists_every_context_with_stable_ids() {
        let fx = Fixture::new();
        let path = fx.write("home/.kube/config", &two_contexts());

        let first = fx.registry().clusters().unwrap();
        assert_eq!(contexts(&first), ["alpha", "beta"]);
        let alpha = &first[0];
        assert_eq!(alpha.cluster_name, "alpha-cluster");
        assert_eq!(alpha.server, "https://alpha.example:6443");
        assert_eq!(alpha.user, "alpha-user");
        assert_eq!(alpha.namespace.as_deref(), Some("team-a"));
        assert_eq!(alpha.id, ClusterId::for_context(&path, "alpha"));
        assert_eq!(first[1].namespace, None);

        // A new registry (an application restart) gives the same ids.
        let second = fx.registry().clusters().unwrap();
        assert_eq!(first, second);

        let sources = fx.registry().sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].kind, SourceKind::Default);
        assert_eq!(sources[0].path, path);
        assert_eq!(alpha.source_id, sources[0].id);
    }

    #[test]
    fn kubeconfig_env_lists_contexts_of_every_file_and_ignores_the_default() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &one_context("ignored", "https://x:1"));
        let a = fx.write("a.yaml", &one_context("one", "https://one:6443"));
        let b = fx.write("b.yaml", &one_context("two", "https://two:6443"));
        let env = std::env::join_paths([&a, &b]).unwrap();

        let registry = fx.registry_with(Vec::new(), Some(env));
        let clusters = registry.clusters().unwrap();
        assert_eq!(contexts(&clusters), ["one", "two"]);
        let sources = registry.sources();
        assert_eq!(
            sources
                .iter()
                .map(|s| (&s.path, s.kind))
                .collect::<Vec<_>>(),
            [(&a, SourceKind::Env), (&b, SourceKind::Env)]
        );
        assert_ne!(clusters[0].source_id, clusters[1].source_id);
        assert_eq!(clusters[1].id, ClusterId::for_context(&b, "two"));
    }

    #[test]
    fn kubeconfig_env_context_may_use_a_user_from_another_file() {
        let fx = Fixture::new();
        let users = fx.write(
            "users.yaml",
            "apiVersion: v1\nkind: Config\nusers:\n  - name: shared\n    user:\n      token: abc\n",
        );
        let ctx = fx.write(
            "ctx.yaml",
            "apiVersion: v1\nkind: Config\nclusters:\n  - name: c\n    cluster:\n      server: https://c:6443\ncontexts:\n  - name: cross\n    context:\n      cluster: c\n      user: shared\n",
        );
        let env = std::env::join_paths([&users, &ctx]).unwrap();
        let registry = fx.registry_with(Vec::new(), Some(env));
        let clusters = registry.clusters().unwrap();
        assert_eq!(contexts(&clusters), ["cross"]);
        let kc = registry.kubeconfig_for(&clusters[0].id).unwrap();
        assert_eq!(kc.auth_infos.len(), 1);
        assert_eq!(kc.auth_infos[0].name, "shared");
    }

    #[test]
    fn missing_default_file_gives_no_clusters_but_lists_the_checked_path() {
        let fx = Fixture::new();
        let registry = fx.registry();
        assert_eq!(registry.clusters().unwrap(), []);
        let sources = registry.sources();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, fx.home().join(".kube").join("config"));
        assert_eq!(sources[0].kind, SourceKind::Default);
    }

    #[test]
    fn added_file_gives_clusters_survives_restart_and_is_removed() {
        let fx = Fixture::new();
        let file = fx.write("extra/team.yaml", &two_contexts());
        let mut registry = fx.registry();

        let source = registry.add_file(file.clone()).unwrap();
        assert_eq!(source.kind, SourceKind::AddedFile);
        assert_eq!(source.path, file.canonicalize().unwrap());
        assert_eq!(contexts(&registry.clusters().unwrap()), ["alpha", "beta"]);
        assert_eq!(registry.added_sources(), vec![source.clone()]);

        // Adding the same file again does not duplicate it.
        assert_eq!(registry.add_file(file.clone()).unwrap(), source);
        assert_eq!(registry.added_sources().len(), 1);

        // Restart: the settings hand the saved sources back.
        let mut restarted = fx.registry_with(registry.added_sources(), None);
        assert_eq!(contexts(&restarted.clusters().unwrap()), ["alpha", "beta"]);

        restarted.remove_source(&source.id).unwrap();
        assert_eq!(restarted.clusters().unwrap(), []);
        assert!(restarted.added_sources().is_empty());
        assert!(
            file.exists(),
            "removing an added file keeps the user's file"
        );
    }

    /// A kubeconfig of one cloud cluster `name` (exec authentication, no credentials), as the cloud import builds it.
    fn cloud_entry(name: &str, server: &str) -> Kubeconfig {
        Kubeconfig::from_yaml(&format!(
            r#"apiVersion: v1
kind: Config
clusters:
  - name: {name}
    cluster:
      server: {server}
      certificate-authority-data: Y2E=
users:
  - name: {name}
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args: [eks, get-token, --cluster-name, {name}, --region, eu-west-1, --output, json]
contexts:
  - name: {name}
    context:
      cluster: {name}
      user: {name}
"#
        ))
        .unwrap()
    }

    #[test]
    fn cloud_clusters_go_to_one_private_file_and_a_second_import_replaces_the_context() {
        let fx = Fixture::new();
        let home_config = fx.write(
            "home/.kube/config",
            &one_context("home", "https://home:6443"),
        );
        let before = std::fs::read_to_string(&home_config).unwrap();
        let mut registry = fx.registry();

        let source = registry
            .add_cloud("cloud-aws.yaml", &cloud_entry("eks-a", "https://a.example"))
            .unwrap();
        assert_eq!(source.kind, SourceKind::Cloud);
        assert_eq!(source.path, fx.path("data/kubeconfigs/cloud-aws.yaml"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&source.path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let again = registry
            .add_cloud("cloud-aws.yaml", &cloud_entry("eks-b", "https://b.example"))
            .unwrap();
        assert_eq!(again, source, "the same file is one source");
        // Importing eks-a again (its endpoint changed) replaces it.
        registry
            .add_cloud(
                "cloud-aws.yaml",
                &cloud_entry("eks-a", "https://a2.example"),
            )
            .unwrap();

        let clusters = registry.clusters().unwrap();
        assert_eq!(contexts(&clusters), ["home", "eks-b", "eks-a"]);
        let a = clusters.iter().find(|c| c.context == "eks-a").unwrap();
        assert_eq!(a.server, "https://a2.example");
        assert_eq!(a.id, ClusterId::for_context(&source.path, "eks-a"));
        let config = registry.kubeconfig_for(&a.id).unwrap();
        let exec = config.auth_infos[0]
            .auth_info
            .as_ref()
            .unwrap()
            .exec
            .as_ref()
            .unwrap();
        assert_eq!(exec.command.as_deref(), Some("aws"));
        assert_eq!(registry.added_sources(), std::slice::from_ref(&source));
        assert_eq!(
            std::fs::read_to_string(&home_config).unwrap(),
            before,
            "~/.kube/config is not touched"
        );

        let restarted = fx.registry_with(registry.added_sources(), None);
        assert_eq!(
            contexts(&restarted.clusters().unwrap()),
            ["home", "eks-b", "eks-a"]
        );

        registry.remove_source(&source.id).unwrap();
        assert!(
            !source.path.exists(),
            "removing the source deletes Sextant's own file"
        );
        assert_eq!(contexts(&registry.clusters().unwrap()), ["home"]);
    }

    #[test]
    fn a_cloud_file_name_must_be_a_bare_yaml_name() {
        let fx = Fixture::new();
        let mut registry = fx.registry();
        for name in ["../cloud.yaml", "a/b.yaml", "", "cloud-aws", ".yaml"] {
            let err = registry
                .add_cloud(name, &cloud_entry("x", "https://x"))
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid, "{name}");
        }
        let empty = Kubeconfig::default();
        assert_eq!(
            registry
                .add_cloud("cloud-aws.yaml", &empty)
                .unwrap_err()
                .code,
            ErrorCode::Kubeconfig
        );
        assert!(registry.added_sources().is_empty());
    }

    #[test]
    fn pasted_text_is_stored_privately_in_the_data_dir_and_deleted_on_remove() {
        let fx = Fixture::new();
        let mut registry = fx.registry();
        let source = registry.add_pasted(&two_contexts()).unwrap();
        assert_eq!(source.kind, SourceKind::Pasted);
        assert!(source.path.starts_with(fx.path("data/kubeconfigs")));
        assert_eq!(
            std::fs::read_to_string(&source.path).unwrap(),
            two_contexts()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&source.path)
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert_eq!(contexts(&registry.clusters().unwrap()), ["alpha", "beta"]);

        let restarted = fx.registry_with(registry.added_sources(), None);
        assert_eq!(contexts(&restarted.clusters().unwrap()), ["alpha", "beta"]);

        registry.remove_source(&source.id).unwrap();
        assert!(!source.path.exists());
        assert_eq!(registry.clusters().unwrap(), []);
    }

    #[test]
    fn invalid_kubeconfig_gives_code_kubeconfig_without_quoting_the_text() {
        let fx = Fixture::new();
        let mut registry = fx.registry();
        let broken =
            format!("users:\n  - name: u\n    user:\n      token: {SECRET_TOKEN}\n  bad: [\n");
        let err = registry.add_pasted(&broken).unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "{err}");
        assert!(!err.message.contains(SECRET_TOKEN), "{err}");

        let file = fx.write("broken.yaml", &broken);
        let err = registry.add_file(file).unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "{err}");
        assert!(!err.message.contains(SECRET_TOKEN), "{err}");

        let err = registry
            .add_pasted("apiVersion: v1\nkind: Config\n")
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig, "no contexts: {err}");
        assert!(registry.added_sources().is_empty());
    }

    #[test]
    fn a_broken_file_does_not_hide_the_others_but_alone_is_an_error() {
        let fx = Fixture::new();
        let good = fx.write("good.yaml", &one_context("good", "https://g:6443"));
        let bad = fx.write("bad.yaml", "clusters: [\n");
        let env = std::env::join_paths([&bad, &good]).unwrap();
        let clusters = fx.registry_with(Vec::new(), Some(env)).clusters().unwrap();
        assert_eq!(contexts(&clusters), ["good"]);

        let env = std::env::join_paths([&bad]).unwrap();
        let err = fx
            .registry_with(Vec::new(), Some(env))
            .clusters()
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Kubeconfig);
    }

    #[test]
    fn a_broken_file_in_kubeconfig_is_reported_on_its_source_while_the_good_one_works() {
        let fx = Fixture::new();
        let good = fx.write("good.yaml", &one_context("good", "https://g:6443"));
        let bad = fx.write("bad.yaml", "clusters: [\n");
        let env = std::env::join_paths([&bad, &good]).unwrap();
        let registry = fx.registry_with(Vec::new(), Some(env));

        let clusters = registry.clusters().unwrap();
        assert_eq!(contexts(&clusters), ["good"]);
        registry
            .kubeconfig_for(&clusters[0].id)
            .expect("the good cluster can be connected");

        let sources = registry.sources();
        let of = |path: &PathBuf| sources.iter().find(|s| &s.path == path).unwrap();
        let error = of(&bad)
            .error
            .clone()
            .expect("the broken file has an error");
        assert_eq!(error.code, ErrorCode::Kubeconfig, "{error}");
        assert_eq!(of(&good).error, None);
    }

    #[test]
    fn an_added_file_that_broke_or_vanished_is_reported_on_its_source() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &one_context("home", "https://h:6443"));
        let broken = fx.write("team.yaml", &two_contexts());
        let gone = fx.write("gone.yaml", &one_context("gone", "https://x:6443"));
        let mut registry = fx.registry();
        let broken_source = registry.add_file(broken.clone()).unwrap();
        let gone_source = registry.add_file(gone.clone()).unwrap();
        std::fs::write(&broken, format!("users: [\n  token: {SECRET_TOKEN}\n")).unwrap();
        std::fs::remove_file(&gone).unwrap();

        assert_eq!(contexts(&registry.clusters().unwrap()), ["home"]);
        let sources = registry.sources();
        let error_of = |id: &str| {
            sources
                .iter()
                .find(|s| s.id == id)
                .and_then(|s| s.error.clone())
        };
        let broken_error = error_of(&broken_source.id).expect("broken file has an error");
        assert!(
            !broken_error.message.contains(SECRET_TOKEN),
            "{broken_error}"
        );
        assert!(
            error_of(&gone_source.id).is_some(),
            "a vanished file has an error"
        );
        assert_eq!(sources[0].kind, SourceKind::Default);
        assert_eq!(sources[0].error, None);
        // The settings store the sources without their current errors.
        assert!(registry.added_sources().iter().all(|s| s.error.is_none()));
    }

    #[test]
    fn a_missing_default_file_is_not_an_error() {
        let fx = Fixture::new();
        assert_eq!(fx.registry().sources()[0].error, None);
    }

    #[test]
    fn default_sources_cannot_be_removed() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &two_contexts());
        let mut registry = fx.registry();
        let id = registry.sources()[0].id.clone();
        assert_eq!(
            registry.remove_source(&id).unwrap_err().code,
            ErrorCode::Invalid
        );
        assert_eq!(
            registry.remove_source("nope").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn kubeconfig_for_holds_only_that_context_and_selects_it() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &two_contexts());
        let registry = fx.registry();
        let beta = registry.clusters().unwrap()[1].id.clone();

        let kc = registry.kubeconfig_for(&beta).unwrap();
        assert_eq!(kc.current_context.as_deref(), Some("beta"));
        assert_eq!(kc.contexts.len(), 1);
        assert_eq!(kc.contexts[0].name, "beta");
        assert_eq!(kc.clusters.len(), 1);
        assert_eq!(kc.clusters[0].name, "beta-cluster");
        assert_eq!(kc.auth_infos.len(), 1);
        assert_eq!(kc.auth_infos[0].name, "beta-user");

        let err = registry
            .kubeconfig_for(&ClusterId::from("0000"))
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn temp_kubeconfig_is_private_and_points_at_the_cluster() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &two_contexts());
        let registry = fx.registry();
        let alpha = registry.clusters().unwrap()[0].id.clone();

        let temp = registry.write_temp_kubeconfig(&alpha).unwrap();
        let name = temp.file_name().unwrap().to_string_lossy().into_owned();
        let own = format!("sextant-kubeconfig-{}-", std::process::id());
        assert!(
            name.starts_with(&own),
            "{name}: the name carries this process's PID"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&temp).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let kc = Kubeconfig::read_from(&temp).unwrap();
        assert_eq!(kc.current_context.as_deref(), Some("alpha"));
        assert_eq!(kc.contexts.len(), 1);
        let token = kc.auth_infos[0].auth_info.as_ref().unwrap().token.as_ref();
        assert!(
            token.is_some(),
            "credentials are written to the private file"
        );

        let path = temp.to_path_buf();
        drop(temp);
        assert!(!path.exists(), "the file is removed with the handle");
    }

    #[test]
    fn cluster_list_never_carries_credentials() {
        let fx = Fixture::new();
        fx.write("home/.kube/config", &two_contexts());
        let json = serde_json::to_string(&fx.registry().clusters().unwrap()).unwrap();
        assert!(!json.contains(SECRET_TOKEN));
        assert!(!json.contains("a2V5"));
        assert!(!json.contains("Y2VydA=="));
    }
}
