//! Pod logs as a stream of line batches (every 100 ms).

use futures::Stream;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;
use crate::resources::ObjectRef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LogOptions {
    pub container: String,
    pub follow: bool,
    pub previous: bool,
    pub timestamps: bool,
    pub tail_lines: Option<i64>,
}

/// Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum LogUpdate {
    Lines { lines: Vec<String> },
    Ended,
    Error(CoreError),
}

pub async fn stream_logs(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _pod: &ObjectRef,
    _opts: LogOptions,
) -> CoreResult<impl Stream<Item = LogUpdate> + Send + 'static> {
    Err::<futures::stream::Empty<LogUpdate>, _>(CoreError::not_implemented())
}
