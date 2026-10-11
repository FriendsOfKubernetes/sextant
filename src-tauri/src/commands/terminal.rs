//! Terminal sessions: shell in a container (`exec_start`) and a local shell (`terminal_start`).
//! Output arrives as `term:<sessionId>` events; input, resize and stop are shared by both kinds.
//!
//! The frontend subscribes to `term:<id>` only after `*_start` has answered, so a session keeps its output (the
//! first prompt, an immediate exit) until the frontend shows it listens — by its first `term_resize` or
//! `term_input` — and only then emits it.

use std::collections::VecDeque;

use sextant_core::exec::{self, ExecSession, TermEvent};
use sextant_core::{ClusterId, CoreError, ErrorCode, ObjectRef};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{mpsc, oneshot};

use crate::events::{TermPayload, term_event};
use crate::pty::{self, ShellCommand};
use crate::state::{AppState, TermSession, new_id};

#[tauri::command]
pub async fn exec_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    container: String,
    cols: u16,
    rows: u16,
) -> Result<String, CoreError> {
    let session =
        exec::exec_shell(&state.clusters, &cluster_id, &pod, &container, cols, rows).await?;
    Ok(forward_term(&app, &state, Some(cluster_id), session, ()))
}

/// Local shell with `KUBECONFIG` pointing at a temporary kubeconfig of the cluster.
#[tauri::command]
pub async fn terminal_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    cols: u16,
    rows: u16,
) -> Result<String, CoreError> {
    start_local_terminal(&app, &state, cluster_id, &pty::user_shell(), cols, rows)
}

/// Starts `shell` with `KUBECONFIG` set to a private (0600) temporary kubeconfig holding only `cluster`'s context.
/// The file lives as long as the session: it is removed when the shell exits, the session is stopped, the cluster
/// is disconnected or the window closes.
pub fn start_local_terminal<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    cluster: ClusterId,
    shell: &ShellCommand,
    cols: u16,
    rows: u16,
) -> Result<String, CoreError> {
    let kubeconfig = state
        .registry
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .write_temp_kubeconfig(&cluster)?;
    let session = pty::spawn_shell(shell, &[("KUBECONFIG", kubeconfig.as_os_str())], cols, rows)?;
    Ok(forward_term(app, state, Some(cluster), session, kubeconfig))
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

fn channels(state: &AppState, id: &str) -> Result<crate::state::TermChannels, CoreError> {
    state.sessions.channels(id).ok_or_else(|| not_running(id))
}

fn not_running(id: &str) -> CoreError {
    CoreError::new(
        ErrorCode::NotFound,
        format!("terminal session {id} is not running"),
    )
}

/// Registers `session` in `state.sessions` (under `cluster`, so disconnecting the cluster stops it) and emits its
/// output as `term:<id>`. `guard` lives exactly as long as the session (e.g. its temporary kubeconfig).
pub fn forward_term<R, G>(
    app: &AppHandle<R>,
    state: &AppState,
    cluster: Option<ClusterId>,
    session: ExecSession,
    guard: G,
) -> String
where
    R: Runtime,
    G: Send + 'static,
{
    let id = new_id("term");
    let event = term_event(&id);
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);
    let (registered_tx, registered_rx) = oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _guard = guard;
        if registered_rx.await.is_err() {
            return;
        }
        let ExecSession {
            input,
            resize,
            mut output,
        } = session;
        let emit = |payload: &TermPayload| handle.emit(&event, payload).is_ok();
        // Output held until the frontend listens; `None` once it does.
        let mut backlog = Some(Backlog::default());
        // The shell is gone (its last event is in the backlog or emitted).
        let mut finished = false;
        loop {
            tokio::select! {
                // Keystrokes and resizes come from the frontend, which therefore listens by now.
                keys = input_rx.recv() => {
                    let Some(keys) = keys else { break };
                    if !release(&mut backlog, emit) || finished {
                        break;
                    }
                    let _ = input.send(keys).await;
                }
                size = resize_rx.recv() => {
                    let Some(size) = size else { break };
                    if !release(&mut backlog, emit) || finished {
                        break;
                    }
                    let _ = resize.send(size).await;
                }
                event_out = output.recv(), if !finished => {
                    let (payload, last) = match event_out {
                        Some(ev) => payload_of(ev),
                        None => (TermPayload::Exit { code: None }, true),
                    };
                    finished = last;
                    match backlog.as_mut() {
                        Some(held) => held.push(payload),
                        None => {
                            if !emit(&payload) || last {
                                break;
                            }
                        }
                    }
                }
            }
        }
        if let Some(state) = handle.try_state::<AppState>() {
            state.sessions.remove(&own_id);
        }
    });
    state.sessions.insert(
        id.clone(),
        TermSession {
            cluster,
            input: input_tx,
            resize: resize_tx,
            task: task.inner().abort_handle(),
        },
    );
    let _ = registered_tx.send(());
    id
}

/// The payload of `event`, and whether it ends the session.
fn payload_of(event: TermEvent) -> (TermPayload, bool) {
    match event {
        TermEvent::Data(bytes) => (TermPayload::data(&bytes), false),
        TermEvent::Exit { code } => (TermPayload::Exit { code }, true),
        TermEvent::Error(error) => (TermPayload::Error { error }, true),
    }
}

/// Emits the held output, if any is still held, and stops holding. `false` if the window is gone.
fn release(backlog: &mut Option<Backlog>, emit: impl Fn(&TermPayload) -> bool) -> bool {
    match backlog.take() {
        Some(held) => held.items.iter().all(emit),
        None => true,
    }
}

/// Most output held before the frontend listens; older data is dropped beyond it (a shell prints a prompt, not
/// megabytes, before anyone types).
const BACKLOG_LIMIT: usize = 1 << 20;

#[derive(Default)]
struct Backlog {
    items: VecDeque<TermPayload>,
    data_bytes: usize,
}

impl Backlog {
    fn push(&mut self, payload: TermPayload) {
        self.data_bytes += data_len(&payload);
        self.items.push_back(payload);
        while self.data_bytes > BACKLOG_LIMIT {
            let Some(index) = self.items.iter().position(|p| data_len(p) > 0) else {
                break;
            };
            if let Some(dropped) = self.items.remove(index) {
                self.data_bytes -= data_len(&dropped);
            }
        }
    }
}

fn data_len(payload: &TermPayload) -> usize {
    match payload {
        TermPayload::Data { data } => data.len(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn output_before_the_frontend_listens_is_delivered_after_its_first_resize() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, mut shell) = fake_session();
        // The prompt is printed at once, before `exec_start` has even answered.
        shell
            .output
            .try_send(TermEvent::Data(b"prompt$ ".to_vec()))
            .unwrap();
        let id = forward_term(
            app.handle(),
            &state,
            Some(ClusterId::from("c")),
            session,
            (),
        );
        // Give a naive implementation the time to emit into the void.
        std::thread::sleep(Duration::from_millis(200));

        let events = listen(&app, &id);
        let (_, resize) = state.sessions.channels(&id).unwrap();
        resize.blocking_send((100, 30)).unwrap();
        assert_eq!(
            next(&events),
            json!({ "type": "data", "data": "cHJvbXB0JCA=" })
        );
        assert_eq!(shell.resize.blocking_recv(), Some((100, 30)));

        // Afterwards output flows directly.
        shell
            .output
            .blocking_send(TermEvent::Data(b"ls".to_vec()))
            .unwrap();
        assert_eq!(next(&events), json!({ "type": "data", "data": "bHM=" }));
        let (input, _) = state.sessions.channels(&id).unwrap();
        input.blocking_send(b"x".to_vec()).unwrap();
        assert_eq!(shell.input.blocking_recv(), Some(b"x".to_vec()));
    }

    #[test]
    fn an_exit_before_the_frontend_listens_is_kept_too_and_ends_the_session() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (session, shell) = fake_session();
        let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let guard_path = guard.to_path_buf();
        shell
            .output
            .try_send(TermEvent::Data(b"bye".to_vec()))
            .unwrap();
        shell
            .output
            .try_send(TermEvent::Exit { code: Some(2) })
            .unwrap();
        drop(shell);
        let id = forward_term(app.handle(), &state, None, session, guard);
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(state.sessions.len(), 1, "kept until the frontend listens");

        let events = listen(&app, &id);
        let (input, _) = state.sessions.channels(&id).unwrap();
        input.blocking_send(b"\r".to_vec()).unwrap();
        assert_eq!(next(&events), json!({ "type": "data", "data": "Ynll" }));
        assert_eq!(next(&events), json!({ "type": "exit", "code": 2 }));
        wait_until("the session to be forgotten", || state.sessions.is_empty());
        wait_until("the guard to be dropped", || !guard_path.exists());
    }

    #[test]
    fn stop_disconnect_and_window_close_end_sessions_and_drop_their_guards() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let start = |cluster: &str| {
            let (session, shell) = fake_session();
            let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
            let path = guard.to_path_buf();
            let id = forward_term(
                app.handle(),
                &state,
                Some(ClusterId::from(cluster)),
                session,
                guard,
            );
            (id, shell, path)
        };

        let (id, shell, path) = start("a");
        state.sessions.stop(&id);
        wait_until("the stopped session's guard", || !path.exists());
        wait_until("the stopped session's shell to see the hang-up", || {
            shell.output.is_closed()
        });

        let (_, a_shell, a_path) = start("a");
        let (_, b_shell, b_path) = start("b");
        state.close_cluster(&ClusterId::from("a"));
        wait_until("cluster a's session to end", || {
            !a_path.exists() && a_shell.output.is_closed()
        });
        assert!(b_path.exists() && !b_shell.output.is_closed());
        assert_eq!(state.sessions.len(), 1);

        state.close_all();
        wait_until("every session to end", || {
            !b_path.exists() && b_shell.output.is_closed()
        });
        assert!(state.sessions.is_empty());
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

    /// The path printed by `echo "KC=$KUBECONFIG"` (not the echoed command line itself).
    #[cfg(unix)]
    fn kubeconfig_path_in(text: &str) -> std::path::PathBuf {
        text.match_indices("KC=/")
            .map(|(i, _)| &text[i + 3..])
            .map(|rest| {
                rest.split(['\r', '\n', ' ', '"'])
                    .next()
                    .unwrap_or_default()
            })
            .find(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| panic!("KUBECONFIG is not set: {text:?}"))
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
        let id = start_local_terminal(app.handle(), &state, cluster.clone(), &sh, 80, 24).unwrap();
        let events = listen(&app, &id);
        let (input, resize) = state.sessions.channels(&id).unwrap();
        resize.blocking_send((80, 24)).unwrap();

        let kubectl = kubectl_available();
        let line = if kubectl {
            "echo \"KC=$KUBECONFIG\"; echo \"CTX=$(kubectl config current-context)\"\n"
        } else {
            "echo \"KC=$KUBECONFIG\"; echo CTX=fixture-ctx\n"
        };
        input.blocking_send(line.as_bytes().to_vec()).unwrap();
        let mut text = String::new();
        read_text(&events, &mut text, |t| {
            t.contains("CTX=fixture-ctx\r\n") || t.contains("CTX=fixture-ctx\n")
        });
        let temp = kubeconfig_path_in(&text);
        assert_ne!(temp, kubeconfig, "a private copy, not the user's file");
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&temp).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // Closing the tab (term_stop) removes the file.
        state.sessions.stop(&id);
        wait_until("the temp kubeconfig to be removed", || !temp.exists());

        // So does the shell exiting by itself.
        let id = start_local_terminal(app.handle(), &state, cluster.clone(), &sh, 80, 24).unwrap();
        let events = listen(&app, &id);
        let (input, resize) = state.sessions.channels(&id).unwrap();
        resize.blocking_send((80, 24)).unwrap();
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
        let id = start_local_terminal(app.handle(), &state, cluster.clone(), &sh, 80, 24).unwrap();
        assert!(state.sessions.channels(&id).is_some());
        state.close_cluster(&cluster);
        wait_until("the disconnected cluster's terminal to stop", || {
            state.sessions.is_empty()
        });
        let id = start_local_terminal(app.handle(), &state, cluster, &sh, 80, 24).unwrap();
        assert!(state.sessions.channels(&id).is_some());
        state.close_all();
        assert!(state.sessions.is_empty());
        // The window closed: no copy of these credentials is left in the temp directory.
        wait_until("every temp kubeconfig of the fixture to be removed", || {
            std::fs::read_dir(std::env::temp_dir())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("sextant-kubeconfig-")
                })
                .all(|e| {
                    !std::fs::read_to_string(e.path()).is_ok_and(|t| t.contains(FIXTURE_TOKEN))
                })
        });
    }

    #[test]
    fn a_local_terminal_for_an_unknown_cluster_is_an_error() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let err = start_local_terminal(
            app.handle(),
            &state,
            ClusterId::from("missing"),
            &pty::user_shell(),
            80,
            24,
        )
        .expect_err("no such cluster");
        assert_ne!(err.code, ErrorCode::Other, "{err}");
        assert!(state.sessions.is_empty());
    }
}
