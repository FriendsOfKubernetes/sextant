//! Interactive shell in a container (tries `bash`, then `sh`).

use tokio::sync::mpsc;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult};
use crate::kubeconfig::ClusterId;
use crate::resources::ObjectRef;

/// Output of a terminal session (exec or local PTY).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    Data(Vec<u8>),
    Exit { code: Option<i32> },
    Error(CoreError),
}

/// Handles of a running exec session. Dropping `input` closes stdin.
pub struct ExecSession {
    pub input: mpsc::Sender<Vec<u8>>,
    pub resize: mpsc::Sender<(u16, u16)>,
    pub output: mpsc::Receiver<TermEvent>,
}

pub async fn exec_shell(
    _mgr: &ClusterManager,
    _cluster: &ClusterId,
    _pod: &ObjectRef,
    _container: &str,
    _cols: u16,
    _rows: u16,
) -> CoreResult<ExecSession> {
    Err(CoreError::not_implemented())
}
