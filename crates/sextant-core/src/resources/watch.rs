//! Live watch of a kind: watcher + store, batches every 250 ms, `managedFields` stripped.

use futures::Stream;

use super::{WatchSpec, WatchUpdate};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;

pub async fn watch(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _spec: WatchSpec,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + 'static> {
    Err::<futures::stream::Empty<WatchUpdate>, _>(CoreError::not_implemented())
}
