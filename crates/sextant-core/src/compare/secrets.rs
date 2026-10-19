//! Secrets compared by key names and SHA-256 of their values, computed here: the values and their hashes never
//! leave the core.

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use k8s_openapi::api::core::v1::Secret;
use kube::Api;
use kube::api::ListParams;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::{NamespaceSide, SecretSide, check_name, check_namespace};
use crate::cluster::ClusterManager;
use crate::error::{CoreResult, with_timeout};
use crate::resources::{STEP_TIMEOUT, secret_values};

/// Secrets read per namespace when two namespaces are compared, at most.
pub const MAX_COMPARED_SECRETS: u32 = 500;

const LAST_APPLIED: &str = "kubectl.kubernetes.io/last-applied-configuration";

/// What one side of a Secret comparison found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum SecretSideState {
    Found,
    /// The Secret does not exist.
    Missing,
    /// The Secret exists but has no last-applied configuration (only for a `lastApplied` side).
    NoLastApplied,
}

/// One key of two Secrets: where it is, and whether the values are the same (only when it is on both sides).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretKeyComparison {
    pub key: String,
    pub on_left: bool,
    pub on_right: bool,
    pub equal: bool,
}

/// Two Secrets compared key by key, keys in name order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretComparison {
    pub left: SecretSideState,
    pub right: SecretSideState,
    pub keys: Vec<SecretKeyComparison>,
}

/// A Secret both namespaces have, compared key by key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NamedSecretComparison {
    pub name: String,
    pub keys: Vec<SecretKeyComparison>,
}

/// The Secrets both namespaces have, by name; `truncated` when a namespace holds more than
/// [`MAX_COMPARED_SECRETS`] Secrets (the rest are not compared).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretNamespaceComparison {
    pub secrets: Vec<NamedSecretComparison>,
    pub truncated: bool,
}

type Hashes = BTreeMap<String, [u8; 32]>;

/// SHA-256 of each value of `data` and `stringData` of a Secret (or of a manifest or last-applied document of one),
/// decoded from base64 where `data` holds base64.
pub(crate) fn value_hashes(fields: &Value) -> Hashes {
    let engine = base64::engine::general_purpose::STANDARD;
    secret_values(fields)
        .into_iter()
        .map(|(key, canonical)| {
            let bytes = engine
                .decode(&canonical)
                .unwrap_or_else(|_| canonical.into_bytes());
            (key, Sha256::digest(&bytes).into())
        })
        .collect()
}

/// Keys of both sides in name order; a side that is not there has no keys.
pub(crate) fn compare_keys(left: &Hashes, right: &Hashes) -> Vec<SecretKeyComparison> {
    let keys: BTreeSet<&String> = left.keys().chain(right.keys()).collect();
    keys.into_iter()
        .map(|key| {
            let (a, b) = (left.get(key), right.get(key));
            SecretKeyComparison {
                key: key.clone(),
                on_left: a.is_some(),
                on_right: b.is_some(),
                equal: matches!((a, b), (Some(a), Some(b)) if a == b),
            }
        })
        .collect()
}

/// The hashes of a Secret as Kubernetes stores it.
fn live_hashes(secret: &Secret) -> CoreResult<Hashes> {
    Ok(value_hashes(&serde_json::to_value(secret)?))
}

/// The hashes of the values in a Secret's last-applied configuration; `None` without one (or when it is not JSON).
fn last_applied_hashes(secret: &Secret) -> Option<Hashes> {
    let text = secret.metadata.annotations.as_ref()?.get(LAST_APPLIED)?;
    let doc: Value = serde_json::from_str(text).ok()?;
    doc.is_object().then(|| value_hashes(&doc))
}

async fn read_side(
    mgr: &ClusterManager,
    side: &SecretSide,
) -> CoreResult<(SecretSideState, Hashes)> {
    let client = mgr.client(&side.cluster_id)?;
    let api: Api<Secret> = Api::namespaced(client, &side.namespace);
    let found = with_timeout(STEP_TIMEOUT, "reading the Secret", async {
        Ok(api.get_opt(&side.name).await?)
    })
    .await?;
    let Some(secret) = found else {
        return Ok((SecretSideState::Missing, Hashes::new()));
    };
    if side.last_applied {
        return Ok(match last_applied_hashes(&secret) {
            Some(hashes) => (SecretSideState::Found, hashes),
            None => (SecretSideState::NoLastApplied, Hashes::new()),
        });
    }
    Ok((SecretSideState::Found, live_hashes(&secret)?))
}

fn check_side(side: &SecretSide) -> CoreResult<()> {
    check_namespace(&side.namespace)?;
    check_name(&side.name)
}

/// Two Secrets (each in its own cluster, or one's last-applied configuration) compared key by key. A cluster that
/// is not connected is an error; nothing is connected here.
pub async fn compare_secrets(
    mgr: &ClusterManager,
    left: &SecretSide,
    right: &SecretSide,
) -> CoreResult<SecretComparison> {
    check_side(left)?;
    check_side(right)?;
    mgr.client(&left.cluster_id)?;
    mgr.client(&right.cluster_id)?;
    let ((left_state, a), (right_state, b)) =
        futures::try_join!(read_side(mgr, left), read_side(mgr, right))?;
    Ok(SecretComparison {
        left: left_state,
        right: right_state,
        keys: compare_keys(&a, &b),
    })
}

/// Up to [`MAX_COMPARED_SECRETS`] Secrets of a namespace with their hashes, and whether there are more.
async fn namespace_hashes(
    mgr: &ClusterManager,
    side: &NamespaceSide,
) -> CoreResult<(BTreeMap<String, Hashes>, bool)> {
    let client = mgr.client(&side.cluster_id)?;
    let api: Api<Secret> = Api::namespaced(client, &side.namespace);
    let params = ListParams::default().limit(MAX_COMPARED_SECRETS);
    let list = with_timeout(STEP_TIMEOUT, "listing Secrets", async {
        Ok(api.list(&params).await?)
    })
    .await?;
    let more = list
        .metadata
        .continue_
        .as_deref()
        .is_some_and(|token| !token.is_empty())
        || list.items.len() > MAX_COMPARED_SECRETS as usize;
    let mut out = BTreeMap::new();
    for secret in list.items.iter().take(MAX_COMPARED_SECRETS as usize) {
        let name = secret.metadata.name.clone().unwrap_or_default();
        out.insert(name, live_hashes(secret)?);
    }
    Ok((out, more))
}

/// The Secrets with the same name in two namespaces (of one cluster or two), compared key by key; Secrets only one
/// side has are not listed (the namespace lists say that).
pub async fn compare_secret_namespaces(
    mgr: &ClusterManager,
    left: &NamespaceSide,
    right: &NamespaceSide,
) -> CoreResult<SecretNamespaceComparison> {
    check_namespace(&left.namespace)?;
    check_namespace(&right.namespace)?;
    mgr.client(&left.cluster_id)?;
    mgr.client(&right.cluster_id)?;
    let ((a, more_a), (b, more_b)) =
        futures::try_join!(namespace_hashes(mgr, left), namespace_hashes(mgr, right))?;
    let secrets = a
        .iter()
        .filter_map(|(name, left)| {
            let right = b.get(name)?;
            Some(NamedSecretComparison {
                name: name.clone(),
                keys: compare_keys(left, right),
            })
        })
        .collect();
    Ok(SecretNamespaceComparison {
        secrets,
        truncated: more_a || more_b,
    })
}
