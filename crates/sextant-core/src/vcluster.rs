//! vcluster (#269, ADR-0122): connecting to a virtual cluster through its host cluster, as `vcluster connect` does.
//!
//! A vcluster is a Helm release on the host cluster: its control plane is a StatefulSet or Deployment labelled
//! `app=vcluster,release=<name>` (chart `chart/templates/statefulset.yaml`; the CLI finds instances by that label in
//! `pkg/cli/find/find.go` `findInContext`), and its syncer writes the virtual cluster's admin kubeconfig into the Secret
//! `vc-<name>` of the same namespace under the key `config` (`pkg/util/kubeconfig/kubeconfig.go`: `DefaultSecretPrefix`,
//! `KubeconfigSecretKey`). Its server is `https://localhost:8443`: the CLI (`pkg/cli/connect_helm.go`
//! `getVClusterKubeConfig`, `portForwardServer`, `serverPort`) forwards a local port to the newest vcluster pod's
//! port 8443 and rewrites the server to `https://localhost:<local port>` — the serving certificate names `localhost`
//! and `127.0.0.1` (`pkg/server/cert/cert.go`).
//!
//! Sextant does the same on a click: [`read_kubeconfig`] reads the Secret with the user's credentials and keeps only
//! what a connection needs (no file, no exec plugin, no proxy: the Secret is cluster content, never a reason to run or
//! read anything here); [`forward_target`] picks the vcluster's Service (port 443 → 8443) or, without one, its newest
//! pod; the Tauri layer forwards through the host cluster and writes [`VirtualKubeconfig::kubeconfig`] with the
//! forward's port into this process's own file `vcluster-<pid>.yaml` ([`save`]), one context per virtual cluster named
//! as the CLI names it ([`context_name`]), with an id that does not depend on the PID ([`cluster_id`]). Nothing of the
//! Secret ever leaves the core except into that 0600 file, which goes when its last entry goes, when the process
//! closes ([`forget_own`]) or, after a crash, at the next start ([`forget_earlier_runs`]); errors never quote it.

use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Secret, Service};
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Api;
use kube::api::ListParams;
use kube::config::{
    AuthInfo, Cluster, Context, Kubeconfig, NamedAuthInfo, NamedCluster, NamedContext,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode, kube_error, with_timeout};
use crate::kubeconfig::{ClusterId, KubeconfigRegistry, KubeconfigSource, SourceKind};
use crate::portforward::ForwardTarget;

/// The kubeconfig Secret is `vc-<name>` (`pkg/util/kubeconfig/kubeconfig.go` `DefaultSecretPrefix`).
pub const SECRET_PREFIX: &str = "vc-";
/// The Secret's key holding the kubeconfig (`KubeconfigSecretKey`).
pub const SECRET_KEY: &str = "config";
/// Label of the control plane, its pods and its Service (`chart/templates/statefulset.yaml`, `service.yaml`).
pub const APP_LABEL: &str = "app";
pub const APP_VALUE: &str = "vcluster";
/// The release (= vcluster) name label (`pkg/util/translate/types.go` `VClusterReleaseLabel`).
pub const RELEASE_LABEL: &str = "release";
/// On every object the syncer copies to the host (`pkg/util/translate/types.go` `MarkerLabel`): a pod of the virtual
/// cluster that happens to carry `app=vcluster` is never taken for the control plane.
pub const MANAGED_BY_LABEL: &str = "vcluster.loft.sh/managed-by";
/// Where the vcluster pod serves the API (`serverPort`: an implicit port means 8443).
pub const DEFAULT_REMOTE_PORT: u16 = 8443;
/// Sextant's own kubeconfig file of the virtual clusters this process forwards for, in the app data directory's
/// `kubeconfigs/`: `vcluster-<pid>.yaml` ([`file_name`]). One per process, so a second Sextant (a development build
/// beside the installed one shares the directory) never touches another's entries, and a file is known to be left
/// over once its process is gone ([`forget_earlier_runs`]).
pub const FILE_PREFIX: &str = "vcluster-";
/// The name a virtual cluster's [`ClusterId`] is made from (with its context name, [`cluster_id`]): the same in every
/// run and process, so its cluster settings come back when it is connected again. Also the single file earlier builds
/// wrote, removed at start.
pub const ID_FILE_NAME: &str = "vcluster.yaml";
/// The forward listens here ([`crate::portforward`] binds `127.0.0.1`).
pub const FORWARD_HOST: &str = "127.0.0.1";
/// The name the certificate is checked against when the Secret names none: every vcluster serving certificate has it
/// (`pkg/server/cert/cert.go`), and it is what the CLI connects to.
pub const TLS_SERVER_NAME: &str = "localhost";
/// A kubeconfig larger than this in the Secret is refused before parsing.
pub const MAX_CONFIG_BYTES: usize = 256 * 1024;
/// One request to the host cluster.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A virtual cluster Sextant forwards for: the entry in [`FILE_NAME`] (`cluster_id`, `context`) and where it comes
/// from. Carries no credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct VclusterLink {
    /// The virtual cluster's entry in the cluster list.
    pub cluster_id: ClusterId,
    pub context: String,
    /// The host cluster the forward goes through.
    pub host_cluster_id: ClusterId,
    pub namespace: String,
    pub name: String,
    pub local_port: u16,
    pub forward_id: String,
}

/// A DNS-1123 label: at most 63 lowercase letters, digits and `-`, starting and ending alphanumeric.
pub(crate) fn is_dns_label(s: &str) -> bool {
    let bytes = s.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        && bytes[0].is_ascii_alphanumeric()
        && bytes[bytes.len() - 1].is_ascii_alphanumeric()
}

/// The namespace and the vcluster's name (a Helm release name, used as a label value and in `vc-<name>`) must be
/// DNS-1123 labels; checked before any request.
pub fn validate_target(namespace: &str, name: &str) -> CoreResult<()> {
    if !is_dns_label(namespace) {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a namespace is a DNS-1123 label (lowercase letters, digits and '-')",
        ));
    }
    if !is_dns_label(name) || name.len() + SECRET_PREFIX.len() > 253 {
        return Err(CoreError::new(
            ErrorCode::Invalid,
            "a vcluster's name is a DNS-1123 label (lowercase letters, digits and '-')",
        ));
    }
    Ok(())
}

/// `vc-<name>`.
pub fn secret_name(name: &str) -> String {
    format!("{SECRET_PREFIX}{name}")
}

/// The context name `vcluster connect` gives: `vcluster_<name>_<namespace>_<host context>` (`pkg/cli/find/find.go`
/// `VClusterContextName`).
pub fn context_name(name: &str, namespace: &str, host_context: &str) -> String {
    format!("vcluster_{name}_{namespace}_{host_context}")
}

/// What a connection to the virtual cluster needs, taken from its Secret: the cluster's certificate authority and TLS
/// settings, the user's client certificate, key or token, and the port the vcluster pod serves on. Never printed.
#[derive(Clone)]
pub struct VirtualKubeconfig {
    context: String,
    remote_port: u16,
    cluster: Cluster,
    user: AuthInfo,
    namespace: Option<String>,
}

impl std::fmt::Debug for VirtualKubeconfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VirtualKubeconfig")
            .field("context", &self.context)
            .field("remote_port", &self.remote_port)
            .finish_non_exhaustive()
    }
}

impl VirtualKubeconfig {
    pub fn context(&self) -> &str {
        &self.context
    }

    /// The port inside the vcluster pod the API is served on.
    pub fn remote_port(&self) -> u16 {
        self.remote_port
    }

    /// The kubeconfig of one context named [`Self::context`] (its cluster and user named the same, as the CLI's
    /// `exchangeContextName` does) whose server is the local forward `https://127.0.0.1:<local_port>`; the certificate
    /// is checked against the Secret's `tls-server-name`, else [`TLS_SERVER_NAME`].
    pub fn kubeconfig(&self, local_port: u16) -> Kubeconfig {
        let name = self.context.clone();
        let cluster = Cluster {
            server: Some(format!("https://{FORWARD_HOST}:{local_port}")),
            ..self.cluster.clone()
        };
        Kubeconfig {
            api_version: Some("v1".to_owned()),
            kind: Some("Config".to_owned()),
            clusters: vec![NamedCluster {
                name: name.clone(),
                cluster: Some(cluster),
                ..Default::default()
            }],
            auth_infos: vec![NamedAuthInfo {
                name: name.clone(),
                auth_info: Some(self.user.clone()),
                ..Default::default()
            }],
            contexts: vec![NamedContext {
                name: name.clone(),
                context: Some(Context {
                    cluster: name.clone(),
                    user: Some(name.clone()),
                    namespace: self.namespace.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            }],
            current_context: Some(name),
            ..Default::default()
        }
    }
}

fn unusable(reason: &str) -> CoreError {
    CoreError::new(
        ErrorCode::Kubeconfig,
        format!("the vcluster's kubeconfig cannot be used: {reason}"),
    )
}

/// The port of the Secret's server: its explicit port, else 8443 for `https`/`http` (`serverPort`: an implicit port
/// is a Service's or an ingress's, never the pod's).
pub fn server_port(server: &str) -> CoreResult<u16> {
    let uri: http::Uri = server
        .trim()
        .parse()
        .map_err(|_| unusable("its server is not a URL"))?;
    match uri.scheme_str() {
        Some("https" | "http") => {}
        _ => return Err(unusable("its server is not an https URL")),
    }
    if uri.host().is_none_or(str::is_empty) {
        return Err(unusable("its server has no host"));
    }
    Ok(uri.port_u16().unwrap_or(DEFAULT_REMOTE_PORT))
}

/// Reads the kubeconfig text of a vcluster Secret (pure: the tests feed it fixtures). Exactly one cluster, as the CLI
/// requires; the context `current-context` names (else the first) and its user. Kept: the cluster's
/// `certificate-authority-data`, `insecure-skip-tls-verify` and `tls-server-name`, the user's
/// `client-certificate-data`, `client-key-data` and `token`, the context's namespace. Refused: anything that names a
/// file (of the vcluster pod's disk, never this computer's), an exec plugin or an auth provider (a Secret never makes
/// Sextant run a program). A `proxy-url` and every other field are dropped. Errors never quote the text.
pub fn parse_kubeconfig(bytes: &[u8], context: &str) -> CoreResult<VirtualKubeconfig> {
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err(unusable("it is too large"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| unusable("it is not text"))?;
    let config = Kubeconfig::from_yaml(text).map_err(|_| unusable("it is not a kubeconfig"))?;
    if config.clusters.len() != 1 {
        return Err(unusable("it does not name exactly one cluster"));
    }
    let named = config
        .current_context
        .as_ref()
        .and_then(|current| config.contexts.iter().find(|c| &c.name == current))
        .or_else(|| config.contexts.first());
    let ctx = named.and_then(|n| n.context.clone()).unwrap_or_default();
    let source = config.clusters[0].cluster.clone().unwrap_or_default();
    let server = source
        .server
        .as_deref()
        .ok_or_else(|| unusable("its cluster has no server"))?;
    let remote_port = server_port(server)?;
    if source.certificate_authority.is_some() {
        return Err(unusable("it names a certificate authority file"));
    }
    let user = ctx
        .user
        .as_ref()
        .and_then(|name| config.auth_infos.iter().find(|u| &u.name == name))
        .or_else(|| config.auth_infos.first())
        .and_then(|u| u.auth_info.clone())
        .ok_or_else(|| unusable("it has no user"))?;
    if user.exec.is_some() || user.auth_provider.is_some() {
        return Err(unusable("its user signs in through a program"));
    }
    if user.client_certificate.is_some() || user.client_key.is_some() || user.token_file.is_some() {
        return Err(unusable("its user names credential files"));
    }
    if user.client_certificate_data.is_none() && user.token.is_none() {
        return Err(unusable("its user has no client certificate or token"));
    }
    Ok(VirtualKubeconfig {
        context: context.to_owned(),
        remote_port,
        cluster: Cluster {
            certificate_authority_data: source.certificate_authority_data,
            insecure_skip_tls_verify: source.insecure_skip_tls_verify,
            tls_server_name: Some(
                source
                    .tls_server_name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| TLS_SERVER_NAME.to_owned()),
            ),
            ..Default::default()
        },
        user: AuthInfo {
            client_certificate_data: user.client_certificate_data,
            client_key_data: user.client_key_data,
            token: user.token,
            ..Default::default()
        },
        namespace: ctx.namespace.filter(|ns| is_dns_label(ns)),
    })
}

/// Overwrites bytes before they are dropped (best effort, as `tls.rs` does).
fn wipe_bytes(bytes: &mut [u8]) {
    bytes.fill(0);
    std::hint::black_box(&*bytes);
}

/// Reads `vc-<name>` in `namespace` with the user's own credentials (it needs `get` on that Secret) and parses its
/// `config` ([`parse_kubeconfig`]); every value of the Secret is overwritten as soon as it is read. No permission is a
/// `forbidden` error that says which Secret; a missing Secret or key is `notFound` (the vcluster may still be starting).
pub async fn read_kubeconfig(
    client: &kube::Client,
    namespace: &str,
    name: &str,
    host_context: &str,
) -> CoreResult<VirtualKubeconfig> {
    validate_target(namespace, name)?;
    let secret = secret_name(name);
    let read = with_timeout(REQUEST_TIMEOUT, "reading the vcluster's Secret", async {
        Api::<Secret>::namespaced(client.clone(), namespace)
            .get(&secret)
            .await
            .map_err(|e| kube_error(e, None))
    })
    .await;
    let mut object = match read {
        Ok(object) => object,
        Err(err) if err.code == ErrorCode::Forbidden => {
            return Err(CoreError::new(
                ErrorCode::Forbidden,
                format!(
                    "you may not read the Secret {namespace}/{secret}, which holds the vcluster's kubeconfig"
                ),
            ));
        }
        Err(err) if err.code == ErrorCode::NotFound => {
            return Err(CoreError::new(
                ErrorCode::NotFound,
                format!(
                    "the Secret {namespace}/{secret} does not exist yet; the vcluster may still be starting"
                ),
            ));
        }
        Err(err) => return Err(err),
    };
    let mut data = object.data.take().unwrap_or_default();
    let config = data.remove(SECRET_KEY);
    for value in data.values_mut() {
        wipe_bytes(&mut value.0);
    }
    for map in [
        object.metadata.annotations.as_mut(),
        object.string_data.as_mut(),
    ]
    .into_iter()
    .flatten()
    {
        for value in map.values_mut() {
            let mut bytes = std::mem::take(value).into_bytes();
            wipe_bytes(&mut bytes);
        }
    }
    let Some(mut config) = config else {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            format!("the Secret {namespace}/{secret} has no {SECRET_KEY} key"),
        ));
    };
    let parsed = parse_kubeconfig(&config.0, &context_name(name, namespace, host_context));
    wipe_bytes(&mut config.0);
    parsed
}

fn is_synced(labels: Option<&std::collections::BTreeMap<String, String>>) -> bool {
    labels.is_some_and(|l| l.contains_key(MANAGED_BY_LABEL))
}

/// What to forward to, and the port to ask for: the Service `<name>` (the chart's port 443 whose `targetPort` is the
/// pod's `remote_port`, or the one named `https`), which keeps working when the pod is replaced; without one, the
/// newest vcluster pod `app=vcluster,release=<name>` that is not being deleted, at `remote_port`, as the CLI does.
pub async fn forward_target(
    client: &kube::Client,
    namespace: &str,
    name: &str,
    remote_port: u16,
) -> CoreResult<(ForwardTarget, u16)> {
    validate_target(namespace, name)?;
    let service = with_timeout(REQUEST_TIMEOUT, "reading the vcluster's Service", async {
        match Api::<Service>::namespaced(client.clone(), namespace)
            .get_opt(name)
            .await
        {
            Ok(found) => Ok(found),
            Err(err) => {
                let err = kube_error(err, None);
                // Without the right to read Services, the pod is tried.
                if err.code == ErrorCode::Forbidden {
                    Ok(None)
                } else {
                    Err(err)
                }
            }
        }
    })
    .await?;
    if let Some(service) = service.filter(|s| !is_synced(s.metadata.labels.as_ref())) {
        let ports = service.spec.and_then(|s| s.ports).unwrap_or_default();
        let port = ports
            .iter()
            .find(|p| p.target_port == Some(IntOrString::Int(i32::from(remote_port))))
            .or_else(|| ports.iter().find(|p| p.name.as_deref() == Some("https")))
            .and_then(|p| u16::try_from(p.port).ok());
        if let Some(port) = port {
            return Ok((
                ForwardTarget::Service {
                    namespace: namespace.to_owned(),
                    name: name.to_owned(),
                },
                port,
            ));
        }
    }
    let selector = format!("{APP_LABEL}={APP_VALUE},{RELEASE_LABEL}={name}");
    let pods = with_timeout(REQUEST_TIMEOUT, "listing the vcluster's pods", async {
        Api::<Pod>::namespaced(client.clone(), namespace)
            .list(&ListParams::default().labels(&selector))
            .await
            .map_err(|e| kube_error(e, None))
    })
    .await?;
    let newest = pods
        .items
        .into_iter()
        .filter(|p| {
            p.metadata.deletion_timestamp.is_none() && !is_synced(p.metadata.labels.as_ref())
        })
        .max_by(|a, b| {
            a.metadata
                .creation_timestamp
                .cmp(&b.metadata.creation_timestamp)
                .then_with(|| a.metadata.name.cmp(&b.metadata.name))
        })
        .and_then(|p| p.metadata.name)
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("vcluster {namespace}/{name} has no running pod to connect through"),
            )
        })?;
    Ok((
        ForwardTarget::Pod {
            namespace: namespace.to_owned(),
            name: newest,
        },
        remote_port,
    ))
}

/// `vcluster-<pid>.yaml`: the file of the process `pid`.
pub fn file_name_of(pid: u32) -> String {
    format!("{FILE_PREFIX}{pid}.yaml")
}

/// This process's file ([`file_name_of`] its PID).
pub fn file_name() -> String {
    file_name_of(std::process::id())
}

/// The id of the virtual cluster entry `context` in `registry`: made from [`ID_FILE_NAME`], not from the per-process
/// file, so it is the same in every run (the registry lists the entry under it).
pub fn cluster_id(registry: &KubeconfigRegistry, context: &str) -> ClusterId {
    ClusterId::for_context(&registry.own_dir().join(ID_FILE_NAME), context)
}

/// Writes `config` (one virtual cluster's context) into this process's [`file_name`] (mode 0600, replacing an entry of
/// the same name) and lists the file as a [`SourceKind::Vcluster`] source once. The source is never stored in the
/// settings ([`KubeconfigRegistry::added_sources`] leaves it out): it lives as long as this process's forwards.
pub fn save(
    registry: &mut KubeconfigRegistry,
    config: &Kubeconfig,
) -> CoreResult<KubeconfigSource> {
    registry.write_own_file(&file_name(), config, SourceKind::Vcluster)
}

/// Removes these contexts from this process's file; the source and the file go with its last context.
pub fn remove(registry: &mut KubeconfigRegistry, contexts: &[String]) -> CoreResult<()> {
    registry
        .remove_own_contexts(&file_name(), SourceKind::Vcluster, contexts)
        .map(|_| ())
}

/// Removes this process's file and its source, whatever entries it holds (the window closing, the app exiting: the
/// forwards stop with it). Synchronous, so the credentials are off the disk before the process ends.
pub fn forget_own(registry: &mut KubeconfigRegistry) {
    let path = registry.own_dir().join(file_name());
    for source in registry.vcluster_sources() {
        if source.path == path {
            let _ = registry.remove_source(&source.id);
        }
    }
    let _ = std::fs::remove_file(&path);
}

/// At start: no forward of this process runs yet, so nothing of an earlier run of it can be reached. Removes the
/// [`SourceKind::Vcluster`] sources the settings still hold (earlier builds stored their single [`ID_FILE_NAME`] and
/// it goes with them), and every `vcluster-<pid>.yaml` in the directory whose process no longer runs — or that
/// carries this process's PID, left by an earlier process that had it. Another running Sextant's file stays, with its
/// entries. Whether the sources the settings store changed.
pub fn forget_earlier_runs(registry: &mut KubeconfigRegistry) -> bool {
    let stored = registry.vcluster_sources();
    for source in &stored {
        let _ = registry.remove_source(&source.id);
    }
    let dir = registry.own_dir().to_path_buf();
    let _ = std::fs::remove_file(dir.join(ID_FILE_NAME));
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(pid) = name
                .strip_prefix(FILE_PREFIX)
                .and_then(|rest| rest.strip_suffix(".yaml"))
                .filter(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|pid| pid.parse::<u32>().ok())
            else {
                continue;
            };
            let gone = pid == std::process::id() || !crate::kubeconfig::process_runs(pid);
            // `DirEntry::file_type` does not follow links: only a regular file is removed.
            if gone && entry.file_type().is_ok_and(|t| t.is_file()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    !stored.is_empty()
}

#[cfg(test)]
mod tests;
