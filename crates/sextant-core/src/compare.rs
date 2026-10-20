//! Comparing objects across clusters and namespaces (#156). Read-only, and a window feature only: neither the MCP
//! server nor the extension API offers any of it.
//!
//! Most of the comparison is in the frontend (normalising objects, ignore paths, the side-by-side diff); the core
//! does only what the frontend must not see or should not fetch one request at a time:
//!
//! - [`compare_secrets`] and [`compare_secret_namespaces`]: which keys two Secrets have and whether each value is the
//!   same, by SHA-256 of the values computed here. Neither the values nor their hashes leave the core (a hash of a
//!   short value is as good as the value), only `{key, onLeft, onRight, equal}`.
//! - [`list_namespace`]: bounded lists of a namespace's objects of some kinds (without `status`, a Secret without its
//!   values), for comparing two namespaces.
//! - [`helm_drift`]: a Helm release's stored manifest (the latest readable revision, as the release details read it)
//!   next to the live objects it names; a Secret of the manifest is compared by keys and value hashes only.

mod drift;
mod lists;
mod secrets;
#[cfg(test)]
mod tests;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

pub use drift::{DriftObject, HelmDrift, MAX_DRIFT_OBJECTS, helm_drift};
// The Helm revision comparison (`helm::revisions`, #209) reads manifests and Secrets the same way.
pub(crate) use drift::manifest_objects;
pub use lists::{CompareKindList, MAX_COMPARE_KINDS, MAX_COMPARE_LIMIT, list_namespace};
pub use secrets::{
    MAX_COMPARED_SECRETS, NamedSecretComparison, SecretComparison, SecretKeyComparison,
    SecretNamespaceComparison, SecretSideState, compare_secret_namespaces, compare_secrets,
};
pub(crate) use secrets::{compare_keys, value_hashes};

/// One side of a Secret comparison: a Secret in a cluster, or (`lastApplied`) the values of its
/// `kubectl.kubernetes.io/last-applied-configuration` annotation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretSide {
    pub cluster_id: ClusterId,
    pub namespace: String,
    pub name: String,
    #[serde(default)]
    pub last_applied: bool,
}

/// One side of a namespace comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NamespaceSide {
    pub cluster_id: ClusterId,
    pub namespace: String,
}

/// A namespace name as Kubernetes accepts it (a DNS label).
pub(crate) fn check_namespace(namespace: &str) -> CoreResult<()> {
    let ok = !namespace.is_empty()
        && namespace.len() <= 63
        && namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !namespace.starts_with('-')
        && !namespace.ends_with('-');
    if ok {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{namespace:?} is not a namespace name"),
        ))
    }
}

/// An object name as Kubernetes accepts it (a DNS subdomain, which also covers the names of DNS labels).
pub(crate) fn check_name(name: &str) -> CoreResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 253
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.ends_with(|c: char| c.is_ascii_alphanumeric());
    if ok {
        Ok(())
    } else {
        Err(CoreError::new(
            ErrorCode::Invalid,
            format!("{name:?} is not an object name"),
        ))
    }
}
