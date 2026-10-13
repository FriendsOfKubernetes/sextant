//! Asking the user before an agent's call runs: the server emits `mcp-confirm` with a [`ConfirmRequest`], the window
//! shows a dialog and answers with the command `mcp_confirm_answer(id, approved)`. No answer in [`CONFIRM_TIMEOUT`]
//! — the call is refused; stopping the server refuses every request still waiting.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sextant_core::{ClusterId, CoreError, ErrorCode};
use tokio::sync::oneshot;
use ts_rs::TS;

/// How long a request waits for the user.
pub const CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// Lines of YAML (or another long text) a request shows at most.
pub const MAX_DETAIL_LINES: usize = 200;

/// Payload of the `mcp-confirm` event: what the agent wants to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConfirmRequest {
    /// Answer with `mcp_confirm_answer(id, approved)`.
    pub id: String,
    /// The client's name from `initialize`.
    pub client: String,
    pub cluster_id: ClusterId,
    pub cluster_name: String,
    /// The tool the agent called, e.g. `delete_resource`.
    pub tool: String,
    /// What it acts on, e.g. `Deployment team-a/web`.
    pub target: String,
    /// More to look at: YAML (first [`MAX_DETAIL_LINES`] lines), a command, a port.
    pub details: Option<String>,
}

/// How a request ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmOutcome {
    Approved,
    /// Denied in the dialog, no window to ask in, or the server stopped.
    Declined,
    TimedOut,
}

#[derive(Default)]
struct Pending {
    waiting: HashMap<String, oneshot::Sender<bool>>,
    /// The server stopped: every request is declined at once until it starts again.
    closed: bool,
}

/// Requests waiting for the user.
pub struct Confirmations {
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    timeout: Duration,
}

impl Default for Confirmations {
    fn default() -> Self {
        Self::new(CONFIRM_TIMEOUT)
    }
}

impl Confirmations {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: Mutex::new(Pending::default()),
            next_id: AtomicU64::new(1),
            timeout,
        }
    }

    /// Asks the user: gives `request` its id, hands it to `notify` (which shows it; `false` — there is no window to
    /// show it in, so the request is declined) and waits for the answer.
    pub async fn ask(
        &self,
        mut request: ConfirmRequest,
        notify: impl FnOnce(&ConfirmRequest) -> bool,
    ) -> ConfirmOutcome {
        let id = format!("confirm-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        request.id = id.clone();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.lock();
            if pending.closed {
                return ConfirmOutcome::Declined;
            }
            pending.waiting.insert(id.clone(), tx);
        }
        // The call may be dropped while it waits (the agent went away): the request goes with it.
        let _forget = Forget {
            confirmations: self,
            id: &id,
        };
        if !notify(&request) {
            return ConfirmOutcome::Declined;
        }
        match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(true)) => ConfirmOutcome::Approved,
            Ok(Ok(false)) | Ok(Err(_)) => ConfirmOutcome::Declined,
            Err(_) => ConfirmOutcome::TimedOut,
        }
    }

    /// The user's answer to request `id`; `notFound` when it is no longer waiting (answered, timed out, stopped).
    pub fn answer(&self, id: &str, approved: bool) -> Result<(), CoreError> {
        let sender = self.lock().waiting.remove(id).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("confirmation {id} is no longer waiting"),
            )
        })?;
        // The asking call may have just been dropped; then nobody waits for the answer.
        let _ = sender.send(approved);
        Ok(())
    }

    /// The server stopped: refuses every waiting request, and every new one until [`Confirmations::open`].
    pub fn close(&self) {
        let mut pending = self.lock();
        pending.closed = true;
        for (_, sender) in pending.waiting.drain() {
            let _ = sender.send(false);
        }
    }

    /// The server started: requests are shown again.
    pub fn open(&self) {
        self.lock().closed = false;
    }

    /// Requests waiting now.
    pub fn pending(&self) -> usize {
        self.lock().waiting.len()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Removes a request from the waiting ones when its call ends, however it ends.
struct Forget<'a> {
    confirmations: &'a Confirmations,
    id: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.confirmations.lock().waiting.remove(self.id);
    }
}

/// The first [`MAX_DETAIL_LINES`] lines of `text`, with a note when there were more.
pub fn first_lines(text: &str) -> String {
    let total = text.lines().count();
    if total <= MAX_DETAIL_LINES {
        return text.to_owned();
    }
    let mut shown: String = text
        .lines()
        .take(MAX_DETAIL_LINES)
        .collect::<Vec<_>>()
        .join("\n");
    shown.push_str(&format!(
        "\n… {} more lines not shown",
        total - MAX_DETAIL_LINES
    ));
    shown
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;

    fn request() -> ConfirmRequest {
        ConfirmRequest {
            id: String::new(),
            client: "claude-code".into(),
            cluster_id: ClusterId::from("c1"),
            cluster_name: "kind".into(),
            tool: "delete_resource".into(),
            target: "Pod team-a/web".into(),
            details: None,
        }
    }

    /// Asks in the background and returns the request the "window" got.
    async fn ask_in_background(
        confirmations: &Arc<Confirmations>,
    ) -> (ConfirmRequest, tokio::task::JoinHandle<ConfirmOutcome>) {
        let (shown_tx, shown_rx) = oneshot::channel();
        let c = Arc::clone(confirmations);
        let task = tokio::spawn(async move {
            c.ask(request(), move |r| {
                shown_tx.send(r.clone()).unwrap();
                true
            })
            .await
        });
        (shown_rx.await.unwrap(), task)
    }

    #[tokio::test]
    async fn the_answer_from_the_window_decides() {
        let confirmations = Arc::new(Confirmations::default());
        let (shown, task) = ask_in_background(&confirmations).await;
        assert!(shown.id.starts_with("confirm-"));
        assert_eq!(shown.tool, "delete_resource");
        confirmations.answer(&shown.id, true).unwrap();
        assert_eq!(task.await.unwrap(), ConfirmOutcome::Approved);

        let (shown, task) = ask_in_background(&confirmations).await;
        confirmations.answer(&shown.id, false).unwrap();
        assert_eq!(task.await.unwrap(), ConfirmOutcome::Declined);
        assert_eq!(confirmations.pending(), 0);

        let late = confirmations.answer(&shown.id, true).unwrap_err();
        assert_eq!(late.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn no_answer_in_time_times_out() {
        assert_eq!(CONFIRM_TIMEOUT, Duration::from_secs(120));
        assert_eq!(Confirmations::default().timeout, CONFIRM_TIMEOUT);
        let confirmations = Arc::new(Confirmations::new(Duration::from_millis(200)));
        let (shown, task) = ask_in_background(&confirmations).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!task.is_finished());
        assert_eq!(task.await.unwrap(), ConfirmOutcome::TimedOut);
        assert_eq!(confirmations.pending(), 0);
        assert!(confirmations.answer(&shown.id, true).is_err());
    }

    #[tokio::test]
    async fn stopping_declines_every_waiting_request() {
        let confirmations = Arc::new(Confirmations::default());
        let (_, first) = ask_in_background(&confirmations).await;
        let (_, second) = ask_in_background(&confirmations).await;
        assert_eq!(confirmations.pending(), 2);
        confirmations.close();
        assert_eq!(first.await.unwrap(), ConfirmOutcome::Declined);
        assert_eq!(second.await.unwrap(), ConfirmOutcome::Declined);

        // Closed: declined without being shown, until opened again.
        let shown = confirmations.ask(request(), |_| panic!("shown")).await;
        assert_eq!(shown, ConfirmOutcome::Declined);
        confirmations.open();
        let (asked, task) = ask_in_background(&confirmations).await;
        confirmations.answer(&asked.id, true).unwrap();
        assert_eq!(task.await.unwrap(), ConfirmOutcome::Approved);
    }

    #[tokio::test]
    async fn without_a_window_the_request_is_declined() {
        let confirmations = Confirmations::default();
        let outcome = confirmations.ask(request(), |_| false).await;
        assert_eq!(outcome, ConfirmOutcome::Declined);
        assert_eq!(confirmations.pending(), 0);
    }

    #[tokio::test]
    async fn a_dropped_call_leaves_no_request_behind() {
        let confirmations = Arc::new(Confirmations::default());
        let (_, task) = ask_in_background(&confirmations).await;
        task.abort();
        let _ = task.await;
        assert_eq!(confirmations.pending(), 0);
    }

    #[test]
    fn long_details_are_cut() {
        let text: Vec<String> = (0..250).map(|n| format!("line {n}")).collect();
        let shown = first_lines(&text.join("\n"));
        assert_eq!(shown.lines().count(), MAX_DETAIL_LINES + 1);
        assert!(shown.ends_with("50 more lines not shown"));
        assert_eq!(first_lines("a\nb"), "a\nb");
    }
}
