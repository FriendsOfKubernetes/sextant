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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct KubeconfigSource {
    pub id: String,
    pub path: PathBuf,
    pub kind: SourceKind,
}

/// Stable cluster id: hex `sha256(source path + "\0" + context)[..16]`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClusterId(pub String);

impl ClusterId {
    /// The id of `context` in the kubeconfig file at `source_path`.
    pub fn for_context(source_path: &Path, context: &str) -> Self {
        let mut bytes = source_path.as_os_str().as_encoded_bytes().to_vec();
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

    /// Every source, the checked default locations first (they are listed even when the file is missing).
    pub fn sources(&self) -> Vec<KubeconfigSource> {
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
    /// quietly; an unreadable added file is reported only when nothing else could be read.
    fn load(&self) -> (Vec<Loaded>, Option<CoreError>) {
        let mut loaded = Vec::new();
        let mut first_error = None;
        let mut env_merged: Option<Kubeconfig> = None;
        let mut env_files: Vec<(KubeconfigSource, Kubeconfig)> = Vec::new();

        for src in self.sources() {
            let is_default = matches!(src.kind, SourceKind::Default | SourceKind::Env);
            if is_default && !src.path.exists() {
                continue;
            }
            let config = match Kubeconfig::read_from(&src.path) {
                Ok(config) => config,
                Err(err) => {
                    first_error.get_or_insert_with(|| kubeconfig_error(err));
                    continue;
                }
            };
            if src.kind == SourceKind::Env {
                env_merged = Some(match env_merged.take() {
                    None => config.clone(),
                    Some(merged) => match merged.clone().merge(config.clone()) {
                        Ok(next) => next,
                        Err(err) => {
                            first_error.get_or_insert_with(|| kubeconfig_error(err));
                            merged
                        }
                    },
                });
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
        (loaded, first_error)
    }

    /// Re-reads the files and lists every context.
    pub fn clusters(&self) -> CoreResult<Vec<ClusterInfo>> {
        let (loaded, first_error) = self.load();
        let clusters: Vec<ClusterInfo> = loaded.iter().flat_map(Loaded::clusters).collect();
        match first_error {
            Some(err) if clusters.is_empty() => Err(err),
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
        if let Some(existing) = self.sources().into_iter().find(|s| s.path == path) {
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

    /// Forgets an added or pasted source; a pasted file is deleted. `KUBECONFIG` and `~/.kube/config` cannot
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
        if removed.kind == SourceKind::Pasted && removed.path.starts_with(&self.pasted_dir) {
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

    /// Writes [`Self::kubeconfig_for`] to a temporary file with mode 0600 (for the terminal and `helm`).
    pub fn write_temp_kubeconfig(&self, id: &ClusterId) -> CoreResult<tempfile::TempPath> {
        let config = self.kubeconfig_for(id)?;
        let yaml = serde_yaml::to_string(&config)?;
        let mut file = tempfile::Builder::new()
            .prefix("sextant-kubeconfig-")
            .suffix(".yaml")
            .tempfile()?;
        restrict_permissions(file.path())?;
        file.write_all(yaml.as_bytes())?;
        file.as_file().sync_all()?;
        Ok(file.into_temp_path())
    }
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
        id: short_hash(path.as_os_str().as_encoded_bytes()),
        path,
        kind,
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

        fn path(&self, name: &str) -> PathBuf {
            self.dir.path().join(name)
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
    fn cluster_id_is_sha256_of_path_and_context() {
        // printf '/tmp/a\0ctx' | sha256sum | cut -c1-16
        assert_eq!(
            ClusterId::for_context(Path::new("/tmp/a"), "ctx").as_str(),
            "e3b2065058c31c9b"
        );
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
