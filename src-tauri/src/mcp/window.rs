//! The bridge from an agent's diagnostic tool to the window (ADR-0094): the window holds the engines (problems,
//! traffic diagnosis, connectivity, RBAC, the change recorder, autoscaling) and the shared watches that feed them, so a
//! diagnostic tool — after its `Guard` checks — asks the window to compute with `mcp-diagnostic`
//! ([`DiagnosticRequest`]) and waits for the command `mcp_diagnostic_answer(id, answer)`.
//!
//! No window — the request fails at once. No answer in [`WINDOW_TIMEOUT`] — it fails as timed out. At most
//! [`MAX_PENDING`] requests wait at once, and at most [`MAX_PENDING_PER_SESSION`] of one MCP session. A dropped call
//! (the agent went away, the server stopped) takes its request with it, and [`WindowRequests::fail_all`] fails every
//! waiting one (the page that would answer was reloaded, the server stopped). Whenever the backend stops waiting
//! without an answer, the window is told with `mcp-diagnostic-cancel` ([`DiagnosticCancel`]) so it drops the request's
//! worker and lets go of its watches.
//!
//! Timing: the window runs as many requests at once as the backend lets wait (`MAX_RUNNING` = [`MAX_PENDING`] in
//! `src/features/mcp-diagnostics/DiagnosticsHost.tsx`), so an admitted request starts at once and answers within the
//! window's settle time (20 s, `SETTLE_MS`), half of [`WINDOW_TIMEOUT`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sextant_core::access::{KindScope, NamespaceScope};
use sextant_core::{ClusterId, CoreError, ErrorCode};
use tokio::sync::oneshot;
use ts_rs::TS;

use super::audit::clip;

/// How long a request waits for the window. The window starts every admitted request at once and answers within its
/// own 20 s settle limit; the rest is slack.
pub const WINDOW_TIMEOUT: Duration = Duration::from_secs(40);
/// Requests that may wait for the window at once; more are refused without being sent. The window runs this many at
/// once (`MAX_RUNNING`), so none of them queues there.
pub const MAX_PENDING: usize = 4;
/// Requests one MCP session may have waiting at once, so one agent cannot take every place.
pub const MAX_PENDING_PER_SESSION: usize = 2;

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

/// Payload of the `mcp-diagnostic-cancel` event: the backend no longer waits for request `id` (timed out, the call
/// was dropped, the server stopped); the window drops its worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DiagnosticCancel {
    pub id: String,
}

/// Tells the window that a request no longer waits.
pub type Cancel = Arc<dyn Fn(&str) + Send + Sync>;

struct Waiting {
    answer: oneshot::Sender<DiagnosticAnswer>,
    session: String,
    cancel: Cancel,
}

/// Requests waiting for the window.
pub struct WindowRequests {
    pending: Mutex<HashMap<String, Waiting>>,
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
const BUSY_SESSION: &str = "This session already waits for other diagnostics from Sextant's window; repeat the \
call when they have answered.";
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

    /// Gives `request` its id, hands it to `notify` (`false`: no window to send it to) and waits for the answer;
    /// `session` is the MCP session asking. When it stops waiting without an answer, `cancel` tells the window.
    pub async fn ask(
        &self,
        mut request: DiagnosticRequest,
        session: &str,
        notify: impl FnOnce(&DiagnosticRequest) -> bool,
        cancel: Cancel,
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
            let mine = pending.values().filter(|w| w.session == session).count();
            if mine >= MAX_PENDING_PER_SESSION {
                return Err(CoreError::new(ErrorCode::Other, BUSY_SESSION));
            }
            pending.insert(
                id.clone(),
                Waiting {
                    answer: tx,
                    session: session.to_owned(),
                    cancel,
                },
            );
        }
        // The call may be dropped while it waits (the agent went away, the server stopped) or time out: the request
        // goes with it, and the window is told.
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
        let _ = waiting.answer.send(answer);
        Ok(())
    }

    /// Fails every waiting request (the page that would answer them is gone, or the server stopped) and tells the
    /// window to drop them.
    pub fn fail_all(&self) {
        // Dropping the senders ends each wait with the "reloaded" error.
        let gone: Vec<(String, Waiting)> = self.lock().drain().collect();
        for (id, waiting) in gone {
            (waiting.cancel)(&id);
        }
    }

    /// Requests waiting now.
    pub fn pending(&self) -> usize {
        self.lock().len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Waiting>> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

struct Forget<'a> {
    requests: &'a WindowRequests,
    id: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        // Still waiting: nobody answered (timed out, dropped) and the window may still compute it.
        let left = self.requests.lock().remove(self.id);
        if let Some(waiting) = left {
            (waiting.cancel)(self.id);
        }
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

    /// A `Cancel` that records the ids it was told.
    fn cancels() -> (Cancel, Arc<Mutex<Vec<String>>>) {
        let told = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&told);
        (
            Arc::new(move |id: &str| seen.lock().unwrap().push(id.to_owned())),
            told,
        )
    }

    fn quiet() -> Cancel {
        Arc::new(|_: &str| {})
    }

    #[tokio::test]
    async fn the_window_answers_by_id_and_a_late_answer_finds_nothing() {
        let requests = Arc::new(WindowRequests::default());
        let answerer = Arc::clone(&requests);
        let (cancel, told) = cancels();
        let result = requests
            .ask(
                request(),
                "s",
                move |r| {
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
                },
                cancel,
            )
            .await
            .unwrap();
        assert_eq!(result, json!({ "x": 1 }));
        assert_eq!(requests.pending(), 0);
        // Answered: nothing to cancel.
        assert!(told.lock().unwrap().is_empty());
        let late = requests.answer("diagnostic-1", DiagnosticAnswer::Ok { result: json!(1) });
        assert_eq!(late.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn without_a_window_the_request_fails_at_once_and_is_forgotten() {
        let requests = WindowRequests::default();
        let error = requests
            .ask(request(), "s", |_| false, quiet())
            .await
            .unwrap_err();
        assert_eq!(error.message, NO_WINDOW);
        assert_eq!(requests.pending(), 0);
    }

    #[tokio::test]
    async fn an_error_answer_is_clipped_and_silence_times_out_and_cancels() {
        let requests = Arc::new(WindowRequests::new(Duration::from_millis(50)));
        let answerer = Arc::clone(&requests);
        let error = requests
            .ask(
                request(),
                "s",
                move |r| {
                    let message = "x".repeat(5000);
                    answerer
                        .answer(&r.id, DiagnosticAnswer::Error { message })
                        .unwrap();
                    true
                },
                quiet(),
            )
            .await
            .unwrap_err();
        assert!(error.message.len() < 400, "{}", error.message.len());
        let (cancel, told) = cancels();
        let mut sent = String::new();
        let silent = requests
            .ask(
                request(),
                "s",
                |r| {
                    sent = r.id.clone();
                    true
                },
                cancel,
            )
            .await
            .unwrap_err();
        assert_eq!(silent.code, ErrorCode::Timeout);
        assert_eq!(requests.pending(), 0);
        // The window is told to drop what it no longer needs to compute.
        assert_eq!(*told.lock().unwrap(), vec![sent]);
    }

    #[tokio::test]
    async fn at_most_a_few_wait_and_a_reload_fails_and_cancels_them() {
        let requests = Arc::new(WindowRequests::default());
        let (cancel, told) = cancels();
        let mut waiting = Vec::new();
        for i in 0..MAX_PENDING {
            let requests = Arc::clone(&requests);
            let cancel = Arc::clone(&cancel);
            // Two sessions, each at its own cap.
            let session = format!("s{}", i % 2);
            waiting.push(tokio::spawn(async move {
                requests.ask(request(), &session, |_| true, cancel).await
            }));
        }
        while requests.pending() < MAX_PENDING {
            tokio::task::yield_now().await;
        }
        let refused = requests
            .ask(request(), "s9", |_| panic!("not sent"), quiet())
            .await;
        assert_eq!(refused.unwrap_err().message, BUSY);
        requests.fail_all();
        for task in waiting {
            assert_eq!(task.await.unwrap().unwrap_err().message, RELOADED);
        }
        let mut ids = told.lock().unwrap().clone();
        ids.sort();
        assert_eq!(ids.len(), MAX_PENDING);
    }

    #[tokio::test]
    async fn one_session_cannot_take_every_place() {
        let requests = Arc::new(WindowRequests::default());
        let mut waiting = Vec::new();
        for _ in 0..MAX_PENDING_PER_SESSION {
            let requests = Arc::clone(&requests);
            waiting.push(tokio::spawn(async move {
                requests.ask(request(), "greedy", |_| true, quiet()).await
            }));
        }
        while requests.pending() < MAX_PENDING_PER_SESSION {
            tokio::task::yield_now().await;
        }
        let refused = requests
            .ask(request(), "greedy", |_| panic!("not sent"), quiet())
            .await;
        assert_eq!(refused.unwrap_err().message, BUSY_SESSION);
        // Another session still gets a place.
        let other = Arc::clone(&requests);
        let asked =
            tokio::spawn(async move { other.ask(request(), "other", |_| true, quiet()).await });
        while requests.pending() < MAX_PENDING_PER_SESSION + 1 {
            tokio::task::yield_now().await;
        }
        requests.fail_all();
        assert!(asked.await.unwrap().is_err());
        for task in waiting {
            assert!(task.await.unwrap().is_err());
        }
    }

    #[tokio::test]
    async fn a_dropped_call_takes_its_request_with_it_and_cancels_it() {
        let requests = WindowRequests::default();
        let (cancel, told) = cancels();
        let call = requests.ask(request(), "s", |_| true, cancel);
        let _ = tokio::time::timeout(Duration::from_millis(20), call).await;
        assert_eq!(requests.pending(), 0);
        assert_eq!(told.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_admitted_request_is_answered_inside_the_timeout() {
        // The window runs as many requests at once as may wait here (no admitted one queues behind another) and each
        // answers within its settle time: well inside WINDOW_TIMEOUT.
        let host = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/features/mcp-diagnostics/DiagnosticsHost.tsx"),
        )
        .unwrap();
        let constant = |name: &str| -> u64 {
            let start = format!("export const {name} = ");
            let from = host.find(&start).unwrap_or_else(|| panic!("{name}")) + start.len();
            let text = &host[from..from + host[from..].find(';').unwrap()];
            text.replace('_', "").parse().unwrap()
        };
        assert_eq!(constant("MAX_RUNNING"), MAX_PENDING as u64);
        let settle = Duration::from_millis(constant("SETTLE_MS"));
        assert!(WINDOW_TIMEOUT >= settle + Duration::from_secs(10));
    }
}
