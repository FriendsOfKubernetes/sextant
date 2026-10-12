//! Terminal sessions: shell in a container (`exec_start`) and a local shell (`terminal_start`).
//! Output arrives as `term:<sessionId>` events; input, resize and stop are shared by both kinds.
//!
//! The frontend chooses the session id and subscribes to `term:<id>` before `*_start`, so output is emitted as soon
//! as the shell prints it (the first prompt, an immediate exit) and nothing is held back.

use sextant_core::exec::{self, ExecSession, TermEvent};
use std::future::Future;

use sextant_core::{ClusterId, CoreError, CoreResult, ErrorCode, ObjectRef};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{mpsc, oneshot};

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

/// Local shell with `KUBECONFIG` pointing at a temporary kubeconfig of the cluster, under `stream_id`.
#[tauri::command]
pub async fn terminal_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    cols: u16,
    rows: u16,
    stream_id: String,
) -> Result<(), CoreError> {
    start_local_terminal(
        &app,
        &state,
        stream_id,
        cluster_id,
        &pty::user_shell(),
        cols,
        rows,
    )
}

/// Starts `shell` with `KUBECONFIG` set to a private (0600) temporary kubeconfig holding only `cluster`'s context.
/// The file lives as long as the session: it is removed when the shell exits, and before `term_stop`, disconnecting
/// the cluster, `streams_reset`, closing the window or quitting the application return.
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
        pty::spawn_shell(shell, &[("KUBECONFIG", kubeconfig)], cols, rows)
    })
}

/// [`start_local_terminal`] with the shell started by `spawn`, which gets the temporary kubeconfig's path.
pub fn start_local_session<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    spawn: impl FnOnce(&std::ffi::OsStr) -> CoreResult<ExecSession>,
) -> Result<(), CoreError> {
    check_stream_id(&id)?;
    // Commands run in parallel: a reset may come while the shell is being spawned.
    let generation = state.streams_generation();
    let kubeconfig = state
        .registry
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .write_temp_kubeconfig(&cluster)?;
    let session = spawn(kubeconfig.as_os_str())?;
    forward_term(
        app,
        state,
        id.clone(),
        Some(cluster),
        session,
        Some(Box::new(kubeconfig)),
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
    let event = term_event(&id);
    let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(256);
    let (resize_tx, mut resize_rx) = mpsc::channel::<(u16, u16)>(16);
    let (registered_tx, registered_rx) = oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        let ExecSession {
            input,
            resize,
            mut output,
        } = session;
        let emit = |payload: &TermPayload| handle.emit(&event, payload).is_ok();
        loop {
            tokio::select! {
                keys = input_rx.recv() => {
                    let Some(keys) = keys else { break };
                    let _ = input.send(keys).await;
                }
                size = resize_rx.recv() => {
                    let Some(size) = size else { break };
                    let _ = resize.send(size).await;
                }
                event_out = output.recv() => {
                    let (payload, last) = match event_out {
                        Some(ev) => payload_of(ev),
                        None => (TermPayload::Exit { code: None }, true),
                    };
                    if !emit(&payload) || last {
                        break;
                    }
                }
            }
        }
        if let Some(state) = handle.try_state::<AppState>() {
            state.sessions.remove(&own_id);
        }
    });
    state.sessions.insert(
        id,
        TermSession {
            cluster,
            input: input_tx,
            resize: resize_tx,
            task: task.inner().abort_handle(),
            guard,
        },
    )?;
    let _ = registered_tx.send(());
    Ok(())
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
        // The window closed: no copy of these credentials is left in the temp directory, right away.
        let leftovers = std::fs::read_dir(std::env::temp_dir())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("sextant-kubeconfig-")
            })
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
}
