//! Pod log streams; lines arrive through the stream's channel (`onEvent`).

use std::future::Future;

use futures::{Stream, StreamExt};
use sextant_core::logs::{self, LogOptions, LogUpdate};
use sextant_core::{ClusterId, CoreError, CoreResult, ObjectRef};
use tauri::ipc::{Channel, IpcResponse};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::state::{AppState, Subscription, check_stream_id};

/// Opens the log stream of a container under `stream_id`, which the frontend chose, and sends its updates (`LogUpdate`)
/// through `on_event`, the channel the frontend created before the start. A taken id is `invalid`. The stream belongs
/// to the cluster: `logs_stop`, disconnecting the cluster, `streams_reset` and closing the window stop it.
#[tauri::command]
pub async fn logs_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    opts: LogOptions,
    stream_id: String,
    on_event: Channel<LogUpdate>,
) -> Result<(), CoreError> {
    let open = logs::stream_logs(&state.clusters, &cluster_id, &pod, opts);
    start_logs(&app, &state, stream_id, cluster_id.clone(), open, on_event).await
}

/// `logs_start` once the pod is known: waits for `open` (the core opening the log stream), then registers and
/// forwards it — unless `streams_reset` ran meanwhile, then the stream is dropped and the start fails.
pub async fn start_logs<R, S, U>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    open: impl Future<Output = CoreResult<S>>,
    channel: Channel<U>,
) -> Result<(), CoreError>
where
    R: Runtime,
    S: Stream<Item = U> + Send + 'static,
    U: IpcResponse + Send + 'static,
{
    check_stream_id(&id)?;
    let generation = state.streams_generation();
    let updates = open.await?;
    forward_logs(app, state, id.clone(), cluster, updates, channel)?;
    state.undo_if_reset(generation, || {
        state.subscriptions.stop(&id);
    })
}

/// Stops a log stream. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn logs_stop(state: State<'_, AppState>, stream_id: String) -> Result<(), CoreError> {
    state.subscriptions.stop(&stream_id);
    Ok(())
}

/// Sends every update of `updates` (log batches, or Loki pages) through `channel` as soon as it comes (the window created the channel before the
/// start), once the stream is registered in `state.subscriptions` under `id` and `cluster`; the subscription forgets
/// itself when the stream ends or a send fails. A taken or malformed `id` is `invalid` (nothing is sent).
pub fn forward_logs<R, S, U>(
    app: &AppHandle<R>,
    state: &AppState,
    id: String,
    cluster: ClusterId,
    updates: S,
    channel: Channel<U>,
) -> Result<(), CoreError>
where
    R: Runtime,
    S: Stream<Item = U> + Send + 'static,
    U: IpcResponse + Send + 'static,
{
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        let mut updates = std::pin::pin!(updates);
        while let Some(update) = updates.next().await {
            if channel.send(update).is_err() {
                break;
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

    fn lines(text: &[&str]) -> LogUpdate {
        LogUpdate::Lines {
            lines: text.iter().map(|l| l.to_string()).collect(),
            cut: Vec::new(),
        }
    }

    #[test]
    fn output_produced_right_after_start_reaches_the_channel_created_before_the_start() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        // The window creates the channel first, then starts the stream under the id it chose.
        let (channel, seen_rx) = test_channel();
        // The core already has output when the command runs.
        let updates = futures::stream::iter([lines(&["first"]), LogUpdate::Ended]);
        forward_logs(
            app.handle(),
            &state,
            "l-early".into(),
            ClusterId::from("c"),
            updates,
            channel,
        )
        .unwrap();

        // Nothing is held back for a listener that might come later: the batch is out at once.
        let first = seen_rx
            .recv_timeout(Duration::from_millis(250))
            .expect("the first batch was held back or lost");
        assert_eq!(
            first,
            serde_json::json!({ "type": "lines", "lines": ["first"] })
        );
        let last = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(last, serde_json::json!({ "type": "ended" }));
        wait_until("the finished stream to be forgotten", || {
            state.subscriptions.is_empty()
        });
    }

    #[test]
    fn a_taken_stream_id_is_invalid() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let (tx, rx) = mpsc::unbounded::<LogUpdate>();
        forward_logs(
            app.handle(),
            &state,
            "l-1".into(),
            ClusterId::from("c"),
            rx,
            test_channel().0,
        )
        .unwrap();
        let (_, again) = mpsc::unbounded::<LogUpdate>();
        let err = forward_logs(
            app.handle(),
            &state,
            "l-1".into(),
            ClusterId::from("c"),
            again,
            test_channel().0,
        )
        .expect_err("the id is taken");
        assert_eq!(err.code, sextant_core::ErrorCode::Invalid, "{err}");
        assert!(!tx.is_closed());
    }

    #[test]
    fn disconnecting_the_cluster_stops_its_log_streams_and_logs_stop_is_idempotent() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c1");
        let (tx, rx) = mpsc::unbounded::<LogUpdate>();
        let (other_tx, other_rx) = mpsc::unbounded::<LogUpdate>();
        forward_logs(
            app.handle(),
            &state,
            "l-1".into(),
            cluster.clone(),
            rx,
            test_channel().0,
        )
        .unwrap();
        forward_logs(
            app.handle(),
            &state,
            "l-2".into(),
            ClusterId::from("c2"),
            other_rx,
            test_channel().0,
        )
        .unwrap();
        assert_eq!(state.subscriptions.len(), 2);

        state.close_cluster(&cluster);
        assert_eq!(state.subscriptions.len(), 1, "only the other cluster's");
        wait_until("the stream to stop", || tx.is_closed());
        assert!(!other_tx.is_closed());

        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), "l-2".into())).unwrap();
        wait_until("the stream to stop", || other_tx.is_closed());
        assert!(state.subscriptions.is_empty());
        // Already stopped, and never existed.
        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), "l-1".into())).unwrap();
        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), "logs-999".into()))
            .unwrap();
    }
}
