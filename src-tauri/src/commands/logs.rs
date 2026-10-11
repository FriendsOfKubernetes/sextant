//! Pod log streams; lines arrive as `logs:<streamId>` events.

use std::time::Duration;

use futures::{Stream, StreamExt};
use sextant_core::logs::{self, LogOptions, LogUpdate};
use sextant_core::{ClusterId, CoreError, ObjectRef};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::events::logs_event;
use crate::state::{AppState, Subscription, new_id};

/// The window can listen to `logs:<id>` only after `logs_start` has answered, so output that appears sooner
/// would be lost. The first update is therefore held back by this long after the stream is registered (the
/// core batches lines for 100 ms anyway); a log stream starts with a tail, so nothing visible is delayed more.
pub const LISTENER_GRACE: Duration = Duration::from_millis(300);

/// Opens the log stream of a container and emits its updates as `logs:<streamId>` (`LogUpdate`). The stream
/// belongs to the cluster: `logs_stop`, disconnecting the cluster and closing the window stop it.
#[tauri::command]
pub async fn logs_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    pod: ObjectRef,
    opts: LogOptions,
) -> Result<String, CoreError> {
    let updates = logs::stream_logs(&state.clusters, &cluster_id, &pod, opts).await?;
    Ok(forward_logs(&app, &state, cluster_id, updates))
}

/// Stops a log stream. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn logs_stop(state: State<'_, AppState>, stream_id: String) -> Result<(), CoreError> {
    state.subscriptions.stop(&stream_id);
    Ok(())
}

/// Emits every update of `updates` as `logs:<id>`, starting [`LISTENER_GRACE`] after the stream is registered in
/// `state.subscriptions` under `cluster`; the subscription forgets itself when the stream ends.
pub fn forward_logs<R, S>(
    app: &AppHandle<R>,
    state: &AppState,
    cluster: ClusterId,
    updates: S,
) -> String
where
    R: Runtime,
    S: Stream<Item = LogUpdate> + Send + 'static,
{
    let id = new_id("logs");
    let event = logs_event(&id);
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
        tokio::time::sleep(LISTENER_GRACE).await;
        let mut updates = std::pin::pin!(updates);
        while let Some(update) = updates.next().await {
            if handle.emit(&event, &update).is_err() {
                break;
            }
        }
        if let Some(state) = handle.try_state::<AppState>() {
            state.subscriptions.remove(&own_id);
        }
    });
    state.subscriptions.insert(
        id.clone(),
        Subscription {
            cluster,
            task: task.inner().abort_handle(),
        },
    );
    let _ = registered_tx.send(());
    id
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use futures::channel::mpsc;
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
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn lines(text: &[&str]) -> LogUpdate {
        LogUpdate::Lines {
            lines: text.iter().map(|l| l.to_string()).collect(),
        }
    }

    #[test]
    fn output_produced_right_after_start_reaches_a_listener_that_attaches_after_the_start_returned()
    {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        // The core already has output when the command runs.
        let updates = futures::stream::iter([lines(&["first"]), LogUpdate::Ended]);
        let id = forward_logs(app.handle(), &state, ClusterId::from("c"), updates);

        // The window needs a moment between the answer of `logs_start` and its `listen` call.
        std::thread::sleep(Duration::from_millis(60));
        let (seen_tx, seen_rx) = std::sync::mpsc::channel::<String>();
        app.listen_any(logs_event(&id), move |event| {
            seen_tx.send(event.payload().to_owned()).unwrap();
        });

        let json = |s: String| serde_json::from_str::<serde_json::Value>(&s).unwrap();
        let first = seen_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the first batch was lost");
        assert_eq!(
            json(first),
            serde_json::json!({ "type": "lines", "lines": ["first"] })
        );
        let last = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(json(last), serde_json::json!({ "type": "ended" }));
        wait_until("the finished stream to be forgotten", || {
            state.subscriptions.is_empty()
        });
    }

    #[test]
    fn disconnecting_the_cluster_stops_its_log_streams_and_logs_stop_is_idempotent() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c1");
        let (tx, rx) = mpsc::unbounded::<LogUpdate>();
        let (other_tx, other_rx) = mpsc::unbounded::<LogUpdate>();
        let first = forward_logs(app.handle(), &state, cluster.clone(), rx);
        let second = forward_logs(app.handle(), &state, ClusterId::from("c2"), other_rx);
        assert_eq!(state.subscriptions.len(), 2);

        state.close_cluster(&cluster);
        assert_eq!(state.subscriptions.len(), 1, "only the other cluster's");
        wait_until("the stream to stop", || tx.is_closed());
        assert!(!other_tx.is_closed());

        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), second)).unwrap();
        wait_until("the stream to stop", || other_tx.is_closed());
        assert!(state.subscriptions.is_empty());
        // Already stopped, and never existed.
        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), first)).unwrap();
        tauri::async_runtime::block_on(logs_stop(app.state::<AppState>(), "logs-999".into()))
            .unwrap();
    }
}
