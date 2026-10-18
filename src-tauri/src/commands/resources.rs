//! Watch subscriptions and reading/writing objects.
//!
//! Note: `resource_replace` / `resource_apply` / `resource_delete` stay here (they are listed with `resource_get`
//! in the command table); their core functions live in `sextant_core::resources::mutate`. Like the actions, they are
//! limited to [`CHANGE_TIMEOUT`].

use std::future::Future;

use futures::{Stream, StreamExt};
use sextant_core::error::with_timeout;
use sextant_core::resources::{self, DryRunMode, DryRunResult, WatchUpdate};
use sextant_core::{ClusterId, CoreError, CoreResult, ObjectRef, WatchSpec};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::commands::actions::CHANGE_TIMEOUT;
use crate::state::{AppState, Subscription, check_stream_id};

/// Starts a watch under `stream_id`, which the frontend chose: updates (`WatchUpdate`) go through `on_event`, the
/// channel the frontend created before the start, the first snapshot as soon as it is listed. A taken id is `invalid`.
/// The subscription belongs to the cluster and is registered before the core starts: `watch_stop`, disconnecting
/// the cluster (`AppState::close_cluster`), `streams_reset` and closing the window stop it — also while the core
/// is still finding the kind or listing, which drops that work and fails the start.
#[tauri::command]
pub async fn watch_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    spec: WatchSpec,
    stream_id: String,
    on_event: Channel<WatchUpdate>,
) -> Result<(), CoreError> {
    let (mgr, cluster) = (state.clusters.clone(), cluster_id.clone());
    let open = async move { resources::watch(&mgr, &cluster, spec).await };
    start_watch(&app, &state, stream_id, cluster_id, open, on_event).await
}

/// `watch_start` once the cluster and spec are known: registers the subscription, runs `open` (the core starting the
/// watch) inside it and forwards the updates to `channel`; answers once `open` is done. A subscription stopped before
/// that (`watch_stop`, `streams_reset`, the cluster closed) drops `open` and the start fails; so does a start that
/// outlived a `streams_reset`.
pub async fn start_watch<R, S>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    open: impl Future<Output = CoreResult<S>> + Send + 'static,
    channel: Channel<WatchUpdate>,
) -> Result<(), CoreError>
where
    R: Runtime,
    S: Stream<Item = WatchUpdate> + Send + 'static,
{
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<CoreResult<()>>();
    let updates = async move {
        match open.await {
            Ok(updates) => {
                let _ = started_tx.send(Ok(()));
                Some(updates)
            }
            Err(err) => {
                let _ = started_tx.send(Err(err));
                None
            }
        }
    };
    spawn_watch(app, state, id.clone(), cluster, updates, channel)?;
    started_rx
        .await
        .unwrap_or_else(|_| Err(CoreError::other("the watch was stopped before it started")))?;
    state.undo_if_reset(generation, || {
        state.subscriptions.stop(&id);
    })
}

/// Stops every watch subscription, log stream and terminal session; connections and port forwards stay. The
/// window calls it once when the page loads, before its first stream: streams of a page that was reloaded have
/// nobody receiving them any more.
#[tauri::command]
pub async fn streams_reset(state: State<'_, AppState>) -> Result<(), CoreError> {
    state.reset_streams();
    Ok(())
}

/// Stops a subscription, also one whose start has not answered yet. Stopping one that already ended (or never
/// existed) is not an error.
#[tauri::command]
pub async fn watch_stop(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&subscription_id);
    Ok(())
}

/// Sends every update of `updates` through `channel` until the stream ends, a send fails or the subscription is
/// stopped. The subscription is registered in `state.subscriptions` under `id` and `cluster` before the first update
/// is sent, and forgets itself when the stream ends. A taken or malformed `id` is `invalid` (nothing is sent).
pub fn forward_watch<R, S>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    updates: S,
    channel: Channel<WatchUpdate>,
) -> Result<(), CoreError>
where
    R: Runtime,
    S: Stream<Item = WatchUpdate> + Send + 'static,
{
    spawn_watch(
        app,
        state,
        id,
        cluster,
        async move { Some(updates) },
        channel,
    )
}

/// Registers the subscription `id` and runs it: waits for `updates` (`None`: the watch did not start), then sends
/// each update through `channel`. Stopping the subscription at any point drops whatever it is waiting for.
fn spawn_watch<R, F, S>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    updates: F,
    channel: Channel<WatchUpdate>,
) -> Result<(), CoreError>
where
    R: Runtime,
    F: Future<Output = Option<S>> + Send + 'static,
    S: Stream<Item = WatchUpdate> + Send + 'static,
{
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        if let Some(updates) = updates.await {
            let mut updates = std::pin::pin!(updates);
            while let Some(update) = updates.next().await {
                if channel.send(update).is_err() {
                    break;
                }
            }
        }
        if let Some(state) = handle.try_state::<AppState>() {
            state.subscriptions.remove(&own_id);
        }
    });
    state.subscriptions.insert(
        id,
        Subscription {
            cluster,
            task: task.inner().abort_handle(),
        },
    )?;
    let _ = registered_tx.send(());
    Ok(())
}

#[tauri::command]
pub async fn resource_get(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<serde_json::Value, CoreError> {
    resources::get(&state.clusters, &cluster_id, &_ref).await
}

#[tauri::command]
pub async fn resource_replace(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
) -> Result<serde_json::Value, CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "saving the object",
        resources::replace_yaml(&state.clusters, &cluster_id, &yaml),
    )
    .await
}

#[tauri::command]
pub async fn resource_apply(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
) -> Result<Vec<ObjectRef>, CoreError> {
    // Not limited as a whole: each document is one request, limited in the core (`resources::STEP_TIMEOUT`), and a
    // `timeout` error names what was already applied and what was not sent.
    resources::apply_yaml(&state.clusters, &cluster_id, &yaml).await
}

/// What `resource_replace` (`mode` `replace`, limited to [`CHANGE_TIMEOUT`]) or `resource_apply` (`apply`, each
/// document limited in the core) would do, sent with `dryRun=All`: the live object and what the API server would
/// store, Secrets without their values. Changes nothing, so it asks nothing (#141).
#[tauri::command]
pub async fn resource_dry_run(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
    mode: DryRunMode,
) -> Result<DryRunResult, CoreError> {
    let run = resources::dry_run_yaml(&state.clusters, &cluster_id, &yaml, mode);
    match mode {
        DryRunMode::Replace => with_timeout(CHANGE_TIMEOUT, "the dry run", run).await,
        DryRunMode::Apply => run.await,
    }
}

#[tauri::command]
pub async fn resource_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<(), CoreError> {
    with_timeout(
        CHANGE_TIMEOUT,
        "the deletion",
        resources::delete(&state.clusters, &cluster_id, &_ref),
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use futures::channel::mpsc;

    use super::*;
    use crate::events::test_channel;

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
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn an_update_sent_right_after_the_start_reaches_the_channel_created_before_it() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        // The window creates the channel first, then starts the watch under the id it chose.
        let (channel, seen) = test_channel();
        let updates = futures::stream::iter([WatchUpdate::Snapshot { items: vec![] }])
            .chain(futures::stream::pending());
        forward_watch(
            app.handle(),
            &state,
            "w-early".into(),
            ClusterId::from("c"),
            updates,
            channel,
        )
        .unwrap();
        let first = seen
            .recv_timeout(Duration::from_secs(5))
            .expect("the first snapshot was lost");
        assert_eq!(
            first,
            serde_json::json!({ "type": "snapshot", "items": [] })
        );
    }

    #[test]
    fn a_taken_or_malformed_stream_id_is_invalid() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (tx, rx) = mpsc::unbounded::<WatchUpdate>();
        forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            ClusterId::from("c"),
            rx,
            test_channel().0,
        )
        .unwrap();

        let (again_tx, again_rx) = mpsc::unbounded::<WatchUpdate>();
        let err = forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            ClusterId::from("c"),
            again_rx,
            test_channel().0,
        )
        .expect_err("the id is taken");
        assert_eq!(err.code, sextant_core::ErrorCode::Invalid, "{err}");
        // The rejected stream is dropped; the first one keeps running.
        wait_until("the rejected stream to be dropped", || again_tx.is_closed());
        assert!(!tx.is_closed());
        assert_eq!(state.subscriptions.len(), 1);

        for bad in ["", "a:b", "a b", "../x"] {
            let (_, rx) = mpsc::unbounded::<WatchUpdate>();
            let err = forward_watch(
                app.handle(),
                &state,
                bad.into(),
                ClusterId::from("c"),
                rx,
                test_channel().0,
            )
            .expect_err(bad);
            assert_eq!(err.code, sextant_core::ErrorCode::Invalid, "{bad:?}: {err}");
        }
    }

    #[test]
    fn updates_are_emitted_and_disconnecting_the_cluster_stops_the_subscription() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c1");
        let other = ClusterId::from("c2");
        let (tx, rx) = mpsc::unbounded::<WatchUpdate>();
        let (other_tx, other_rx) = mpsc::unbounded::<WatchUpdate>();

        let (channel, seen) = test_channel();
        forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            cluster.clone(),
            rx,
            channel,
        )
        .unwrap();
        forward_watch(
            app.handle(),
            &state,
            "w-2".into(),
            other.clone(),
            other_rx,
            test_channel().0,
        )
        .unwrap();
        assert_eq!(state.subscriptions.len(), 2);

        tx.unbounded_send(WatchUpdate::Snapshot { items: vec![] })
            .unwrap();
        let payload = seen.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "type": "snapshot", "items": [] })
        );

        state.close_cluster(&cluster);
        assert_eq!(state.subscriptions.len(), 1, "only the other cluster's");
        // The aborted task drops the stream, which closes the sender.
        wait_until("the watch to stop", || tx.is_closed());
        assert!(!other_tx.is_closed());
    }

    #[test]
    fn a_stream_that_ends_forgets_its_subscription() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (tx, rx) = mpsc::unbounded::<WatchUpdate>();
        forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            ClusterId::from("c"),
            rx,
            test_channel().0,
        )
        .unwrap();
        assert_eq!(state.subscriptions.len(), 1);
        drop(tx);
        wait_until("the subscription to be removed", || {
            state.subscriptions.is_empty()
        });
    }

    #[test]
    fn watch_stop_ends_the_subscription_and_tolerates_unknown_ids() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (tx, rx) = mpsc::unbounded::<WatchUpdate>();
        forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            ClusterId::from("c"),
            rx,
            test_channel().0,
        )
        .unwrap();
        tauri::async_runtime::block_on(watch_stop(app.state::<AppState>(), "w-1".into())).unwrap();
        assert!(state.subscriptions.is_empty());
        wait_until("the watch to stop", || tx.is_closed());
        tauri::async_runtime::block_on(watch_stop(app.state::<AppState>(), "w-1".into())).unwrap();
    }

    #[test]
    fn streams_reset_stops_every_watch_log_stream_and_terminal_session() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (watch_tx, watch_rx) = mpsc::unbounded::<WatchUpdate>();
        forward_watch(
            app.handle(),
            &state,
            "w-1".into(),
            ClusterId::from("a"),
            watch_rx,
            test_channel().0,
        )
        .unwrap();
        let (logs_tx, logs_rx) = mpsc::unbounded::<sextant_core::logs::LogUpdate>();
        crate::commands::logs::forward_logs(
            app.handle(),
            &state,
            "l-1".into(),
            ClusterId::from("b"),
            logs_rx,
            test_channel().0,
        )
        .unwrap();
        let guard = tempfile::NamedTempFile::new().unwrap().into_temp_path();
        let guard_path = guard.to_path_buf();
        let (input, _input_rx) = tokio::sync::mpsc::channel(1);
        let (resize, _resize_rx) = tokio::sync::mpsc::channel(1);
        let shell = tauri::async_runtime::spawn(futures::future::pending::<()>());
        state
            .sessions
            .insert(
                "t-1".into(),
                crate::state::TermSession {
                    cluster: None,
                    input,
                    resize,
                    task: shell.inner().abort_handle(),
                    guard: Some(Box::new(guard)),
                },
            )
            .unwrap();

        tauri::async_runtime::block_on(streams_reset(app.state::<AppState>())).unwrap();
        assert!(state.subscriptions.is_empty());
        assert!(state.sessions.is_empty());
        assert!(
            !guard_path.exists(),
            "the session's guard is dropped at once"
        );
        wait_until("the streams to stop", || {
            watch_tx.is_closed() && logs_tx.is_closed()
        });
    }

    /// A core start that never answers; `dropped` fires when its work is dropped.
    fn endless_open(
        began: std::sync::mpsc::Sender<()>,
    ) -> (
        impl Future<Output = CoreResult<mpsc::UnboundedReceiver<WatchUpdate>>> + Send + 'static,
        tokio::sync::oneshot::Receiver<()>,
    ) {
        let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel::<()>();
        let open = async move {
            // Dropping the future drops the sender, which the test sees as `dropped`.
            let _alive = dropped_tx;
            began.send(()).unwrap();
            futures::future::pending::<()>().await;
            let (_tx, rx) = mpsc::unbounded::<WatchUpdate>();
            Ok(rx)
        };
        (open, dropped_rx)
    }

    #[test]
    fn watch_stop_or_streams_reset_before_the_start_answers_drops_the_core_work() {
        for reset in [false, true] {
            let (app, _dir) = app();
            let (began_tx, began_rx) = std::sync::mpsc::channel::<()>();
            let (open, dropped) = endless_open(began_tx);
            let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), CoreError>>();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let result = start_watch(
                    &handle,
                    &state,
                    "w-1".into(),
                    ClusterId::from("c"),
                    open,
                    test_channel().0,
                )
                .await;
                let _ = done_tx.send(result);
            });
            began_rx.recv_timeout(Duration::from_secs(5)).unwrap();

            // The window closed the table (or reloaded) while the core was still discovering.
            if reset {
                tauri::async_runtime::block_on(streams_reset(app.state::<AppState>())).unwrap();
            } else {
                tauri::async_runtime::block_on(watch_stop(app.state::<AppState>(), "w-1".into()))
                    .unwrap();
            }
            let result = tauri::async_runtime::block_on(async {
                tokio::time::timeout(Duration::from_secs(5), done_rx).await
            })
            .expect("the start still waits for the core")
            .unwrap();
            assert!(result.is_err(), "reset={reset}: a stopped start succeeded");
            assert!(
                tauri::async_runtime::block_on(async {
                    tokio::time::timeout(Duration::from_secs(5), dropped).await
                })
                .is_ok(),
                "reset={reset}: the core's work was not dropped"
            );
            assert!(app.state::<AppState>().subscriptions.is_empty());
        }
    }

    #[test]
    fn a_start_still_waiting_for_the_core_when_streams_reset_runs_registers_nothing() {
        use sextant_core::exec::ExecSession;
        use sextant_core::logs::LogUpdate;
        use tokio::sync::oneshot;

        let (app, _dir) = app();
        let state = app.state::<AppState>();
        // Each start waits for a core that is slow to answer: it says when it began, then waits for `release`.
        let (began_tx, began_rx) = std::sync::mpsc::channel::<&str>();
        let (release_tx, release_rx) = tokio::sync::watch::channel(false);
        let slow = |name: &'static str| {
            let began = began_tx.clone();
            let mut release = release_rx.clone();
            async move {
                began.send(name).unwrap();
                let _ = release.wait_for(|go| *go).await;
            }
        };

        let (watch_tx, watch_rx) = mpsc::unbounded::<WatchUpdate>();
        let (logs_tx, logs_rx) = mpsc::unbounded::<LogUpdate>();
        let (exec_input_tx, _exec_input_rx) = tokio::sync::mpsc::channel(1);
        let (exec_resize_tx, _exec_resize_rx) = tokio::sync::mpsc::channel(1);
        let (exec_output_tx, exec_output_rx) = tokio::sync::mpsc::channel(1);
        let session = ExecSession {
            input: exec_input_tx,
            resize: exec_resize_tx,
            output: exec_output_rx,
        };
        let (done_tx, done_rx) = oneshot::channel::<Vec<Result<(), CoreError>>>();
        let handle = app.handle().clone();
        let (watch_open, logs_open, exec_open) = (slow("watch"), slow("logs"), slow("exec"));
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<AppState>();
            let cluster = ClusterId::from("c");
            let results = futures::join!(
                start_watch(
                    &handle,
                    &state,
                    "w-1".into(),
                    cluster.clone(),
                    async move {
                        watch_open.await;
                        Ok(watch_rx)
                    },
                    test_channel().0,
                ),
                crate::commands::logs::start_logs(
                    &handle,
                    &state,
                    "l-1".into(),
                    cluster.clone(),
                    async move {
                        logs_open.await;
                        Ok(logs_rx)
                    },
                    test_channel().0,
                ),
                crate::commands::terminal::start_exec(
                    &handle,
                    &state,
                    "t-1".into(),
                    cluster.clone(),
                    async move {
                        exec_open.await;
                        Ok(session)
                    },
                    test_channel().0,
                ),
            );
            let _ = done_tx.send(vec![results.0, results.1, results.2]);
        });
        for _ in 0..3 {
            began_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        }

        // A reloaded page resets the streams while the old page's starts still wait for the core.
        tauri::async_runtime::block_on(streams_reset(app.state::<AppState>())).unwrap();
        release_tx.send(true).unwrap();
        let results = tauri::async_runtime::block_on(done_rx).unwrap();

        for result in results {
            assert!(result.is_err(), "a start that outlived the reset succeeded");
        }
        assert!(
            state.subscriptions.is_empty(),
            "a watch or log stream outlived the reset"
        );
        assert!(
            state.sessions.is_empty(),
            "a terminal session outlived the reset"
        );
        wait_until("the late streams to be dropped", || {
            watch_tx.is_closed() && logs_tx.is_closed() && exec_output_tx.is_closed()
        });
    }
}
