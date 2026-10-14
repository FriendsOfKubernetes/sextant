//! Asking the user before a call of an AI agent (MCP) or of an extension runs: the window gets `mcp-confirm` with a
//! [`ConfirmRequest`] (whoever asks: [`ConfirmRequest::source`], [`ConfirmRequest::principal`]), shows one dialog and
//! answers with the command `mcp_confirm_answer(id, approved)`. One pending map serves both, so one answer path does.
//! No answer in [`CONFIRM_TIMEOUT`] — the call is refused. Closing a source (the MCP server stopped; the window
//! closed) refuses every request of that source still waiting, and every new one until it is opened again.

use std::collections::{HashMap, HashSet};
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

/// Requests of one extension that may wait for the user at once; more are refused without being shown, so an
/// extension cannot bury the window in dialogs.
pub const MAX_PENDING_PER_EXTENSION: usize = 4;

/// Who asks for a confirmation (and whose call a journal entry is).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ConfirmSource {
    /// An AI agent through the MCP server.
    #[default]
    Agent,
    /// An extension through `extension_call`.
    Extension,
}

/// Payload of the `mcp-confirm` event: what an agent or an extension wants to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ConfirmRequest {
    /// Answer with `mcp_confirm_answer(id, approved)`.
    pub id: String,
    pub source: ConfirmSource,
    /// Who asks, as the dialog names it: the agent's client name, or `Extension <name>`.
    pub principal: String,
    /// The agent's client name from `initialize`, or the extension's id.
    pub client: String,
    pub cluster_id: ClusterId,
    pub cluster_name: String,
    /// The tool the agent called (e.g. `delete_resource`), or the extension's method (e.g. `resources.patch`).
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

struct Waiting {
    source: ConfirmSource,
    client: String,
    answer: oneshot::Sender<bool>,
}

#[derive(Default)]
struct Pending {
    /// By request id: who asks (source, client) and where the answer goes.
    waiting: HashMap<String, Waiting>,
    /// Sources whose requests are declined at once (the MCP server stopped) until they are opened again.
    closed: HashSet<ConfirmSource>,
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
        request: ConfirmRequest,
        notify: impl FnOnce(&ConfirmRequest) -> bool,
    ) -> ConfirmOutcome {
        self.ask_at_most(request, usize::MAX, notify)
            .await
            .unwrap_or(ConfirmOutcome::Declined)
    }

    /// [`Confirmations::ask`], unless `most` requests of the same source and client (an extension's id) are waiting
    /// already: then `None` at once, and nothing is shown.
    pub async fn ask_at_most(
        &self,
        mut request: ConfirmRequest,
        most: usize,
        notify: impl FnOnce(&ConfirmRequest) -> bool,
    ) -> Option<ConfirmOutcome> {
        let id = format!("confirm-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        request.id = id.clone();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.lock();
            if pending.closed.contains(&request.source) {
                return Some(ConfirmOutcome::Declined);
            }
            let same = pending
                .waiting
                .values()
                .filter(|w| w.source == request.source && w.client == request.client)
                .count();
            if same >= most {
                return None;
            }
            pending.waiting.insert(
                id.clone(),
                Waiting {
                    source: request.source,
                    client: request.client.clone(),
                    answer: tx,
                },
            );
        }
        // The call may be dropped while it waits (the agent went away): the request goes with it.
        let _forget = Forget {
            confirmations: self,
            id: &id,
        };
        if !notify(&request) {
            return Some(ConfirmOutcome::Declined);
        }
        Some(match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(true)) => ConfirmOutcome::Approved,
            Ok(Ok(false)) | Ok(Err(_)) => ConfirmOutcome::Declined,
            Err(_) => ConfirmOutcome::TimedOut,
        })
    }

    /// The user's answer to request `id`; `notFound` when it is no longer waiting (answered, timed out, stopped).
    pub fn answer(&self, id: &str, approved: bool) -> Result<(), CoreError> {
        let waiting = self.lock().waiting.remove(id).ok_or_else(|| {
            CoreError::new(
                ErrorCode::NotFound,
                format!("confirmation {id} is no longer waiting"),
            )
        })?;
        // The asking call may have just been dropped; then nobody waits for the answer.
        let _ = waiting.answer.send(approved);
        Ok(())
    }

    /// Refuses every waiting request of `source`, and every new one until [`Confirmations::open`] (the MCP server
    /// stopped; the window closed). Requests of the other source are not touched.
    pub fn close(&self, source: ConfirmSource) {
        let mut pending = self.lock();
        pending.closed.insert(source);
        Self::decline_in(&mut pending, source);
    }

    /// Requests of `source` are shown again (the MCP server started).
    pub fn open(&self, source: ConfirmSource) {
        self.lock().closed.remove(&source);
    }

    /// Refuses every request of `source` waiting now, but not later ones (the page that showed them was reloaded).
    pub fn decline(&self, source: ConfirmSource) {
        Self::decline_in(&mut self.lock(), source);
    }

    fn decline_in(pending: &mut Pending, source: ConfirmSource) {
        let ids: Vec<String> = pending
            .waiting
            .iter()
            .filter(|(_, w)| w.source == source)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(waiting) = pending.waiting.remove(&id) {
                let _ = waiting.answer.send(false);
            }
        }
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
            source: ConfirmSource::Agent,
            principal: "claude-code".into(),
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
        ask_from(confirmations, request()).await
    }

    async fn ask_from(
        confirmations: &Arc<Confirmations>,
        request: ConfirmRequest,
    ) -> (ConfirmRequest, tokio::task::JoinHandle<ConfirmOutcome>) {
        let (shown_tx, shown_rx) = oneshot::channel();
        let c = Arc::clone(confirmations);
        let task = tokio::spawn(async move {
            c.ask(request, move |r| {
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
        confirmations.close(ConfirmSource::Agent);
        assert_eq!(first.await.unwrap(), ConfirmOutcome::Declined);
        assert_eq!(second.await.unwrap(), ConfirmOutcome::Declined);

        // Closed: declined without being shown, until opened again.
        let shown = confirmations.ask(request(), |_| panic!("shown")).await;
        assert_eq!(shown, ConfirmOutcome::Declined);
        confirmations.open(ConfirmSource::Agent);
        let (asked, task) = ask_in_background(&confirmations).await;
        confirmations.answer(&asked.id, true).unwrap();
        assert_eq!(task.await.unwrap(), ConfirmOutcome::Approved);
    }

    fn extension_request() -> ConfirmRequest {
        ConfirmRequest {
            source: ConfirmSource::Extension,
            principal: "Extension Widgets".into(),
            client: "widgets".into(),
            tool: "resources.patch".into(),
            ..request()
        }
    }

    #[tokio::test]
    async fn agents_and_extensions_share_the_answers_but_close_separately() {
        let confirmations = Arc::new(Confirmations::default());
        let (agent, agent_task) = ask_in_background(&confirmations).await;
        let (ext, ext_task) = ask_from(&confirmations, extension_request()).await;
        assert_ne!(agent.id, ext.id, "one id space");
        assert_eq!(ext.principal, "Extension Widgets");

        // The MCP server stops: only the agent's request goes.
        confirmations.close(ConfirmSource::Agent);
        assert_eq!(agent_task.await.unwrap(), ConfirmOutcome::Declined);
        assert_eq!(confirmations.pending(), 1);
        confirmations.answer(&ext.id, true).unwrap();
        assert_eq!(ext_task.await.unwrap(), ConfirmOutcome::Approved);

        // A page reload declines the extension's waiting requests, but later ones are asked.
        let (_, waiting) = ask_from(&confirmations, extension_request()).await;
        confirmations.decline(ConfirmSource::Extension);
        assert_eq!(waiting.await.unwrap(), ConfirmOutcome::Declined);
        let (later, later_task) = ask_from(&confirmations, extension_request()).await;
        confirmations.answer(&later.id, true).unwrap();
        assert_eq!(later_task.await.unwrap(), ConfirmOutcome::Approved);
    }

    #[tokio::test]
    async fn an_extension_has_at_most_four_requests_waiting_and_the_next_is_not_shown() {
        assert_eq!(MAX_PENDING_PER_EXTENSION, 4);
        let confirmations = Arc::new(Confirmations::default());
        let mut waiting = Vec::new();
        for _ in 0..MAX_PENDING_PER_EXTENSION {
            waiting.push(ask_from(&confirmations, extension_request()).await);
        }
        let fifth = confirmations
            .ask_at_most(extension_request(), MAX_PENDING_PER_EXTENSION, |_| {
                panic!("shown")
            })
            .await;
        assert_eq!(fifth, None);
        assert_eq!(confirmations.pending(), MAX_PENDING_PER_EXTENSION);

        // Another extension, and agents, are asked as before.
        let gadgets = ConfirmRequest {
            principal: "Extension Gadgets".into(),
            client: "gadgets".into(),
            ..extension_request()
        };
        let (other, other_task) = ask_from(&confirmations, gadgets).await;
        confirmations.answer(&other.id, true).unwrap();
        assert_eq!(other_task.await.unwrap(), ConfirmOutcome::Approved);
        let (agent, agent_task) = ask_in_background(&confirmations).await;
        confirmations.answer(&agent.id, false).unwrap();
        assert_eq!(agent_task.await.unwrap(), ConfirmOutcome::Declined);

        // One answered: one more may wait.
        let (first, first_task) = waiting.remove(0);
        confirmations.answer(&first.id, false).unwrap();
        assert_eq!(first_task.await.unwrap(), ConfirmOutcome::Declined);
        let (shown_tx, shown_rx) = oneshot::channel();
        let c = Arc::clone(&confirmations);
        let next = tokio::spawn(async move {
            c.ask_at_most(extension_request(), MAX_PENDING_PER_EXTENSION, move |r| {
                shown_tx.send(r.clone()).unwrap();
                true
            })
            .await
        });
        let shown = shown_rx.await.unwrap();
        confirmations.answer(&shown.id, true).unwrap();
        assert_eq!(next.await.unwrap(), Some(ConfirmOutcome::Approved));
        for (request, task) in waiting {
            confirmations.answer(&request.id, false).unwrap();
            assert_eq!(task.await.unwrap(), ConfirmOutcome::Declined);
        }
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
