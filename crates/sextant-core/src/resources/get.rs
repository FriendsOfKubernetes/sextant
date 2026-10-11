//! Reading one object.

use super::ObjectRef;
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;

pub async fn get(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _r: &ObjectRef,
) -> CoreResult<serde_json::Value> {
    Err(CoreError::not_implemented())
}
