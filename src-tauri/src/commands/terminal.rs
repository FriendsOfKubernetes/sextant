//! Terminal sessions: shell in a container (`exec_start`), shell on a node through a temporary privileged pod
//! (`node_shell_start`) and a local shell (`terminal_start`).
//! Output arrives as `term:<sessionId>` events; input, resize and stop are shared by both kinds.
//!
//! The frontend chooses the session id and subscribes to `term:<id>` before `*_start`, so output is emitted as soon
//! as the shell prints it (the first prompt, an immediate exit) and nothing is held back.
//!
//! Output is flow-controlled like a real terminal's (#122): the window acknowledges the bytes its terminal has
//! written (`term_ack`), and a session with [`OUTPUT_WINDOW`] bytes unacknowledged stops taking output from its shell
//! until acknowledgements come. Its bounded output channel then fills, so the PTY is not read and the shell blocks on
//! its writes (a container shell's websocket is not read, so the API server holds it back). Output that comes quickly
//! is gathered into one event per [`COALESCE`]; the first chunk after a quiet spell (an echoed keystroke) goes at once.

use sextant_core::exec::{self, ExecSession, TermEvent};
use sextant_core::node_shell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode, ObjectRef};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio::time::Instant;

use crate::events::{TermPayload, term_event};
use crate::pty::{self, ShellCommand};
use crate::state::{AppState, SessionGuard, TermSession, check_stream_id};

/// Shell in a container, under `stream_id` (chosen by the frontend, which already listens to `term:<streamId>`).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn exec_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    container: String,
    cols: u16,
    rows: u16,
    stream_id: String,
) -> Result<(), CoreError> {
    let open = exec::exec_shell(&state.clusters, &cluster_id, &pod, &container, cols, rows);
    start_exec(&app, &state, stream_id, cluster_id.clone(), open).await
}

/// `exec_start` once the container is known: waits for `open` (the core opening the exec connection), then
/// registers and forwards the session — unless `streams_reset` ran meanwhile, then it is dropped and the start fails.
pub async fn start_exec<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    open: impl Future<Output = CoreResult<ExecSession>>,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let session = open.await?;
    forward_term(app, state, id.clone(), Some(cluster), session, None)?;
    state.undo_if_reset(generation, || {
        state.sessions.stop(&id);
    })
}

/// Shell on `node` under `stream_id`: a temporary privileged pod in `kube-system` (image from
/// `settings.node_shell_image`), then a shell in it, which is the node's. The pod is deleted when the session ends
/// (the tab closed, the shell exited, the cluster disconnected, the window closed) or the start fails.
#[tauri::command]
pub async fn node_shell_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    node: String,
    cols: u16,
    rows: u16,
    stream_id: String,
) -> Result<(), CoreError> {
    start_node_shell(&app, &state, stream_id, cluster_id, &node, cols, rows).await
}

/// `node_shell_start`. The node shell is in `state.sessions` from the very start, before the pod is requested: until
/// the shell runs, its entry is a placeholder whose guard ([`StartingGuard`]) calls the start off when it is dropped —
/// by `term_stop`, `close_cluster`, `streams_reset` or closing the window — and the start then deletes the pod
/// ([`node_shell::create_until`]; closing the window waits for that). Once the shell runs, the placeholder is replaced
/// by the session in one step ([`finish_node_shell`]), whose guard is the pod itself, so the pod is deleted together
/// with the session. A taken `id` is `invalid` before anything starts.
pub async fn start_node_shell<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    node: &str,
    cols: u16,
    rows: u16,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let image = state.settings.get().node_shell_image;
    let cancel = node_shell::StartCancel::new();
    insert_placeholder(state, &id, &cluster, &cancel)?;
    if state.streams_generation() != generation {
        // A reset came before the placeholder was in place.
        cancel.cancel();
    }
    let started = async {
        let pod =
            node_shell::create_until(&state.clusters, &cluster, node, &image, &cancel).await?;
        let session = tokio::select! {
            session = exec::exec_shell(
                &state.clusters,
                &cluster,
                pod.pod(),
                node_shell::CONTAINER,
                cols,
                rows,
            ) => session?,
            () = cancel.cancelled() => return Err(node_shell::StartCancel::error()),
        };
        Ok((pod, session))
    }
    .await;
    // On every error below the pod (if any) is dropped, which deletes it.
    let finished = started.and_then(|(pod, session)| {
        finish_node_shell(
            app,
            state,
            id.clone(),
            cluster,
            &cancel,
            session,
            Box::new(pod),
        )
    });
    if let Err(err) = finished {
        if let Some(placeholder) = state
            .sessions
            .take_if(&id, |s| is_placeholder_of(s, &cancel))
        {
            retire_placeholder(placeholder);
        }
        return Err(err);
    }
    state.undo_if_reset(generation, || {
        state.sessions.stop(&id);
    })
}

/// Registers the placeholder of a starting node shell under `id` (with `cluster`, so disconnecting it calls the start
/// off). A taken or malformed `id` is `invalid`, and the start is called off at once.
fn insert_placeholder(
    state: &AppState,
    id: &str,
    cluster: &ClusterId,
    cancel: &node_shell::StartCancel,
) -> Result<(), CoreError> {
    // Nothing reads or ends this task: the placeholder only needs an abort handle. Ending the placeholder (also a
    // refused one) aborts it.
    let idle = tauri::async_runtime::spawn(std::future::pending::<()>());
    let (input, _) = mpsc::channel(1);
    let (resize, _) = mpsc::channel(1);
    state.sessions.insert(
        id.to_owned(),
        TermSession {
            cluster: Some(cluster.clone()),
            input,
            resize,
            task: idle.inner().abort_handle(),
            guard: Some(Box::new(StartingGuard(Some(cancel.clone())))),
        },
    )
}

/// Puts the running node shell `session` (and `pod`, its guard) in place of its placeholder in one step, so
/// `term_stop`, `close_cluster` or a reset at any moment finds one of the two and the pod never outlives them. When the
/// start was called off or the placeholder is gone, the session is dropped with `pod` (which deletes it) and the
/// start fails with [`node_shell::StartCancel::error`].
fn finish_node_shell<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    cancel: &node_shell::StartCancel,
    session: ExecSession,
    pod: SessionGuard,
) -> Result<(), CoreError> {
    if cancel.is_cancelled() {
        return Err(node_shell::StartCancel::error());
    }
    let (running, registered) = term_session(app, &id, Some(cluster), session, Some(pod));
    let placeholder = state
        .sessions
        .replace_if(&id, |s| is_placeholder_of(s, cancel), running)
        .ok_or_else(node_shell::StartCancel::error)?;
    retire_placeholder(placeholder);
    let _ = registered.send(());
    Ok(())
}

/// Ends a placeholder the start no longer needs, without calling the start off.
fn retire_placeholder(mut placeholder: TermSession) {
    if let Some(guard) = placeholder
        .guard
        .as_mut()
        .and_then(|g| g.downcast_mut::<StartingGuard>())
    {
        guard.0 = None;
    }
    placeholder.end();
}

/// The guard of a starting node shell's placeholder in `state.sessions`: dropping it calls the start off. `None` once
/// the start no longer needs it.
struct StartingGuard(Option<node_shell::StartCancel>);

impl Drop for StartingGuard {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel.cancel();
        }
    }
}

fn is_placeholder_of(session: &TermSession, cancel: &node_shell::StartCancel) -> bool {
    session
        .guard
        .as_ref()
        .and_then(|g| g.downcast_ref::<StartingGuard>())
        .and_then(|g| g.0.as_ref())
        .is_some_and(|c| c.same(cancel))
}

/// Local shell under `stream_id`. With `cluster_id`, `KUBECONFIG` points at a temporary kubeconfig of that cluster;
/// without one (e.g. to sign in to a cloud CLI) the shell gets no `KUBECONFIG` from Sextant at all.
#[tauri::command]
pub async fn terminal_start<R: Runtime>(
    app: AppHandle<R>,
    cluster_id: Option<ClusterId>,
    cols: u16,
    rows: u16,
    stream_id: String,
) -> Result<(), CoreError> {
    // Spawning blocks (forking the shell, and for zsh a probe of `/etc/zshenv` that may take up to 2 s), so it runs
    // on a blocking thread rather than an async worker. The order of the start is unchanged: the generation is taken,
    // the shell spawned and the session registered, then a reset that came meanwhile undoes it.
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let shell = pty::user_shell();
        match cluster_id {
            Some(cluster) => {
                start_local_terminal(&app, &state, stream_id, cluster, &shell, cols, rows)
            }
            None => start_plain_terminal(&app, &state, stream_id, &shell, cols, rows),
        }
    })
    .await
    .map_err(|e| CoreError::other(e.to_string()))?
}

/// Starts `shell` without a cluster: this process's environment less `KUBECONFIG` and the Helm overrides
/// ([`pty::spawn_shell`]). It belongs to no cluster, so only `term_stop`, `streams_reset` and closing the window end it.
pub fn start_plain_terminal<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    shell: &ShellCommand,
    cols: u16,
    rows: u16,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let session = pty::spawn_shell(shell, &[], cols, rows)?;
    forward_term(app, state, id.clone(), None, session, None)?;
    state.undo_if_reset(generation, || {
        state.sessions.stop(&id);
    })
}

/// Starts `shell` with `KUBECONFIG` set to a private (0600) temporary kubeconfig holding only `cluster`'s context
/// ([`pty::spawn_local_shell`]). The file, and the shell's temporary startup files, live as long as the session: they
/// are removed when the shell exits, and before `term_stop`, disconnecting the cluster, `streams_reset`, closing the
/// window or quitting the application return.
pub fn start_local_terminal<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    shell: &ShellCommand,
    cols: u16,
    rows: u16,
) -> Result<(), CoreError> {
    start_local_session(app, state, id, cluster, |kubeconfig| {
        pty::spawn_local_shell(shell, kubeconfig, cols, rows)
    })
}

/// [`start_local_terminal`] with the shell started by `spawn`, which gets the temporary kubeconfig's path.
pub fn start_local_session<R: Runtime, S: Into<pty::LocalShell>>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    spawn: impl FnOnce(&std::ffi::OsStr) -> CoreResult<S>,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    // Commands run in parallel: a reset may come while the shell is being spawned.
    let generation = state.streams_generation();
    let kubeconfig = state
        .registry
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .write_temp_kubeconfig(&cluster)?;
    let pty::LocalShell {
        session,
        startup_files,
    } = spawn(kubeconfig.as_os_str())?.into();
    forward_term(
        app,
        state,
        id.clone(),
        Some(cluster),
        session,
        Some(Box::new((kubeconfig, startup_files))),
    )?;
    state.undo_if_reset(generation, || {
        state.sessions.stop(&id);
    })
}

/// `data` is the text typed into the terminal.
#[tauri::command]
pub async fn term_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), CoreError> {
    let (input, _) = channels(&state, &session_id)?;
    input
        .send(data.into_bytes())
        .await
        .map_err(|_| not_running(&session_id))
}

#[tauri::command]
pub async fn term_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), CoreError> {
    let (_, resize) = channels(&state, &session_id)?;
    resize
        .send((cols, rows))
        .await
        .map_err(|_| not_running(&session_id))
}

/// Stops a session. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn term_stop(state: State<'_, AppState>, session_id: String) -> Result<(), CoreError> {
    state.sessions.stop(&session_id);
    Ok(())
}

/// The window's terminal has written `bytes` more bytes of the session's output. Acknowledging a session that ended
/// (or never existed) is not an error: acknowledgements may still be on their way when it exits.
#[tauri::command]
pub async fn term_ack<R: Runtime>(
    app: AppHandle<R>,
    session_id: String,
    bytes: u64,
) -> Result<(), CoreError> {
    flows(&app).ack(&session_id, usize::try_from(bytes).unwrap_or(usize::MAX));
    Ok(())
}

/// Bytes of a session's output the window may hold unacknowledged (sent, not yet written by its terminal); above this
/// the session stops reading its shell's output until acknowledgements bring it under.
pub const OUTPUT_WINDOW: usize = 2 * 1024 * 1024;
/// Output that comes quickly is gathered for at most this long into one event.
pub const COALESCE: Duration = Duration::from_millis(16);
/// Gathered output goes out at once when it reaches this size.
const MAX_EVENT: usize = 256 * 1024;

/// The flow control of one session's output: bytes emitted and not yet acknowledged by the window.
#[derive(Debug, Default)]
pub struct OutputCredit {
    unacked: Mutex<usize>,
    acked: Notify,
}

impl OutputCredit {
    /// Bytes emitted and not yet acknowledged.
    pub fn unacked(&self) -> usize {
        *lock(&self.unacked)
    }

    /// Whether `pending` more bytes (gathered, not yet emitted) leave room to take more output from the shell.
    pub fn has_room(&self, pending: usize) -> bool {
        self.unacked().saturating_add(pending) < OUTPUT_WINDOW
    }

    /// `bytes` were emitted to the window.
    pub fn sent(&self, bytes: usize) {
        let mut unacked = lock(&self.unacked);
        *unacked = unacked.saturating_add(bytes);
    }

    /// The window wrote `bytes`; wakes the session if it waits for room. More than was sent counts as everything.
    pub fn ack(&self, bytes: usize) {
        {
            let mut unacked = lock(&self.unacked);
            *unacked = unacked.saturating_sub(bytes);
        }
        // One waiter (the session's task); a wake-up with nobody waiting is kept for its next wait.
        self.acked.notify_one();
    }

    /// Resolves after the next acknowledgement (or at once if one came since the last wait).
    pub async fn acked(&self) {
        self.acked.notified().await;
    }
}

/// The [`OutputCredit`] of every running session, for `term_ack`. A session's entry lives as long as its output task
/// (it is removed when the task ends or is aborted by `term_stop`, `close_cluster`, `streams_reset` or closing the
/// window), so nothing here outlives a session.
#[derive(Debug, Default)]
pub struct TermFlows(Mutex<HashMap<String, Arc<OutputCredit>>>);

impl TermFlows {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<OutputCredit>>> {
        lock(&self.0)
    }

    fn register(&self, id: &str, credit: &Arc<OutputCredit>) {
        self.lock().insert(id.to_owned(), Arc::clone(credit));
    }

    /// Forgets `id` if it is still `credit` (a new session may have taken the id since).
    fn unregister(&self, id: &str, credit: &Arc<OutputCredit>) {
        let mut map = self.lock();
        if map.get(id).is_some_and(|c| Arc::ptr_eq(c, credit)) {
            map.remove(id);
        }
    }

    /// Acknowledges `bytes` of the session `id`; `false` if it is not running.
    pub fn ack(&self, id: &str, bytes: usize) -> bool {
        let credit = self.lock().get(id).cloned();
        credit.map(|c| c.ack(bytes)).is_some()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The application's [`TermFlows`], managed on first use.
pub fn flows<R: Runtime>(app: &AppHandle<R>) -> State<'_, TermFlows> {
    if app.try_state::<TermFlows>().is_none() {
        app.manage(TermFlows::default());
    }
    app.state::<TermFlows>()
}

/// A session's entry in [`TermFlows`], removed when its output task ends or is aborted.
struct FlowEntry<R: Runtime> {
    app: AppHandle<R>,
    id: String,
    credit: Arc<OutputCredit>,
}

impl<R: Runtime> FlowEntry<R> {
    fn new(app: &AppHandle<R>, id: &str) -> Self {
        let credit = Arc::new(OutputCredit::default());
        flows(app).register(id, &credit);
        Self {
            app: app.clone(),
            id: id.to_owned(),
            credit,
        }
    }
}

impl<R: Runtime> Drop for FlowEntry<R> {
    fn drop(&mut self) {
        if let Some(flows) = self.app.try_state::<TermFlows>() {
            flows.unregister(&self.id, &self.credit);
        }
    }
}

fn channels(state: &AppState, id: &str) -> Result<crate::state::TermChannels, CoreError> {
    state.sessions.channels(id).ok_or_else(|| not_running(id))
}

fn not_running(id: &str) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("terminal session {id} is not running"),
    )
}

/// Registers `session` in `state.sessions` under `id` (and `cluster`, so disconnecting the cluster stops it) and
/// emits its output as `term:<id>`. `guard` lives exactly as long as the session (e.g. its temporary kubeconfig) and
/// is dropped synchronously when the session is stopped. A taken or malformed `id` is `invalid`.
pub fn forward_term<R>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: Option<ClusterId>,
    session: ExecSession,
    guard: Option<SessionGuard>,
) -> Result<(), CoreError>
where
    R: Runtime,
{
    let (running, registered) = term_session(app, &id, cluster, session, guard);
    state.sessions.insert(id, running)?;
    let _ = registered.send(());
    Ok(())
}

/// The entry of `session` for `state.sessions` and the task that emits its output as `term:<id>`, which starts once
/// the returned sender is used (after the entry is registered); dropping the sender or ending the entry ends the task.
fn term_session<R>(
    app: &AppHandle<R>,
    id: &str,
    cluster: Option<ClusterId>,
    session: ExecSession,
    guard: Option<SessionGuard>,
) -> (TermSession, oneshot::Sender<()>)
where
    R: Runtime,
{
    let event = term_event(id);
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);
    let (registered_tx, registered_rx) = oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.to_owned();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        let flow = FlowEntry::new(&handle, &own_id);
        let credit = &flow.credit;
        let ExecSession {
            input,
            resize,
            mut output,
        } = session;
        let emit = |payload: &TermPayload| handle.emit(&event, payload).is_ok();
        // Output taken from the shell and not emitted yet, and when output was last emitted.
        let mut pending: Vec<u8> = Vec::new();
        let mut last_emit: Option<Instant> = None;
        loop {
            let room = credit.has_room(pending.len());
            let next_emit = last_emit.map_or_else(Instant::now, |t| t + COALESCE);
            tokio::select! {
                keys = input_rx.recv() => {
                    let Some(keys) = keys else { break };
                    let _ = input.send(keys).await;
                }
                size = resize_rx.recv() => {
                    let Some(size) = size else { break };
                    let _ = resize.send(size).await;
                }
                // The window is behind: the shell's output stays in its channel until acknowledgements come.
                () = credit.acked(), if !room => {}
                () = tokio::time::sleep_until(next_emit), if !pending.is_empty() => {}
                event_out = output.recv(), if room => {
                    let (payload, last) = match event_out {
                        Some(TermEvent::Data(bytes)) => {
                            pending.extend_from_slice(&bytes);
                            (None, false)
                        }
                        Some(ev) => {
                            let (payload, last) = payload_of(ev);
                            (Some(payload), last)
                        }
                        None => (Some(TermPayload::Exit { code: None }), true),
                    };
                    if let Some(payload) = payload {
                        // What the shell printed before it ended goes first.
                        if !pending.is_empty() && !emit(&TermPayload::data(&pending)) {
                            break;
                        }
                        pending.clear();
                        if !emit(&payload) || last {
                            break;
                        }
                    }
                }
            }
            let due = last_emit.is_none_or(|t| t.elapsed() >= COALESCE);
            if !pending.is_empty() && (due || pending.len() >= MAX_EVENT) {
                credit.sent(pending.len());
                if !emit(&TermPayload::data(&pending)) {
                    break;
                }
                pending.clear();
                last_emit = Some(Instant::now());
            }
        }
        drop(flow);
        if let Some(state) = handle.try_state::<AppState>() {
            state.sessions.remove(&own_id);
        }
    });
    let running = TermSession {
        cluster,
        input: input_tx,
        resize: resize_tx,
        task: task.inner().abort_handle(),
        guard,
    };
    (running, registered_tx)
}

/// The payload of `event`, and whether it ends the session.
fn payload_of(event: TermEvent) -> (TermPayload, bool) {
    match event {
        TermEvent::Data(bytes) => (TermPayload::data(&bytes), false),
        TermEvent::Exit { code } => (TermPayload::Exit { code }, true),
        TermEvent::Error(error) => (TermPayload::Error { error }, true),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc as std_mpsc;
    use std::time::{Duration, Instant};

    use serde_json::{Value, json};
    use tauri::Listener;

    use super::*;

    fn app() -> (tauri::App<tauri::test::MockRuntime>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        app.manage(AppState::new(
            &dir.path().join("config"),
            &dir.path().join("data"),
        ));
        (app, dir)
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The far side of a session: what the core (or the PTY) would hold.
    struct FakeShell {
        input: mpsc::Receiver<Vec<u8>>,
        resize: mpsc::Receiver<(u16, u16)>,
        output: mpsc::Sender<TermEvent>,
    }

    fn fake_session() -> (ExecSession, FakeShell) {
        let (input_tx, input_rx) = mpsc::channel(16);
        let (resize_tx, resize_rx) = mpsc::channel(16);
        let (output_tx, output_rx) = mpsc::channel(16);
        (
            ExecSession {
                input: input_tx,
                resize: resize_tx,
                output: output_rx,
            },
            FakeShell {
                input: input_rx,
                resize: resize_rx,
                output: output_tx,
            },
        )
    }

    /// Every payload of `term:<id>`, as JSON.
    fn listen<R: Runtime>(app: &tauri::App<R>, id: &str) -> std_mpsc::Receiver<Value> {
        let (tx, rx) = std_mpsc::channel();
        app.listen_any(term_event(id), move |event| {
            let _ = tx.send(serde_json::from_str(event.payload()).unwrap());
        });
        rx
    }

    fn next(rx: &std_mpsc::Receiver<Value>) -> Value {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("a term event")
    }

    fn temp_guard() -> (Option<SessionGuard>, std::path::PathBuf) {
        let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let path = guard.to_path_buf();
        (Some(Box::new(guard)), path)
    }

    #[test]
    fn output_right_after_the_start_reaches_a_listener_subscribed_before_it_without_input() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, mut shell) = fake_session();
        // The prompt is printed at once, before `exec_start` has even answered.
        shell
            .output
            .try_send(TermEvent::Data(b"prompt$ ".to_vec()))
            .unwrap();
        // The window listens first, then starts the session under the id it chose; it types nothing.
        let events = listen(&app, "t-early");
        forward_term(
            app.handle(),
            &state,
            "t-early".into(),
            Some(ClusterId::from("c")),
            session,
            None,
        )
        .unwrap();
        assert_eq!(
            next(&events),
            json!({ "type": "data", "data": "cHJvbXB0JCA=" })
        );

        // Output keeps flowing; input and resizes reach the shell.
        shell
            .output
            .blocking_send(TermEvent::Data(b"ls".to_vec()))
            .unwrap();
        assert_eq!(next(&events), json!({ "type": "data", "data": "bHM=" }));
        let (input, resize) = state.sessions.channels("t-early").unwrap();
        resize.blocking_send((100, 30)).unwrap();
        assert_eq!(shell.resize.blocking_recv(), Some((100, 30)));
        input.blocking_send(b"x".to_vec()).unwrap();
        assert_eq!(shell.input.blocking_recv(), Some(b"x".to_vec()));
    }

    #[test]
    fn an_immediate_exit_reaches_the_listener_and_ends_the_session() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, shell) = fake_session();
        let (guard, guard_path) = temp_guard();
        shell
            .output
            .try_send(TermEvent::Data(b"bye".to_vec()))
            .unwrap();
        shell
            .output
            .try_send(TermEvent::Exit { code: Some(2) })
            .unwrap();
        drop(shell);
        let events = listen(&app, "t-1");
        forward_term(app.handle(), &state, "t-1".into(), None, session, guard).unwrap();

        assert_eq!(next(&events), json!({ "type": "data", "data": "Ynll" }));
        assert_eq!(next(&events), json!({ "type": "exit", "code": 2 }));
        // The guard goes with the session.
        wait_until("the session and its guard to be gone", || {
            state.sessions.is_empty() && !guard_path.exists()
        });
    }

    #[test]
    fn output_credit_has_room_below_the_window_only_and_an_ack_wakes_the_waiter() {
        let credit = OutputCredit::default();
        assert!(credit.has_room(0));
        credit.sent(OUTPUT_WINDOW - 10);
        assert!(credit.has_room(9));
        assert!(!credit.has_room(10), "gathered output counts too");
        credit.sent(10);
        assert!(!credit.has_room(0));
        credit.ack(OUTPUT_WINDOW - 1);
        assert_eq!(credit.unacked(), 1);
        assert!(credit.has_room(0));
        credit.ack(usize::MAX);
        assert_eq!(
            credit.unacked(),
            0,
            "more than was sent counts as everything"
        );
        // An ack that came before the wait still wakes it.
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(5), credit.acked())
                .await
                .expect("the ack woke the waiter");
        });
    }

    /// Bytes of the `data` payloads that arrived within `quiet` of each other (for 5 s at most: output that never stops
    /// is a failure, not a hang), and how many payloads that was.
    fn received_bytes(events: &std_mpsc::Receiver<Value>, quiet: Duration) -> (usize, usize) {
        use base64::Engine as _;
        let deadline = Instant::now() + Duration::from_secs(5);
        let (mut bytes, mut payloads) = (0, 0);
        while Instant::now() < deadline
            && let Ok(event) = events.recv_timeout(quiet)
        {
            if event["type"] == "data" {
                bytes += base64::engine::general_purpose::STANDARD
                    .decode(event["data"].as_str().unwrap())
                    .unwrap()
                    .len();
                payloads += 1;
            }
        }
        (bytes, payloads)
    }

    /// Reads `events` until `at_least` bytes came in all, then while more keep coming; the total.
    fn receive_until(events: &std_mpsc::Receiver<Value>, total: &mut usize, at_least: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while *total < at_least {
            assert!(
                Instant::now() < deadline,
                "only {total} of {at_least} bytes came"
            );
            *total += received_bytes(events, Duration::from_millis(50)).0;
        }
        // Whatever the session still sends before it stops for want of acks.
        *total += received_bytes(events, Duration::from_millis(300)).0;
    }

    #[test]
    fn output_quickly_after_output_is_gathered_into_one_event() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, shell) = fake_session();
        for i in 0..16u8 {
            shell
                .output
                .try_send(TermEvent::Data(vec![b'a' + i]))
                .unwrap();
        }
        let events = listen(&app, "t-burst");
        forward_term(app.handle(), &state, "t-burst".into(), None, session, None).unwrap();
        let (bytes, payloads) = received_bytes(&events, Duration::from_millis(500));
        assert_eq!(bytes, 16);
        assert!(payloads < 16, "{payloads} events for 16 chunks");
    }

    #[test]
    fn a_session_takes_no_output_above_the_window_until_acked_and_its_stop_releases_the_producer() {
        const CHUNK: usize = 64 * 1024;
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, shell) = fake_session();
        // A shell that prints without a pause, as fast as its output is taken.
        let produced = Arc::new(AtomicUsize::new(0));
        let (done_tx, done_rx) = std_mpsc::channel();
        let producer = {
            let (output, produced) = (shell.output.clone(), Arc::clone(&produced));
            std::thread::spawn(move || {
                while output
                    .blocking_send(TermEvent::Data(vec![b'y'; CHUNK]))
                    .is_ok()
                {
                    produced.fetch_add(CHUNK, Ordering::SeqCst);
                }
                let _ = done_tx.send(());
            })
        };
        let events = listen(&app, "t-flood");
        forward_term(app.handle(), &state, "t-flood".into(), None, session, None).unwrap();

        // Nothing is acknowledged: the session stops at the window, and so does the producer.
        let mut total = 0;
        receive_until(&events, &mut total, OUTPUT_WINDOW);
        assert!(
            total < OUTPUT_WINDOW + CHUNK,
            "{total} bytes sent unacknowledged"
        );
        let stalled = produced.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            produced.load(Ordering::SeqCst),
            stalled,
            "the producer kept going"
        );
        assert!(
            stalled <= total + 17 * CHUNK,
            "{stalled} produced, {total} sent"
        );

        // Acknowledging what was written lets the next window through, and no more.
        tauri::async_runtime::block_on(term_ack(
            app.handle().clone(),
            "t-flood".into(),
            total as u64,
        ))
        .unwrap();
        let acked = total;
        receive_until(&events, &mut total, acked + OUTPUT_WINDOW);
        assert!(
            total < acked + OUTPUT_WINDOW + CHUNK,
            "{} bytes sent unacknowledged",
            total - acked
        );

        // Closing the tab releases the stalled producer and forgets the session's credit.
        state.sessions.stop("t-flood");
        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the producer was released");
        producer.join().unwrap();
        wait_until("the credit to be forgotten", || {
            flows(app.handle()).is_empty()
        });
        // An ack that comes after the session is gone is not an error.
        tauri::async_runtime::block_on(term_ack(app.handle().clone(), "t-flood".into(), 1))
            .unwrap();
    }

    /// A real shell running `yes`: without acknowledgements the PTY is read up to the window only, then `yes` blocks.
    #[cfg(unix)]
    #[test]
    fn yes_in_a_local_terminal_stops_at_the_window_and_resumes_after_acks() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let sh = ShellCommand {
            program: "/bin/sh".into(),
            args: Vec::new(),
        };
        let events = listen(&app, "yes-1");
        start_plain_terminal(app.handle(), &state, "yes-1".into(), &sh, 80, 24).unwrap();
        let (input, _) = state.sessions.channels("yes-1").unwrap();
        input.blocking_send(b"yes\n".to_vec()).unwrap();

        let mut total = 0;
        receive_until(&events, &mut total, OUTPUT_WINDOW);
        // One PTY read (16 KiB) may come on top of the window.
        assert!(
            total < OUTPUT_WINDOW + 16 * 1024,
            "{total} bytes sent unacknowledged"
        );

        tauri::async_runtime::block_on(term_ack(
            app.handle().clone(),
            "yes-1".into(),
            total as u64,
        ))
        .unwrap();
        let acked = total;
        receive_until(&events, &mut total, acked + OUTPUT_WINDOW);
        assert!(
            total < acked + OUTPUT_WINDOW + 16 * 1024,
            "{} bytes sent unacknowledged",
            total - acked
        );

        state.sessions.stop("yes-1");
        assert!(state.sessions.is_empty());
        wait_until("the credit to be forgotten", || {
            flows(app.handle()).is_empty()
        });
    }

    #[test]
    fn a_taken_session_id_is_invalid_and_drops_the_new_session() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, first) = fake_session();
        forward_term(app.handle(), &state, "t-1".into(), None, session, None).unwrap();
        let (session, second) = fake_session();
        let (guard, guard_path) = temp_guard();
        let err = forward_term(app.handle(), &state, "t-1".into(), None, session, guard)
            .expect_err("the id is taken");
        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(
            !guard_path.exists(),
            "the rejected session's guard is dropped"
        );
        wait_until("the rejected session to be dropped", || {
            second.output.is_closed()
        });
        assert!(!first.output.is_closed());
        assert_eq!(state.sessions.len(), 1);
    }

    #[test]
    fn a_running_node_shell_takes_its_placeholders_place_and_goes_with_its_cluster() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c-1");
        let cancel = node_shell::StartCancel::new();
        insert_placeholder(&state, "n-1", &cluster, &cancel).unwrap();
        let (session, shell) = fake_session();
        let (guard, pod) = temp_guard();

        finish_node_shell(
            app.handle(),
            &state,
            "n-1".into(),
            cluster.clone(),
            &cancel,
            session,
            guard.unwrap(),
        )
        .unwrap();

        assert_eq!(state.sessions.len(), 1);
        assert!(state.sessions.channels("n-1").is_some());
        assert!(
            !cancel.is_cancelled(),
            "retiring the placeholder does not call the start off"
        );
        assert!(pod.exists(), "the pod lives with the session");
        state.close_cluster(&cluster);
        assert!(
            !pod.exists(),
            "closing the cluster deletes the pod before it returns"
        );
        assert!(state.sessions.is_empty());
        wait_until("the shell to be dropped", || shell.output.is_closed());
    }

    #[test]
    fn a_node_shell_stopped_before_its_shell_registers_keeps_no_session_and_no_pod() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c-1");
        let cancel = node_shell::StartCancel::new();
        insert_placeholder(&state, "n-1", &cluster, &cancel).unwrap();
        state.sessions.stop("n-1");
        assert!(cancel.is_cancelled(), "term_stop calls the start off");
        let (session, shell) = fake_session();
        let (guard, pod) = temp_guard();

        let err = finish_node_shell(
            app.handle(),
            &state,
            "n-1".into(),
            cluster,
            &cancel,
            session,
            guard.unwrap(),
        )
        .expect_err("nobody wants it");

        assert_eq!(err.message, node_shell::StartCancel::error().message);
        assert!(!pod.exists(), "the pod is deleted");
        assert!(state.sessions.is_empty());
        wait_until("the shell to be dropped", || shell.output.is_closed());
    }

    #[test]
    fn a_node_shell_whose_id_is_taken_is_invalid_and_leaves_the_other_session() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, first) = fake_session();
        forward_term(app.handle(), &state, "t-1".into(), None, session, None).unwrap();
        let cancel = node_shell::StartCancel::new();

        let err = insert_placeholder(&state, "t-1", &ClusterId::from("c-1"), &cancel)
            .expect_err("the id is taken");

        assert_eq!(err.code, ErrorCode::Invalid, "{err}");
        assert!(cancel.is_cancelled(), "the start is called off at once");
        assert_eq!(state.sessions.len(), 1);
        assert!(!first.output.is_closed());
    }

    #[test]
    fn stop_disconnect_and_window_close_drop_the_guards_before_they_return() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let start = |id: &str, cluster: &str| {
            let (session, shell) = fake_session();
            let (guard, path) = temp_guard();
            forward_term(
                app.handle(),
                &state,
                id.into(),
                Some(ClusterId::from(cluster)),
                session,
                guard,
            )
            .unwrap();
            (shell, path)
        };

        let (shell, path) = start("t-1", "a");
        state.sessions.stop("t-1");
        assert!(!path.exists(), "stop returned with the guard still alive");
        wait_until("the stopped session's shell to see the hang-up", || {
            shell.output.is_closed()
        });

        let (a_shell, a_path) = start("t-2", "a");
        let (b_shell, b_path) = start("t-3", "b");
        state.close_cluster(&ClusterId::from("a"));
        assert!(
            !a_path.exists(),
            "close_cluster returned with the guard still alive"
        );
        wait_until("cluster a's session to end", || a_shell.output.is_closed());
        assert!(b_path.exists() && !b_shell.output.is_closed());
        assert_eq!(state.sessions.len(), 1);

        state.close_all();
        assert!(
            !b_path.exists(),
            "close_all returned with the guard still alive"
        );
        assert!(state.sessions.is_empty());
        wait_until("every session to end", || b_shell.output.is_closed());
    }

    /// A kubeconfig with one context; its token must never reach the window.
    #[cfg(unix)]
    const FIXTURE_TOKEN: &str = "fixture-token-not-for-events";

    #[cfg(unix)]
    fn kubeconfig_fixture(dir: &std::path::Path) -> std::path::PathBuf {
        let path = dir.join("fixture-kubeconfig.yaml");
        std::fs::write(
            &path,
            format!(
                "apiVersion: v1\nkind: Config\ncurrent-context: other\n\
                 clusters:\n- name: fixture\n  cluster:\n    server: https://127.0.0.1:1\n\
                 users:\n- name: fixture-user\n  user:\n    token: {FIXTURE_TOKEN}\n\
                 contexts:\n- name: fixture-ctx\n  context:\n    cluster: fixture\n    user: fixture-user\n\
                 - name: other\n  context:\n    cluster: fixture\n    user: fixture-user\n"
            ),
        )
        .unwrap();
        path
    }

    /// The path printed by `echo "KC=$KUBECONFIG"` (not the echoed command line itself, which has
    /// `KC=$`). The output may follow a prompt on the same line.
    #[cfg(unix)]
    fn printed_kubeconfig(text: &str) -> Option<std::path::PathBuf> {
        text.match_indices("KC=/")
            .map(|(i, _)| &text[i + 3..])
            .map(|rest| {
                rest.split(['\r', '\n', ' ', '"'])
                    .next()
                    .unwrap_or_default()
            })
            .find(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
    }

    #[cfg(unix)]
    fn kubeconfig_path_in(text: &str) -> std::path::PathBuf {
        printed_kubeconfig(text).unwrap_or_else(|| panic!("KUBECONFIG is not set: {text:?}"))
    }

    #[cfg(unix)]
    fn kubectl_available() -> bool {
        std::process::Command::new("kubectl")
            .args(["version", "--client"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Text of every `data` payload so far, and whether an exit arrived.
    #[cfg(unix)]
    fn read_text(
        events: &std_mpsc::Receiver<Value>,
        text: &mut String,
        done: impl Fn(&str) -> bool,
    ) {
        use base64::Engine as _;
        let deadline = Instant::now() + Duration::from_secs(20);
        while !done(text) {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = events
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("timed out; output so far: {text:?}"));
            assert!(
                !event.to_string().contains(FIXTURE_TOKEN),
                "credentials in a term event"
            );
            match event["type"].as_str() {
                Some("data") => {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(event["data"].as_str().unwrap())
                        .unwrap();
                    text.push_str(&String::from_utf8_lossy(&bytes));
                }
                Some("exit") => text.push_str(&format!("\n<exit {}>", event["code"])),
                _ => panic!("unexpected event {event}"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn local_terminal_points_kubectl_at_the_cluster_through_a_private_temp_file() {
        let (app, dir) = app();
        let state = app.state::<AppState>();
        let kubeconfig = kubeconfig_fixture(dir.path());
        let cluster = {
            let mut registry = state.registry.write().unwrap();
            registry.set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: Some(kubeconfig.clone().into_os_string()),
                home: None,
            });
            registry
                .clusters()
                .unwrap()
                .into_iter()
                .find(|c| c.context == "fixture-ctx")
                .unwrap()
                .id
        };
        let sh = ShellCommand {
            program: "/bin/sh".into(),
            args: Vec::new(),
        };
        let events = listen(&app, "local-1");
        start_local_terminal(
            app.handle(),
            &state,
            "local-1".into(),
            cluster.clone(),
            &sh,
            80,
            24,
        )
        .unwrap();
        let (input, _) = state.sessions.channels("local-1").unwrap();

        let kubectl = kubectl_available();
        let line = if kubectl {
            "echo \"KC=$KUBECONFIG\"; echo \"CTX=$(kubectl config current-context)\"\n"
        } else {
            "echo \"KC=$KUBECONFIG\"; printf 'CTX=%s\\n' fixture-ctx\n"
        };
        input.blocking_send(line.as_bytes().to_vec()).unwrap();
        let mut text = String::new();
        // The tty echoes the typed line, possibly long before a slow shell runs it, so neither
        // expected string appears in the command itself: only the shell's output can match.
        read_text(&events, &mut text, |t| {
            printed_kubeconfig(t).is_some() && t.contains("CTX=fixture-ctx")
        });
        let temp = kubeconfig_path_in(&text);
        assert_ne!(temp, kubeconfig, "a private copy, not the user's file");
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&temp).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Closing the tab (term_stop) removes the file before it returns.
        state.sessions.stop("local-1");
        assert!(!temp.exists(), "the temp kubeconfig outlived term_stop");

        // So does the shell exiting by itself.
        let events = listen(&app, "local-2");
        start_local_terminal(
            app.handle(),
            &state,
            "local-2".into(),
            cluster.clone(),
            &sh,
            80,
            24,
        )
        .unwrap();
        let (input, _) = state.sessions.channels("local-2").unwrap();
        input
            .blocking_send(b"echo \"KC=$KUBECONFIG\"; exit 4\n".to_vec())
            .unwrap();
        let mut text = String::new();
        read_text(&events, &mut text, |t| t.contains("<exit 4>"));
        let temp = kubeconfig_path_in(&text);
        wait_until("the exited session to be forgotten", || {
            state.sessions.is_empty()
        });
        wait_until("its temp kubeconfig to be removed", || !temp.exists());

        // And disconnecting the cluster / closing the window.
        start_local_terminal(
            app.handle(),
            &state,
            "local-3".into(),
            cluster.clone(),
            &sh,
            80,
            24,
        )
        .unwrap();
        assert!(state.sessions.channels("local-3").is_some());
        state.close_cluster(&cluster);
        assert!(state.sessions.is_empty());
        start_local_terminal(app.handle(), &state, "local-4".into(), cluster, &sh, 80, 24).unwrap();
        assert!(state.sessions.channels("local-4").is_some());
        state.close_all();
        assert!(state.sessions.is_empty());
        // The window closed: no copy of these credentials is left in the temp directory, right away. Only this
        // process's files count (their names carry its PID): another test run or app instance may hold its own.
        let own = format!(
            "{}{}-",
            sextant_core::kubeconfig::TEMP_KUBECONFIG_PREFIX,
            std::process::id()
        );
        let leftovers = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(&own))
            .filter(|e| std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains(FIXTURE_TOKEN)))
            .count();
        assert_eq!(leftovers, 0, "a temp kubeconfig outlived close_all");
    }

    #[test]
    fn a_local_terminal_that_outlived_streams_reset_leaves_no_session_and_no_temp_kubeconfig() {
        let (app, dir) = app();
        let state = app.state::<AppState>();
        let kubeconfig = dir.path().join("one-context.yaml");
        std::fs::write(
            &kubeconfig,
            "apiVersion: v1\nkind: Config\ncurrent-context: ctx\n\
             clusters:\n- name: c\n  cluster:\n    server: https://127.0.0.1:1\n\
             users:\n- name: u\n  user:\n    token: t\n\
             contexts:\n- name: ctx\n  context:\n    cluster: c\n    user: u\n",
        )
        .unwrap();
        let cluster = {
            let mut registry = state.registry.write().unwrap();
            registry.set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: Some(kubeconfig.into_os_string()),
                home: None,
            });
            registry.clusters().unwrap()[0].id.clone()
        };

        // A reloaded page resets the streams while the old page's shell is being spawned.
        let mut temp = None;
        let (session, shell) = fake_session();
        let result = start_local_session(app.handle(), &state, "local-1".into(), cluster, |path| {
            temp = Some(std::path::PathBuf::from(path));
            state.reset_streams();
            Ok(session)
        });

        assert!(result.is_err(), "a start that outlived the reset succeeded");
        assert!(state.sessions.is_empty(), "the session outlived the reset");
        let temp = temp.expect("the shell was spawned");
        assert!(!temp.exists(), "the temp kubeconfig outlived the reset");
        wait_until("the late shell to be dropped", || shell.output.is_closed());
    }

    #[test]
    fn a_local_terminal_for_an_unknown_cluster_is_an_error() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let err = start_local_terminal(
            app.handle(),
            &state,
            "local-x".into(),
            ClusterId::from("missing"),
            &pty::user_shell(),
            80,
            24,
        )
        .expect_err("no such cluster");
        assert_ne!(err.code, ErrorCode::Other, "{err}");
        assert!(state.sessions.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_without_a_cluster_gets_no_kubeconfig_and_ends_with_the_window() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let sh = ShellCommand {
            program: "/bin/sh".into(),
            args: Vec::new(),
        };
        let events = listen(&app, "plain-1");
        start_plain_terminal(app.handle(), &state, "plain-1".into(), &sh, 80, 24).unwrap();
        let (input, _) = state.sessions.channels("plain-1").unwrap();
        input
            .blocking_send(b"echo \"KC=[$KUBECONFIG]\" \"N=$((40+2))\"\n".to_vec())
            .unwrap();
        let mut text = String::new();
        read_text(&events, &mut text, |t| t.contains("N=42"));
        assert!(text.contains("KC=[] N=42"), "{text:?}");
        state.close_all();
        assert!(state.sessions.is_empty());
    }

    /// The command spawns the shell off the async workers (a zsh probe may block for seconds) and still registers the
    /// session before it returns; a malformed id is refused the same way.
    #[cfg(unix)]
    #[test]
    fn terminal_start_registers_the_session_spawned_on_a_blocking_thread() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        tauri::async_runtime::block_on(terminal_start(
            app.handle().clone(),
            None,
            80,
            24,
            "plain-cmd".into(),
        ))
        .unwrap();
        assert!(state.sessions.channels("plain-cmd").is_some());
        let err = tauri::async_runtime::block_on(terminal_start(
            app.handle().clone(),
            None,
            80,
            24,
            "bad id".into(),
        ))
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Invalid);
        state.close_all();
        assert!(state.sessions.is_empty());
    }

    #[cfg(unix)]
    /// Node shell pods of this run on the test cluster (`kube-system`, label `sextant.dev/session`).
    fn node_shell_pods(state: &AppState, cluster: &ClusterId) -> Vec<String> {
        let selector = format!(
            "{}=true,{}={}",
            node_shell::LABEL_NODE_SHELL,
            node_shell::LABEL_SESSION,
            node_shell::session_id()
        );
        let pod = sextant_core::KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        };
        let page = tauri::async_runtime::block_on(sextant_core::resources::list(
            &state.clusters,
            cluster,
            &pod,
            Some(node_shell::NAMESPACE),
            Some(&selector),
            None,
            50,
        ))
        .unwrap();
        page.items
            .iter()
            .filter_map(|p| p["metadata"]["name"].as_str().map(str::to_owned))
            .collect()
    }

    #[cfg(unix)]
    fn wait_no_node_shell_pods(state: &AppState, cluster: &ClusterId, when: &str) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let left = node_shell_pods(state, cluster);
            if left.is_empty() {
                return;
            }
            assert!(Instant::now() < deadline, "{when}: pods left {left:?}");
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// The tests that make node shell pods run one at a time: they count this run's pods, and closing the window
    /// waits for every node shell of the process.
    #[cfg(unix)]
    static NODE_SHELL_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Needs the kind test cluster (`SEXTANT_TEST_KUBECONFIG`); privileged pods are allowed in its `kube-system`.
    #[cfg(unix)]
    #[test]
    fn a_node_shell_pod_goes_with_its_session_its_cluster_and_the_window() {
        let _one_at_a_time = NODE_SHELL_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(kubeconfig) =
            std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return;
        };
        let (app, dir) = app();
        let state = app.state::<AppState>();
        let cluster = {
            let mut registry = state.registry.write().unwrap();
            registry.set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: Some(kubeconfig),
                home: Some(dir.path().join("home")),
            });
            registry.clusters().unwrap()[0].id.clone()
        };
        let connect = |state: &AppState| {
            tauri::async_runtime::block_on(state.clusters.connect(&cluster)).unwrap();
        };
        connect(&state);
        let node = {
            let kind = sextant_core::KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Node".into(),
            };
            let nodes = tauri::async_runtime::block_on(sextant_core::resources::list(
                &state.clusters,
                &cluster,
                &kind,
                None,
                None,
                None,
                1,
            ))
            .unwrap();
            nodes.items[0]["metadata"]["name"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let start = |id: &str| {
            let events = listen(&app, id);
            tauri::async_runtime::block_on(start_node_shell(
                app.handle(),
                &state,
                id.into(),
                cluster.clone(),
                &node,
                80,
                24,
            ))
            .expect("the node shell starts");
            assert_eq!(node_shell_pods(&state, &cluster).len(), 1);
            events
        };

        // The shell is the node's; closing the tab (term_stop) deletes the pod.
        let events = start("node-1");
        let (input, _) = state.sessions.channels("node-1").unwrap();
        input.blocking_send(b"hostname\n".to_vec()).unwrap();
        let mut text = String::new();
        read_text(&events, &mut text, |t| {
            t.split(['\r', '\n']).any(|l| l == node)
        });
        state.sessions.stop("node-1");
        wait_no_node_shell_pods(&state, &cluster, "after term_stop");

        // Disconnecting the cluster deletes it, although the manager no longer has the cluster's client.
        start("node-2");
        tauri::async_runtime::block_on(state.clusters.disconnect(&cluster));
        state.close_cluster(&cluster);
        assert!(state.sessions.is_empty());
        connect(&state);
        wait_no_node_shell_pods(&state, &cluster, "after the cluster was closed");

        // Closing the window waits for the deletion to be sent.
        start("node-3");
        state.close_all();
        assert!(state.sessions.is_empty());
        wait_no_node_shell_pods(&state, &cluster, "after the window closed");
    }

    /// Removes this run's node shell pods at once (`gracePeriodSeconds=0`): a pod whose image never arrives is let go
    /// by the kubelet only minutes after its deletion.
    #[cfg(unix)]
    fn force_delete_node_shell_pods(state: &AppState, cluster: &ClusterId) {
        let client = state.clusters.client(cluster).unwrap();
        for name in node_shell_pods(state, cluster) {
            let request = tauri::http::Request::delete(format!(
                "/api/v1/namespaces/{}/pods/{name}?gracePeriodSeconds=0",
                node_shell::NAMESPACE
            ))
            .body(Vec::new())
            .unwrap();
            let _ = tauri::async_runtime::block_on(client.request_text(request));
        }
    }

    /// The deletion of every node shell pod of this run was requested (or they are gone).
    #[cfg(unix)]
    fn node_shell_pods_deleted(state: &AppState, cluster: &ClusterId) -> bool {
        let selector = format!(
            "{}=true,{}={}",
            node_shell::LABEL_NODE_SHELL,
            node_shell::LABEL_SESSION,
            node_shell::session_id()
        );
        let pod = sextant_core::KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        };
        let page = tauri::async_runtime::block_on(sextant_core::resources::list(
            &state.clusters,
            cluster,
            &pod,
            Some(node_shell::NAMESPACE),
            Some(&selector),
            None,
            50,
        ))
        .unwrap();
        page.items
            .iter()
            .all(|p| !p["metadata"]["deletionTimestamp"].is_null())
    }

    /// A node shell is in `AppState` from the start, before its pod runs: closing the tab, the cluster or the window
    /// while the pod starts calls the start off and deletes the pod; closing the window waits for that deletion.
    #[cfg(unix)]
    #[test]
    fn a_node_shell_closed_while_its_pod_starts_leaves_no_pod() {
        let _one_at_a_time = NODE_SHELL_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let Some(kubeconfig) =
            std::env::var_os("SEXTANT_TEST_KUBECONFIG").filter(|v| !v.is_empty())
        else {
            eprintln!("skipped: SEXTANT_TEST_KUBECONFIG is not set (see scripts/test-cluster.sh)");
            return;
        };
        let (app, dir) = app();
        let state = app.state::<AppState>();
        // The registry never answers: the pod stays in ContainerCreating.
        state
            .settings
            .update(|s| s.node_shell_image = "10.255.255.1:5000/sextant/never:1".into())
            .unwrap();
        let cluster = {
            let mut registry = state.registry.write().unwrap();
            registry.set_env(sextant_core::kubeconfig::KubeconfigEnv {
                kubeconfig: Some(kubeconfig),
                home: Some(dir.path().join("home")),
            });
            registry.clusters().unwrap()[0].id.clone()
        };
        tauri::async_runtime::block_on(state.clusters.connect(&cluster)).unwrap();
        let node = {
            let kind = sextant_core::KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Node".into(),
            };
            let nodes = tauri::async_runtime::block_on(sextant_core::resources::list(
                &state.clusters,
                &cluster,
                &kind,
                None,
                None,
                None,
                1,
            ))
            .unwrap();
            nodes.items[0]["metadata"]["name"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let start = |id: &str| {
            let (handle, id, target, node) = (
                app.handle().clone(),
                id.to_owned(),
                cluster.clone(),
                node.clone(),
            );
            let task = tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                start_node_shell(&handle, &state, id, target, &node, 80, 24).await
            });
            let deadline = Instant::now() + Duration::from_secs(30);
            while node_shell_pods(&state, &cluster).is_empty() {
                assert!(Instant::now() < deadline, "the pod was not made");
                std::thread::sleep(Duration::from_millis(200));
            }
            assert_eq!(
                state.sessions.len(),
                1,
                "the starting node shell is not in AppState"
            );
            task
        };
        let result = |task: tauri::async_runtime::JoinHandle<Result<(), CoreError>>| {
            tauri::async_runtime::block_on(task).unwrap()
        };

        let task = start("starting-1");
        state.sessions.stop("starting-1");
        assert!(result(task).is_err(), "a stopped start succeeded");
        wait_until("the deletion after term_stop", || {
            node_shell_pods_deleted(&state, &cluster)
        });
        force_delete_node_shell_pods(&state, &cluster);

        let task = start("starting-2");
        state.close_cluster(&cluster);
        assert!(result(task).is_err());
        wait_until("the deletion after close_cluster", || {
            node_shell_pods_deleted(&state, &cluster)
        });
        force_delete_node_shell_pods(&state, &cluster);

        let task = start("starting-3");
        state.close_all();
        // close_all returned only once the deletion was answered.
        assert!(
            node_shell_pods_deleted(&state, &cluster),
            "close_all did not wait"
        );
        assert!(result(task).is_err());
        assert!(state.sessions.is_empty());
        force_delete_node_shell_pods(&state, &cluster);
        wait_no_node_shell_pods(&state, &cluster, "after the forced removal");
    }
}
