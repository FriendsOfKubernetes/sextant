//! Interactive shell in a container (tries `bash`, then `sh`).
//!
//! [`exec_shell`] opens a TTY exec session over the API server's websocket and hands back channels: keystrokes go
//! into `input`, `(cols, rows)` into `resize`, and the output arrives on `output` as [`TermEvent`]s, ending with
//! `Exit` (the shell exited; `code` when the server reported it) or `Error` (the connection broke). Dropping
//! `input` or `output` ends the session.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures::SinkExt;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::Api;
use kube::api::{AttachParams, AttachedProcess, TerminalSize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode, code_for_http_status, kube_error};
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

/// Shells tried in order: the first one the container has wins.
pub const SHELLS: [&str; 2] = ["bash", "sh"];

/// How long a starting shell may stay silent before it counts as started (it usually prints a prompt at once;
/// a missing binary is reported by the server within milliseconds).
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CHANNEL_SIZE: usize = 256;
const READ_BUF: usize = 16 * 1024;

/// Opens a shell in `container` of `pod` with a `cols`×`rows` terminal: `bash` if the container has it, else `sh`.
///
/// Fails (no session) when the cluster is not connected, the pod or container does not exist, exec is forbidden,
/// or the container has neither shell.
pub async fn exec_shell(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: &str,
    cols: u16,
    rows: u16,
) -> CoreResult<ExecSession> {
    let client = mgr.client(cluster)?;
    let api: Api<Pod> = match &pod.namespace {
        Some(ns) => Api::namespaced(client, ns),
        None => Api::default_namespaced(client),
    };
    let mut last_failure = None;
    for shell in SHELLS {
        match start(&api, pod, container, shell, cols, rows).await? {
            Started::Running(process) => return Ok(spawn_session(*process)),
            Started::Missing(message) => last_failure = Some(message),
        }
    }
    Err(CoreError::new(
        ErrorCode::NotFound,
        format!(
            "no shell in container {container}: {}",
            last_failure.unwrap_or_default()
        ),
    ))
}

type StatusFuture = Pin<Box<dyn Future<Output = Option<Status>> + Send>>;
type Reader = Box<dyn AsyncRead + Send + Unpin>;
type Writer = Box<dyn AsyncWrite + Send + Unpin>;

/// A shell that started: its streams and the output it printed while we checked that it did.
struct Process {
    attached: AttachedProcess,
    stdin: Writer,
    stdout: Reader,
    status: StatusFuture,
    resize: Option<futures::channel::mpsc::Sender<TerminalSize>>,
    pending: Vec<u8>,
    /// The shell already finished while starting (e.g. it printed something and exited at once).
    finished: Option<Option<Status>>,
}

enum Started {
    Running(Box<Process>),
    /// The container has no such binary; the server's message.
    Missing(String),
}

async fn start(
    api: &Api<Pod>,
    pod: &ObjectRef,
    container: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> CoreResult<Started> {
    let params = AttachParams::interactive_tty()
        .container(container)
        .max_stdout_buf_size(READ_BUF);
    let mut attached = api
        .exec(&pod.name, [shell], &params)
        .await
        .map_err(|e| exec_error(e, pod, container))?;
    let (Some(stdin), Some(stdout), Some(status)) =
        (attached.stdin(), attached.stdout(), attached.take_status())
    else {
        return Err(CoreError::other("exec session without a terminal"));
    };
    let mut resize = attached.terminal_size();
    if let Some(tx) = resize.as_mut() {
        let _ = tx
            .send(TerminalSize {
                width: cols,
                height: rows,
            })
            .await;
    }
    let mut process = Process {
        attached,
        stdin: Box::new(stdin),
        stdout: Box::new(stdout),
        status: Box::pin(status),
        resize,
        pending: Vec::new(),
        finished: None,
    };

    // Wait for the first sign of life: output (the prompt) means the shell runs; a status before any output means
    // it could not start.
    let mut buf = vec![0u8; READ_BUF];
    let probe = tokio::time::timeout(PROBE_TIMEOUT, async {
        tokio::select! {
            read = process.stdout.read(&mut buf) => match read {
                Ok(n) if n > 0 => {
                    process.pending.extend_from_slice(&buf[..n]);
                    None
                }
                // Output closed: the status (if any) follows.
                _ => Some((&mut process.status).await),
            },
            status = &mut process.status => Some(status),
        }
    })
    .await;
    match probe {
        Ok(Some(status)) if process.pending.is_empty() && is_missing_binary(status.as_ref()) => {
            Ok(Started::Missing(status_message(status.as_ref())))
        }
        Ok(Some(status)) => {
            process.finished = Some(status);
            Ok(Started::Running(Box::new(process)))
        }
        Ok(None) | Err(_) => Ok(Started::Running(Box::new(process))),
    }
}

/// The API server refuses the websocket upgrade with a bare HTTP status (its explanation is lost), so the message
/// is rebuilt from what was asked for.
fn exec_error(err: kube::Error, pod: &ObjectRef, container: &str) -> CoreError {
    use kube::client::UpgradeConnectionError;
    let kube::Error::UpgradeConnection(UpgradeConnectionError::ProtocolSwitch(status)) = &err
    else {
        return kube_error(err, None);
    };
    let target = format!(
        "{}/{}",
        pod.namespace.as_deref().unwrap_or("default"),
        pod.name
    );
    let message = match status.as_u16() {
        404 => format!("pod {target} not found"),
        403 => format!("not allowed to open a shell in pod {target}"),
        400 => format!(
            "cannot open a shell in container {container} of pod {target}: the container does not exist or is not running"
        ),
        _ => format!("cannot open a shell in container {container} of pod {target}: {status}"),
    };
    CoreError::new(code_for_http_status(status.as_u16()), message)
}

/// A failure status that says the command does not exist in the container.
fn is_missing_binary(status: Option<&Status>) -> bool {
    let Some(status) = status else {
        return false;
    };
    if status.status.as_deref() == Some("Success") {
        return false;
    }
    if matches!(exit_code(status), Some(126 | 127)) {
        return true;
    }
    let message = status_message(Some(status)).to_lowercase();
    message.contains("not found") || message.contains("no such file")
}

fn status_message(status: Option<&Status>) -> String {
    status.and_then(|s| s.message.clone()).unwrap_or_default()
}

/// Exit code of a finished command: 0 on success, the `ExitCode` cause of a `NonZeroExitCode` failure.
pub fn exit_code(status: &Status) -> Option<i32> {
    if status.status.as_deref() == Some("Success") {
        return Some(0);
    }
    status
        .details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|c| c.reason.as_deref() == Some("ExitCode"))?
        .message
        .as_deref()?
        .trim()
        .parse()
        .ok()
}

fn spawn_session(process: Process) -> ExecSession {
    let (input_tx, input_rx) = mpsc::channel(CHANNEL_SIZE);
    let (resize_tx, resize_rx) = mpsc::channel(16);
    let (output_tx, output_rx) = mpsc::channel(CHANNEL_SIZE);
    tokio::spawn(pump(process, input_rx, resize_rx, output_tx));
    ExecSession {
        input: input_tx,
        resize: resize_tx,
        output: output_rx,
    }
}

/// Moves bytes between the channels and the websocket until the shell exits or either side goes away.
async fn pump(
    mut process: Process,
    mut input: mpsc::Receiver<Vec<u8>>,
    mut resize: mpsc::Receiver<(u16, u16)>,
    output: mpsc::Sender<TermEvent>,
) {
    if !process.pending.is_empty() {
        let pending = std::mem::take(&mut process.pending);
        if output.send(TermEvent::Data(pending)).await.is_err() {
            return;
        }
    }
    let ended = match process.finished.take() {
        Some(status) => Some(status),
        None => {
            let mut buf = vec![0u8; READ_BUF];
            let mut resize_open = true;
            loop {
                tokio::select! {
                    // A resize queued before keystrokes is sent before them.
                    biased;
                    size = resize.recv(), if resize_open => match size {
                        Some((cols, rows)) => {
                            if let Some(tx) = process.resize.as_mut() {
                                let _ = tx.send(TerminalSize { width: cols, height: rows }).await;
                            }
                        }
                        None => resize_open = false,
                    },
                    read = process.stdout.read(&mut buf) => match read {
                        Ok(n) if n > 0 => {
                            if output.send(TermEvent::Data(buf[..n].to_vec())).await.is_err() {
                                break None;
                            }
                        }
                        _ => break Some((&mut process.status).await),
                    },
                    keys = input.recv() => match keys {
                        Some(keys) => {
                            if process.stdin.write_all(&keys).await.is_err()
                                || process.stdin.flush().await.is_err()
                            {
                                // The connection is gone; the read side reports how it ended.
                                continue;
                            }
                        }
                        // The session was closed by its owner.
                        None => break None,
                    },
                    _ = output.closed() => break None,
                }
            }
        }
    };
    let Some(status) = ended else {
        // Closed by the owner: dropping the process aborts the websocket.
        process.attached.abort();
        return;
    };
    let event = match status {
        Some(status) => TermEvent::Exit {
            code: exit_code(&status),
        },
        None => {
            drop(process.stdin);
            drop(process.stdout);
            match process.attached.join().await {
                Ok(()) => TermEvent::Exit { code: None },
                Err(e) => TermEvent::Error(CoreError::new(
                    ErrorCode::Unreachable,
                    format!("the shell connection broke: {e}"),
                )),
            }
        }
    };
    let _ = output.send(event).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::{StatusCause, StatusDetails};

    fn failure(message: &str, code: Option<&str>) -> Status {
        Status {
            status: Some("Failure".into()),
            message: Some(message.into()),
            reason: Some("NonZeroExitCode".into()),
            details: code.map(|c| StatusDetails {
                causes: Some(vec![StatusCause {
                    reason: Some("ExitCode".into()),
                    message: Some(c.into()),
                    ..Default::default()
                }]),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn exit_code_comes_from_the_status() {
        let ok = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        assert_eq!(exit_code(&ok), Some(0));
        assert_eq!(
            exit_code(&failure("command terminated", Some("3"))),
            Some(3)
        );
        assert_eq!(exit_code(&failure("internal error", None)), None);
    }

    #[test]
    fn missing_binary_is_recognized_by_message_or_code() {
        let runtime = failure(
            r#"failed to exec in container: exec: "bash": executable file not found in $PATH"#,
            None,
        );
        assert!(is_missing_binary(Some(&runtime)));
        assert!(is_missing_binary(Some(&failure(
            "command terminated",
            Some("127")
        ))));
        assert!(!is_missing_binary(Some(&failure(
            "command terminated",
            Some("1")
        ))));
        assert!(!is_missing_binary(None));
        let ok = Status {
            status: Some("Success".into()),
            ..Default::default()
        };
        assert!(!is_missing_binary(Some(&ok)));
    }
}
