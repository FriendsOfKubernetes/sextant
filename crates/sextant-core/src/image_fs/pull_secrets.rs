//! A pod's image and the pull secrets that may open it: the pod's `imagePullSecrets`, then its ServiceAccount's
//! (ADR-0103). The Secrets are read here only for this; their values become [`DockerConfig`]s that never leave the
//! backend, and the Secret objects are dropped at once.

use std::time::Duration;

use k8s_openapi::api::core::v1::{Pod, Secret, ServiceAccount};
use kube::Api;

use super::auth::{Credential, DockerConfig};
use super::invalid;
use crate::{ClusterId, ClusterManager, CoreError, CoreResult, ErrorCode};

/// One request to the API server.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Pull secrets read at most (the pod's and its ServiceAccount's together).
const MAX_PULL_SECRETS: usize = 16;

/// A readable pull secret: its name and what it holds.
#[derive(Debug, Clone)]
pub struct PullSecret {
    pub name: String,
    pub config: DockerConfig,
}

/// A container's image in a pod.
#[derive(Debug, Clone)]
pub struct PodImage {
    /// `spec.containers[].image` (or of an init or ephemeral container).
    pub image: String,
    /// The digest the node runs, from the container status' `imageID`, when it names one.
    pub digest: Option<String>,
    pub pull_secrets: Vec<PullSecret>,
    /// Pull secrets named but not readable (missing, forbidden, another type).
    pub unreadable: Vec<String>,
}

fn check_name(name: &str, what: &str) -> CoreResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'));
    if ok {
        Ok(())
    } else {
        Err(invalid(format!("{what} is not a valid name")))
    }
}

async fn timed<T>(what: &str, work: impl Future<Output = Result<T, kube::Error>>) -> CoreResult<T> {
    match tokio::time::timeout(REQUEST_TIMEOUT, work).await {
        Ok(result) => result.map_err(CoreError::from),
        Err(_) => Err(CoreError::new(
            ErrorCode::Timeout,
            format!("{what} took too long"),
        )),
    }
}

/// Reads the pod, finds `container`, and reads the pull secrets that may apply.
pub async fn pod_image(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    namespace: &str,
    pod: &str,
    container: &str,
) -> CoreResult<PodImage> {
    check_name(namespace, "the namespace")?;
    check_name(pod, "the pod")?;
    let client = mgr.client(cluster)?;
    let object = timed(
        "reading the pod",
        Api::<Pod>::namespaced(client.clone(), namespace).get(pod),
    )
    .await?;
    let spec = object
        .spec
        .as_ref()
        .ok_or_else(|| CoreError::new(ErrorCode::NotFound, "the pod has no spec"))?;
    let image = spec
        .containers
        .iter()
        .chain(spec.init_containers.iter().flatten())
        .find(|c| c.name == container)
        .and_then(|c| c.image.clone())
        .or_else(|| {
            spec.ephemeral_containers
                .iter()
                .flatten()
                .find(|c| c.name == container)
                .and_then(|c| c.image.clone())
        })
        .ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("the pod has no container {container}"),
            )
        })?;
    let digest = object.status.as_ref().and_then(|status| {
        status
            .container_statuses
            .iter()
            .flatten()
            .chain(status.init_container_statuses.iter().flatten())
            .chain(status.ephemeral_container_statuses.iter().flatten())
            .find(|s| s.name == container)
            .and_then(|s| super::reference::digest_of_image_id(&s.image_id))
    });

    let mut names: Vec<String> = spec
        .image_pull_secrets
        .iter()
        .flatten()
        .map(|r| r.name.clone())
        .collect();
    let account = spec
        .service_account_name
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_owned());
    if check_name(&account, "the ServiceAccount").is_ok()
        && let Ok(sa) = timed(
            "reading the ServiceAccount",
            Api::<ServiceAccount>::namespaced(client.clone(), namespace).get(&account),
        )
        .await
    {
        names.extend(sa.image_pull_secrets.into_iter().flatten().map(|r| r.name));
    }
    let mut seen = std::collections::HashSet::new();
    names.retain(|n| seen.insert(n.clone()));
    names.truncate(MAX_PULL_SECRETS);

    let secrets = Api::<Secret>::namespaced(client, namespace);
    let mut pull_secrets = Vec::new();
    let mut unreadable = Vec::new();
    for name in names {
        if check_name(&name, "a pull secret").is_err() {
            continue;
        }
        let config = match timed("reading a pull secret", secrets.get(&name)).await {
            Ok(secret) => docker_config_of(secret),
            Err(_) => None,
        };
        match config {
            Some(config) => pull_secrets.push(PullSecret { name, config }),
            None => unreadable.push(name),
        }
    }
    Ok(PodImage {
        image,
        digest,
        pull_secrets,
        unreadable,
    })
}

/// The Docker config in a Secret of type `kubernetes.io/dockerconfigjson` or `kubernetes.io/dockercfg`; the Secret is
/// consumed so nothing else of it is kept.
fn docker_config_of(secret: Secret) -> Option<DockerConfig> {
    let key = match secret.type_.as_deref() {
        Some("kubernetes.io/dockerconfigjson") => ".dockerconfigjson",
        Some("kubernetes.io/dockercfg") => ".dockercfg",
        _ => return None,
    };
    let data = secret.data?;
    let bytes = data.get(key)?;
    DockerConfig::parse(&bytes.0).ok()
}

/// The first pull secret with credentials for `registry` (a registry key), and its name.
pub fn credential_for(secrets: &[PullSecret], registry: &str) -> Option<(String, Credential)> {
    secrets
        .iter()
        .find_map(|s| s.config.auth_for(registry).map(|c| (s.name.clone(), c)))
}
