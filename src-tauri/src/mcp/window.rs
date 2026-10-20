//! The bridge from an agent's diagnostic tool to the window (ADR-0094): the window holds the engines (problems,
//! traffic diagnosis, connectivity, RBAC, the change recorder, autoscaling) and the shared watches that feed them, so a
//! diagnostic tool — after its `Guard` checks — asks the window to compute with `mcp-diagnostic`
//! ([`DiagnosticRequest`]) and waits for the command `mcp_diagnostic_answer(id, answer)`.
//!
//! No window — the request fails at once. No answer in [`WINDOW_TIMEOUT`] — it fails as timed out. At most
//! [`MAX_PENDING`] requests wait at once. A dropped call (the agent went away, the server stopped) takes its request
//! with it, and [`WindowRequests::fail_all`] fails every waiting one (the page that would answer was reloaded).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sextant_core::access::{KindScope, NamespaceScope};
use sextant_core::{ClusterId, CoreError, ErrorCode};
use tokio::sync::oneshot;
use ts_rs::TS;

use super::audit::clip;

/// How long a request waits for the window. The window answers within its own 20 s settle limit; the rest is slack.
pub const WINDOW_TIMEOUT: Duration = Duration::from_secs(40);
/// Requests that may wait for the window at once; more are refused without being sent.
pub const MAX_PENDING: usize = 4;

/// What the window is asked to compute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum DiagnosticTool {
    Problems,
    DiagnoseService,
    Connectivity,
    Permissions,
    RecentChanges,
    Autoscaling,
}

/// One Read rule in force for the agent: namespaces × kinds. The window feeds its engines only objects some rule
/// covers (a cluster-scoped object only under "all namespaces").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReadRule {
    pub namespaces: NamespaceScope,
    pub kinds: KindScope,
}

/// Payload of the `mcp-diagnostic` event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiagnosticRequest {
    /// Answer with `mcp_diagnostic_answer(id, answer)`.
    pub id: String,
    pub tool: DiagnosticTool,
    pub cluster_id: ClusterId,
    /// What the agent may read.
    pub reads: Vec<ReadRule>,
    /// The tool's arguments, already checked by the backend (camelCase, without the cluster).
    #[ts(type = "Record<string, unknown>")]
    pub args: Value,
}

/// The window's answer: the tool's result (checked and filtered again by the backend), or why it could not compute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum DiagnosticAnswer {
    Ok {
        #[ts(type = "unknown")]
        result: Value,
    },
    Error {
        message: String,
    },
}

/// Requests waiting for the window.
pub struct WindowRequests {
    pending: Mutex<HashMap<String, oneshot::Sender<DiagnosticAnswer>>>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl Default for WindowRequests {
    fn default() -> Self {
        Self::new(WINDOW_TIMEOUT)
    }
}

pub const NO_WINDOW: &str = "Sextant's diagnostic tools compute in the Sextant window, and no window is open. \
Open Sextant and repeat the call.";
const BUSY: &str =
    "Sextant's window is computing other diagnostics for agents; repeat the call in a moment.";
const RELOADED: &str =
    "Sextant's window was reloaded while it computed this answer; repeat the call.";

impl WindowRequests {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            timeout,
        }
    }

    /// Gives `request` its id, hands it to `notify` (`false`: no window to send it to) and waits for the answer.
    pub async fn ask(
        &self,
        mut request: DiagnosticRequest,
        notify: impl FnOnce(&DiagnosticRequest) -> bool,
    ) -> Result<Value, CoreError> {
        let id = format!(
            "diagnostic-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed)
        );
        request.id = id.clone();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.lock();
            if pending.len() >= MAX_PENDING {
                return Err(CoreError::new(ErrorCode::Other, BUSY));
            }
            pending.insert(id.clone(), tx);
        }
        // The call may be dropped while it waits (the agent went away, the server stopped): the request goes with it.
        let _forget = Forget {
            requests: self,
            id: &id,
        };
        if !notify(&request) {
            return Err(CoreError::new(ErrorCode::Other, NO_WINDOW));
        }
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(DiagnosticAnswer::Ok { result })) => Ok(result),
            Ok(Ok(DiagnosticAnswer::Error { message })) => Err(CoreError::new(
                ErrorCode::Other,
                format!("Sextant could not compute this: {}", clip(&message)),
            )),
            Ok(Err(_)) => Err(CoreError::new(ErrorCode::Other, RELOADED)),
            Err(_) => Err(CoreError::new(
                ErrorCode::Timeout,
                format!(
                    "Sextant's window did not answer in {} s; repeat the call.",
                    self.timeout.as_secs()
                ),
            )),
        }
    }

    /// The window's answer to request `id`; `notFound` when it no longer waits (answered, timed out, dropped).
    pub fn answer(&self, id: &str, answer: DiagnosticAnswer) -> Result<(), CoreError> {
        let waiting = self.lock().remove(id).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("diagnostic request {id} is no longer waiting"),
            )
        })?;
        let _ = waiting.send(answer);
        Ok(())
    }

    /// Fails every waiting request: the page that would answer them is gone.
    pub fn fail_all(&self) {
        // Dropping the senders ends each wait with the "reloaded" error.
        self.lock().clear();
    }

    /// Requests waiting now.
    pub fn pending(&self) -> usize {
        self.lock().len()
    }

    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<DiagnosticAnswer>>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Forget<'a> {
    requests: &'a WindowRequests,
    id: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.requests.lock().remove(self.id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;

    use super::*;

    fn request() -> DiagnosticRequest {
        DiagnosticRequest {
            id: String::new(),
            tool: DiagnosticTool::Problems,
            cluster_id: ClusterId::from("c"),
            reads: Vec::new(),
            args: json!({}),
        }
    }

    #[tokio::test]
    async fn the_window_answers_by_id_and_a_late_answer_finds_nothing() {
        let requests = Arc::new(WindowRequests::default());
        let answerer = Arc::clone(&requests);
        let result = requests
            .ask(request(), move |r| {
                assert!(r.id.starts_with("diagnostic-"));
                let (answerer, id) = (Arc::clone(&answerer), r.id.clone());
                tokio::spawn(async move {
                    answerer
                        .answer(
                            &id,
                            DiagnosticAnswer::Ok {
                                result: json!({ "x": 1 }),
                            },
                        )
                        .unwrap();
                });
                true
            })
            .await
            .unwrap();
        assert_eq!(result, json!({ "x": 1 }));
        assert_eq!(requests.pending(), 0);
        let late = requests.answer("diagnostic-1", DiagnosticAnswer::Ok { result: json!(1) });
        assert_eq!(late.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn without_a_window_the_request_fails_at_once_and_is_forgotten() {
        let requests = WindowRequests::default();
        let error = requests.ask(request(), |_| false).await.unwrap_err();
        assert_eq!(error.message, NO_WINDOW);
        assert_eq!(requests.pending(), 0);
    }

    #[tokio::test]
    async fn an_error_answer_is_clipped_and_silence_times_out() {
        let requests = Arc::new(WindowRequests::new(Duration::from_millis(50)));
        let answerer = Arc::clone(&requests);
        let error = requests
            .ask(request(), move |r| {
                let message = "x".repeat(5000);
                answerer
                    .answer(&r.id, DiagnosticAnswer::Error { message })
                    .unwrap();
                true
            })
            .await
            .unwrap_err();
        assert!(error.message.len() < 400, "{}", error.message.len());
        let silent = requests.ask(request(), |_| true).await.unwrap_err();
        assert_eq!(silent.code, ErrorCode::Timeout);
        assert_eq!(requests.pending(), 0);
    }

    #[tokio::test]
    async fn at_most_a_few_wait_and_a_reload_fails_them() {
        let requests = Arc::new(WindowRequests::default());
        let mut waiting = Vec::new();
        for _ in 0..MAX_PENDING {
            let requests = Arc::clone(&requests);
            waiting.push(tokio::spawn(async move {
                requests.ask(request(), |_| true).await
            }));
        }
        while requests.pending() < MAX_PENDING {
            tokio::task::yield_now().await;
        }
        let refused = requests.ask(request(), |_| panic!("not sent")).await;
        assert_eq!(refused.unwrap_err().message, BUSY);
        requests.fail_all();
        for task in waiting {
            assert_eq!(task.await.unwrap().unwrap_err().message, RELOADED);
        }
    }

    #[tokio::test]
    async fn a_dropped_call_takes_its_request_with_it() {
        let requests = WindowRequests::default();
        let call = requests.ask(request(), |_| true);
        let _ = tokio::time::timeout(Duration::from_millis(20), call).await;
        assert_eq!(requests.pending(), 0);
    }
}
