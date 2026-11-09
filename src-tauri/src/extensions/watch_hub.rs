//! Extensions' watches of the same list share one watch (#334, ADR-0145). Two frames — of one extension or of two —
//! that watch the same kind with the same namespaces and selectors get their updates from one `resources::watch` of
//! the core, opened by the first and closed when the last goes. Each call is still checked against its own grant
//! before it joins (`ExtCall::watch`), and every update is what any extension's watch gets: Secrets without their
//! values (the core), inline secret material emptied (`hide_in_watch_update`, applied once, before the hub).
//!
//! A frame that joins a list already running gets the list as it stands as its first `snapshot` — then, as every
//! frame, the updates that come — so its watch reads as one of its own: a snapshot first, deltas after. What the
//! last update said of the stream (reconnecting, forbidden namespaces, an error) follows that snapshot.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, Weak};
use std::task::{Context, Poll};

use futures::{Stream, StreamExt};
use indexmap::IndexMap;
use sextant_core::error::CoreResult;
use sextant_core::resources::{WatchObject, WatchUpdate};
use tokio::sync::mpsc;

/// The running lists, by cluster and spec.
#[derive(Default)]
pub struct WatchHub {
    lists: Mutex<HashMap<String, Weak<SharedList>>>,
}

/// One list watched for every frame that joined it.
struct SharedList {
    state: Mutex<ListState>,
    task: Mutex<Option<tokio::task::AbortHandle>>,
}

#[derive(Default)]
struct ListState {
    /// The objects as the updates left them, in the order they came; `None` before the first snapshot.
    objects: Option<IndexMap<String, WatchObject>>,
    /// What the last update said of the stream after its objects: told again to a frame that joins.
    status: Option<WatchUpdate>,
    /// The last `Capped` of a watch with `maxObjects` (#406): told again to a frame that joins.
    capped: Option<WatchUpdate>,
    /// The frames that joined, while they listen.
    subscribers: Vec<mpsc::UnboundedSender<WatchUpdate>>,
    /// The core's watch ended: nobody joins this list any more.
    ended: bool,
}

/// A frame's share of a list: its updates. Dropping it leaves the list, which closes when the last share goes.
pub struct Subscription {
    updates: mpsc::UnboundedReceiver<WatchUpdate>,
    _list: Arc<SharedList>,
}

impl Stream for Subscription {
    type Item = WatchUpdate;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<WatchUpdate>> {
        self.updates.poll_recv(cx)
    }
}

impl Drop for SharedList {
    fn drop(&mut self) {
        if let Some(task) = lock(&self.task).take() {
            task.abort();
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// The uid of a watched object; its namespace and name when it has none.
fn key_of(object: &WatchObject) -> String {
    #[derive(serde::Deserialize)]
    struct Meta {
        uid: Option<String>,
        namespace: Option<String>,
        name: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct Object {
        metadata: Option<Meta>,
    }
    match serde_json::from_str::<Object>(object.json())
        .ok()
        .and_then(|o| o.metadata)
    {
        Some(Meta { uid: Some(uid), .. }) => uid,
        Some(meta) => format!(
            "{}/{}",
            meta.namespace.unwrap_or_default(),
            meta.name.unwrap_or_default()
        ),
        None => String::new(),
    }
}

impl WatchHub {
    /// The updates of the list `key`: joined when it runs, else opened with `open` (whose error is the caller's).
    pub async fn subscribe<S>(
        &self,
        key: String,
        open: impl std::future::Future<Output = CoreResult<S>>,
    ) -> CoreResult<Subscription>
    where
        S: Stream<Item = WatchUpdate> + Send + 'static,
    {
        if let Some(joined) = self.join(&key) {
            return Ok(joined);
        }
        let updates = open.await?;
        // Opened by another frame meanwhile: join that one; this watch goes with `updates`.
        let mut lists = lock(&self.lists);
        if let Some(joined) = lists
            .get(&key)
            .and_then(Weak::upgrade)
            .and_then(|list| list.join())
        {
            return Ok(joined);
        }
        lists.retain(|_, list| list.strong_count() > 0);
        let list = Arc::new(SharedList {
            state: Mutex::new(ListState::default()),
            task: Mutex::new(None),
        });
        let joined = list.join().expect("a new list has not ended");
        let weak = Arc::downgrade(&list);
        let task = tokio::spawn(async move {
            let mut updates = std::pin::pin!(updates);
            while let Some(update) = updates.next().await {
                let Some(list) = weak.upgrade() else { break };
                list.publish(update);
            }
            if let Some(list) = weak.upgrade() {
                list.end();
            }
        });
        *lock(&list.task) = Some(task.abort_handle());
        lists.insert(key, Arc::downgrade(&list));
        Ok(joined)
    }

    fn join(&self, key: &str) -> Option<Subscription> {
        lock(&self.lists)
            .get(key)
            .and_then(Weak::upgrade)
            .and_then(|list| list.join())
    }

    /// Lists running (tests).
    #[cfg(test)]
    fn running(&self) -> usize {
        lock(&self.lists)
            .values()
            .filter(|l| l.strong_count() > 0)
            .count()
    }
}

impl SharedList {
    /// A new share: the list as it stands first (when it was listed), then what the stream last said.
    fn join(self: &Arc<Self>) -> Option<Subscription> {
        let mut state = lock(&self.state);
        if state.ended {
            return None;
        }
        let (tx, rx) = mpsc::unbounded_channel();
        if let Some(objects) = &state.objects {
            let _ = tx.send(WatchUpdate::Snapshot {
                items: objects.values().cloned().collect(),
            });
            if let Some(capped) = &state.capped {
                let _ = tx.send(capped.clone());
            }
            if let Some(status) = &state.status {
                let _ = tx.send(status.clone());
            }
        }
        state.subscribers.push(tx);
        Some(Subscription {
            updates: rx,
            _list: Arc::clone(self),
        })
    }

    /// Keeps what `update` says and passes it to every share still listening.
    fn publish(&self, update: WatchUpdate) {
        let mut state = lock(&self.state);
        match &update {
            WatchUpdate::Snapshot { items } => {
                state.objects = Some(items.iter().map(|o| (key_of(o), o.clone())).collect());
                state.status = None;
            }
            WatchUpdate::Delta { upserted, deleted } => {
                let objects = state.objects.get_or_insert_with(IndexMap::new);
                for object in upserted {
                    objects.insert(key_of(object), object.clone());
                }
                for uid in deleted {
                    objects.shift_remove(uid);
                }
                // Objects came again: the stream is back.
                if matches!(state.status, Some(WatchUpdate::Reconnecting)) {
                    state.status = None;
                }
            }
            WatchUpdate::Reconnecting | WatchUpdate::Error(_) | WatchUpdate::Forbidden { .. } => {
                state.status = Some(update.clone());
            }
            // A cap (an extension's `maxObjects`, #406) is told again to a frame that joins; parts are the window's.
            WatchUpdate::Capped { .. } => state.capped = Some(update.clone()),
            WatchUpdate::SnapshotPart { .. } | WatchUpdate::SnapshotEnd { .. } => {}
        }
        state
            .subscribers
            .retain(|tx| tx.send(update.clone()).is_ok());
    }

    /// The core's watch ended: the shares end with it.
    fn end(&self) {
        let mut state = lock(&self.state);
        state.ended = true;
        state.subscribers.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sextant_core::error::{CoreError, ErrorCode};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn object(uid: &str, name: &str) -> WatchObject {
        WatchObject::new(&serde_json::json!({ "metadata": { "uid": uid, "name": name } })).unwrap()
    }

    fn names(update: &WatchUpdate) -> Vec<String> {
        match update {
            WatchUpdate::Snapshot { items } => items
                .iter()
                .map(|o| {
                    o.to_value()["metadata"]["name"]
                        .as_str()
                        .unwrap()
                        .to_owned()
                })
                .collect(),
            other => panic!("not a snapshot: {other:?}"),
        }
    }

    /// A core watch the test feeds, counting how often it was opened and whether it is still read.
    struct Upstream {
        opened: Arc<AtomicUsize>,
        tx: Mutex<Option<mpsc::UnboundedSender<WatchUpdate>>>,
    }

    impl Upstream {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                opened: Arc::new(AtomicUsize::new(0)),
                tx: Mutex::new(None),
            })
        }

        fn open(
            self: &Arc<Self>,
        ) -> impl std::future::Future<
            Output = CoreResult<impl Stream<Item = WatchUpdate> + Send + 'static>,
        > {
            let me = Arc::clone(self);
            async move {
                me.opened.fetch_add(1, Ordering::SeqCst);
                let (tx, rx) = mpsc::unbounded_channel();
                *lock(&me.tx) = Some(tx);
                Ok(tokio_stream_of(rx))
            }
        }

        fn send(&self, update: WatchUpdate) {
            lock(&self.tx).as_ref().unwrap().send(update).unwrap();
        }

        fn closed(&self) -> bool {
            lock(&self.tx).as_ref().is_none_or(|tx| tx.is_closed())
        }
    }

    fn tokio_stream_of(
        mut rx: mpsc::UnboundedReceiver<WatchUpdate>,
    ) -> impl Stream<Item = WatchUpdate> + Send + 'static {
        futures::stream::poll_fn(move |cx| rx.poll_recv(cx))
    }

    async fn next(sub: &mut Subscription) -> WatchUpdate {
        tokio::time::timeout(Duration::from_secs(2), sub.next())
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn two_frames_on_the_same_list_share_one_watch_and_the_later_one_starts_from_the_list_as_it_stands()
     {
        let hub = WatchHub::default();
        let upstream = Upstream::new();
        let mut first = hub
            .subscribe("c1|pods".into(), upstream.open())
            .await
            .unwrap();
        upstream.send(WatchUpdate::Snapshot {
            items: vec![object("1", "web-1"), object("2", "web-2")],
        });
        assert_eq!(names(&next(&mut first).await), ["web-1", "web-2"]);
        upstream.send(WatchUpdate::Delta {
            upserted: vec![object("3", "web-3")],
            deleted: vec!["1".into()],
        });
        assert!(matches!(next(&mut first).await, WatchUpdate::Delta { .. }));

        let mut second = hub
            .subscribe("c1|pods".into(), upstream.open())
            .await
            .unwrap();
        assert_eq!(
            upstream.opened.load(Ordering::SeqCst),
            1,
            "joined, not opened again"
        );
        assert_eq!(names(&next(&mut second).await), ["web-2", "web-3"]);
        // From now on both get the same updates.
        upstream.send(WatchUpdate::Reconnecting);
        assert_eq!(next(&mut first).await, WatchUpdate::Reconnecting);
        assert_eq!(next(&mut second).await, WatchUpdate::Reconnecting);
        // A third joining while it reconnects hears so after the list.
        let mut third = hub
            .subscribe("c1|pods".into(), upstream.open())
            .await
            .unwrap();
        assert_eq!(names(&next(&mut third).await), ["web-2", "web-3"]);
        assert_eq!(next(&mut third).await, WatchUpdate::Reconnecting);
        assert_eq!(hub.running(), 1);
    }

    #[tokio::test]
    async fn a_frame_that_joins_a_capped_list_is_told_the_cap() {
        let hub = WatchHub::default();
        let upstream = Upstream::new();
        let mut first = hub
            .subscribe("c1|pods|cap".into(), upstream.open())
            .await
            .unwrap();
        upstream.send(WatchUpdate::Snapshot {
            items: vec![object("1", "web-1")],
        });
        upstream.send(WatchUpdate::Capped { total: 7 });
        next(&mut first).await;
        assert!(matches!(
            next(&mut first).await,
            WatchUpdate::Capped { total: 7 }
        ));
        let mut second = hub
            .subscribe("c1|pods|cap".into(), upstream.open())
            .await
            .unwrap();
        assert_eq!(names(&next(&mut second).await), ["web-1"]);
        assert!(matches!(
            next(&mut second).await,
            WatchUpdate::Capped { total: 7 }
        ));
    }

    #[tokio::test]
    async fn another_list_is_another_watch_and_the_watch_closes_with_the_last_frame() {
        let hub = WatchHub::default();
        let pods = Upstream::new();
        let other = Upstream::new();
        let first = hub.subscribe("c1|pods".into(), pods.open()).await.unwrap();
        let second = hub.subscribe("c1|pods".into(), pods.open()).await.unwrap();
        let elsewhere = hub
            .subscribe("c1|pods|team-a".into(), other.open())
            .await
            .unwrap();
        assert_eq!(
            (
                pods.opened.load(Ordering::SeqCst),
                other.opened.load(Ordering::SeqCst)
            ),
            (1, 1)
        );
        drop(first);
        tokio::task::yield_now().await;
        assert!(!pods.closed(), "one frame still watches");
        drop(second);
        tokio::time::timeout(Duration::from_secs(2), async {
            while !pods.closed() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the last frame gone closes the watch");
        assert!(!other.closed());
        drop(elsewhere);
        // A list that closed is opened afresh.
        let _again = hub.subscribe("c1|pods".into(), pods.open()).await.unwrap();
        assert_eq!(pods.opened.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_watch_that_cannot_open_fails_that_call_and_a_list_that_ended_is_not_joined() {
        let hub = WatchHub::default();
        let failing = async {
            Err::<futures::stream::Empty<WatchUpdate>, _>(CoreError::new(
                ErrorCode::Forbidden,
                "no",
            ))
        };
        assert_eq!(
            hub.subscribe("c1|x".into(), failing)
                .await
                .err()
                .unwrap()
                .code,
            ErrorCode::Forbidden
        );
        let upstream = Upstream::new();
        let mut first = hub.subscribe("c1|x".into(), upstream.open()).await.unwrap();
        // The core's watch ends: its frames' streams end, and the next frame opens a new one.
        *lock(&upstream.tx) = None;
        assert!(
            tokio::time::timeout(Duration::from_secs(2), first.next())
                .await
                .unwrap()
                .is_none()
        );
        let _second = hub.subscribe("c1|x".into(), upstream.open()).await.unwrap();
        assert_eq!(upstream.opened.load(Ordering::SeqCst), 2);
    }
}
