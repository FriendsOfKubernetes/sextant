//! Watch subscriptions and reading/writing objects.
//!
//! Note: `resource_replace` / `resource_apply` / `resource_delete` stay here (they are listed with `resource_get`
//! in the command table); their core functions live in `sextant_core::resources::mutate`.

use futures::{Stream, StreamExt};
use sextant_core::resources::{self, WatchUpdate};
use sextant_core::{ClusterId, CoreError, ObjectRef, WatchSpec};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

use crate::events::watch_event;
use crate::state::{AppState, Subscription, new_id};

/// Starts a watch; updates arrive as `watch:<subscriptionId>` events (`WatchUpdate`). The subscription belongs to
/// the cluster: `watch_stop`, disconnecting the cluster (`AppState::close_cluster`) and closing the window stop it.
#[tauri::command]
pub async fn watch_start<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    spec: WatchSpec,
) -> Result<String, CoreError> {
    let updates = resources::watch(&state.clusters, &cluster_id, spec).await?;
    Ok(forward_watch(&app, &state, cluster_id, updates))
}

/// Stops a subscription. Stopping one that already ended (or never existed) is not an error.
#[tauri::command]
pub async fn watch_stop(
    state: State<'_, AppState>,
    subscription_id: String,
) -> Result<(), CoreError> {
    state.subscriptions.stop(&subscription_id);
    Ok(())
}

/// Emits every update of `updates` as `watch:<id>` until the stream ends or the subscription is stopped.
/// The subscription is registered in `state.subscriptions` under `cluster` before the first update is sent, and
/// forgets itself when the stream ends.
pub fn forward_watch<R, S>(
    app: &AppHandle<R>,
    state: &AppState,
    cluster: ClusterId,
    updates: S,
) -> String
where
    R: Runtime,
    S: Stream<Item = WatchUpdate> + Send + 'static,
{
    let id = new_id("watch");
    let event = watch_event(&id);
    let (registered_tx, registered_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = app.clone();
    let own_id = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        if registered_rx.await.is_err() {
            return;
        }
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
    resources::replace_yaml(&state.clusters, &cluster_id, &yaml).await
}

#[tauri::command]
pub async fn resource_apply(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    yaml: String,
) -> Result<Vec<ObjectRef>, CoreError> {
    resources::apply_yaml(&state.clusters, &cluster_id, &yaml).await
}

#[tauri::command]
pub async fn resource_delete(
    state: State<'_, AppState>,
    cluster_id: ClusterId,
    _ref: ObjectRef,
) -> Result<(), CoreError> {
    resources::delete(&state.clusters, &cluster_id, &_ref).await
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

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

    #[test]
    fn updates_are_emitted_and_disconnecting_the_cluster_stops_the_subscription() {
        let (app, _dir) = app();
        let state = app.state::<AppState>();
        let cluster = ClusterId::from("c1");
        let other = ClusterId::from("c2");
        let (tx, rx) = mpsc::unbounded::<WatchUpdate>();
        let (other_tx, other_rx) = mpsc::unbounded::<WatchUpdate>();

        let id = forward_watch(app.handle(), &state, cluster.clone(), rx);
        forward_watch(app.handle(), &state, other.clone(), other_rx);
        assert_eq!(state.subscriptions.len(), 2);

        let (seen_tx, seen_rx) = std::sync::mpsc::channel::<String>();
        app.listen_any(watch_event(&id), move |event| {
            seen_tx.send(event.payload().to_owned()).unwrap();
        });
        tx.unbounded_send(WatchUpdate::Snapshot { items: vec![] })
            .unwrap();
        let payload = seen_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
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
        forward_watch(app.handle(), &state, ClusterId::from("c"), rx);
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
        let id = forward_watch(app.handle(), &state, ClusterId::from("c"), rx);
        tauri::async_runtime::block_on(watch_stop(app.state::<AppState>(), id.clone())).unwrap();
        assert!(state.subscriptions.is_empty());
        wait_until("the watch to stop", || tx.is_closed());
        tauri::async_runtime::block_on(watch_stop(app.state::<AppState>(), id)).unwrap();
    }
}
