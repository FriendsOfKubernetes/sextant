//! Live watch of a kind: one `kube::runtime::watcher` per namespace (or one for all), a store of the objects
//! seen, and batches every 250 ms.
//!
//! What the stream yields (see [`WatchUpdate`]):
//! - `Snapshot` — the full list, first after the initial list and again after every relist (reconnect,
//!   expired `resourceVersion`);
//! - `Delta` — objects added/changed and uids deleted since the previous batch;
//! - `Reconnecting` — the connection was lost; the data on screen stays, a new list follows with growing pauses
//!   (1 s, 2 s, 4 s, 8 s, then every 15 s) until the API server answers, and then a fresh `Snapshot`;
//! - `Error` — the watch cannot start (no permission to list the kind, unknown kind, rejected credentials); the
//!   stream ends after it.
//!
//! The first snapshot is sent as soon as everything is listed (the caller listens before it starts the watch);
//! after it, at most one update per 250 ms.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::stream::{BoxStream, SelectAll};
use futures::{Stream, StreamExt};
use kube::Api;
use kube::api::{ApiResource, DynamicObject};
use kube::runtime::watcher;
use serde_json::Value;
use tokio::time::{Instant, Interval, MissedTickBehavior};

use super::get::{resolve_kind, to_json};
use super::{WatchSpec, WatchUpdate};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// How often updates are sent at most.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(250);
/// First pause before a reconnect; it doubles up to [`MAX_RETRY_DELAY`].
const FIRST_RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(15);

/// Starts watching `spec.kind`. Fails right away when the cluster is not connected (`notFound`) or does not serve
/// the kind (`notFound`); everything later (including "forbidden") arrives in the stream. Dropping the stream
/// stops the watch.
pub async fn watch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    spec: WatchSpec,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + 'static> {
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &spec.kind).await?;

    // `None` or an empty list = all namespaces; cluster-scoped kinds ignore namespaces.
    let mut namespaces: Vec<String> = spec.namespaces.unwrap_or_default();
    namespaces.sort();
    namespaces.dedup();
    let apis: Vec<Api<DynamicObject>> = if kind.namespaced && !namespaces.is_empty() {
        namespaces
            .iter()
            .map(|ns| kind.api(client.clone(), Some(ns)))
            .collect()
    } else {
        vec![kind.api(client, None)]
    };

    let mut config = watcher::Config::default();
    if let Some(labels) = spec
        .label_selector
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        config = config.labels(labels);
    }
    if let Some(fields) = spec
        .field_selector
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        config = config.fields(fields);
    }

    let state = Batcher::new(apis, config, kind.resource, BATCH_INTERVAL);
    Ok(futures::stream::unfold(state, |mut state| async move {
        let update = state.next_update().await?;
        Some((update, state))
    }))
}

type Events = BoxStream<'static, (usize, watcher::Result<watcher::Event<DynamicObject>>)>;

/// Watcher streams + store + pending batch.
struct Batcher {
    apis: Vec<Api<DynamicObject>>,
    config: watcher::Config,
    resource: ApiResource,
    /// Empty while waiting for a reconnect.
    streams: SelectAll<Events>,
    /// uid → (index of the source api, object).
    store: HashMap<String, (usize, Value)>,
    /// Objects of a source's running relist (`Init` … `InitDone`).
    init_buffers: Vec<Option<Vec<Value>>>,
    /// Sources whose (re)list finished.
    listed: Vec<bool>,
    /// A full list was sent at least once (errors after that are never fatal).
    snapshot_sent: bool,
    snapshot_pending: bool,
    upserted: HashMap<String, Value>,
    deleted: HashSet<String>,
    reconnecting: bool,
    reconnect_pending: bool,
    retry_at: Option<Instant>,
    attempt: u32,
    ticker: Interval,
    /// A fatal error waits here; the stream ends after it.
    fatal: Option<CoreError>,
    done: bool,
}

/// What woke the batcher up. Lives for one loop iteration, so its size does not matter.
#[allow(clippy::large_enum_variant)]
enum Wake {
    Tick,
    Event(Option<(usize, watcher::Result<watcher::Event<DynamicObject>>)>),
    Retry,
}

impl Batcher {
    fn new(
        apis: Vec<Api<DynamicObject>>,
        config: watcher::Config,
        resource: ApiResource,
        interval: Duration,
    ) -> Self {
        let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let sources = apis.len();
        let mut batcher = Self {
            apis,
            config,
            resource,
            streams: SelectAll::new(),
            store: HashMap::new(),
            init_buffers: vec![None; sources],
            listed: vec![false; sources],
            snapshot_sent: false,
            snapshot_pending: false,
            upserted: HashMap::new(),
            deleted: HashSet::new(),
            reconnecting: false,
            reconnect_pending: false,
            retry_at: None,
            attempt: 0,
            ticker,
            fatal: None,
            done: false,
        };
        batcher.start_streams();
        batcher
    }

    fn start_streams(&mut self) {
        self.streams = SelectAll::new();
        for (index, api) in self.apis.iter().enumerate() {
            let events = watcher(api.clone(), self.config.clone()).map(move |event| (index, event));
            self.streams.push(events.boxed());
        }
        self.listed.iter_mut().for_each(|l| *l = false);
        self.init_buffers.iter_mut().for_each(|b| *b = None);
        self.retry_at = None;
    }

    async fn next_update(&mut self) -> Option<WatchUpdate> {
        loop {
            if self.done {
                return None;
            }
            if let Some(err) = self.fatal.take() {
                self.done = true;
                return Some(WatchUpdate::Error(err));
            }
            let streaming = !self.streams.is_empty();
            let retry_at = self.retry_at;
            let wake = tokio::select! {
                _ = self.ticker.tick() => Wake::Tick,
                event = self.streams.next(), if streaming => Wake::Event(event),
                _ = sleep_until(retry_at), if retry_at.is_some() => Wake::Retry,
            };
            match wake {
                Wake::Tick => {
                    if let Some(update) = self.flush() {
                        return Some(update);
                    }
                }
                Wake::Event(Some((index, Ok(event)))) => {
                    self.apply(index, event);
                    // The first full list goes out at once; the interval counts from it.
                    if self.snapshot_pending && !self.snapshot_sent {
                        self.ticker.reset();
                        if let Some(update) = self.flush() {
                            return Some(update);
                        }
                    }
                }
                Wake::Event(Some((_, Err(err)))) => self.fail(err),
                // Watcher streams do not end by themselves; treat it like a lost connection.
                Wake::Event(None) => self.lose_connection(),
                Wake::Retry => self.start_streams(),
            }
        }
    }

    fn apply(&mut self, index: usize, event: watcher::Event<DynamicObject>) {
        match event {
            watcher::Event::Init => {
                self.init_buffers[index] = Some(Vec::new());
                self.listed[index] = false;
            }
            watcher::Event::InitApply(obj) => {
                if let Some(value) = self.json(obj) {
                    self.init_buffers[index]
                        .get_or_insert_with(Vec::new)
                        .push(value);
                }
            }
            watcher::Event::InitDone => {
                let items = self.init_buffers[index].take().unwrap_or_default();
                self.store.retain(|_, (source, _)| *source != index);
                for value in items {
                    self.store.insert(uid_of(&value), (index, value));
                }
                self.listed[index] = true;
                if self.listed.iter().all(|l| *l) {
                    self.snapshot_pending = true;
                    self.attempt = 0;
                }
            }
            watcher::Event::Apply(obj) => {
                if let Some(value) = self.json(obj) {
                    let uid = uid_of(&value);
                    self.deleted.remove(&uid);
                    self.upserted.insert(uid.clone(), value.clone());
                    self.store.insert(uid, (index, value));
                }
            }
            watcher::Event::Delete(obj) => {
                if let Some(value) = self.json(obj) {
                    let uid = uid_of(&value);
                    self.upserted.remove(&uid);
                    if self.store.remove(&uid).is_some() || self.snapshot_sent {
                        self.deleted.insert(uid);
                    }
                }
            }
        }
    }

    fn fail(&mut self, err: watcher::Error) {
        // An expired resourceVersion: the watcher relists by itself, the relist ends in a new snapshot.
        if matches!(&err, watcher::Error::WatchError(status) if status.code == 410) {
            return;
        }
        let err = CoreError::from(err);
        let fatal = matches!(
            err.code,
            ErrorCode::Forbidden
                | ErrorCode::NotFound
                | ErrorCode::Unauthorized
                | ErrorCode::Invalid
                | ErrorCode::AuthPlugin
                | ErrorCode::Kubeconfig
        );
        // Once data was shown, any error is treated as a lost connection: an API server that is starting up
        // answers 401/403 for a moment.
        if fatal && !self.snapshot_sent {
            self.streams = SelectAll::new();
            self.fatal = Some(err);
        } else {
            self.lose_connection();
        }
    }

    /// Drops the watchers and schedules a fresh list after a growing pause.
    fn lose_connection(&mut self) {
        self.streams = SelectAll::new();
        if !self.reconnecting {
            self.reconnecting = true;
            self.reconnect_pending = true;
        }
        let delay = FIRST_RETRY_DELAY
            .saturating_mul(1u32 << self.attempt.min(4))
            .min(MAX_RETRY_DELAY);
        self.attempt = self.attempt.saturating_add(1);
        self.retry_at = Some(Instant::now() + delay);
    }

    /// The batch to send on this tick, if any.
    fn flush(&mut self) -> Option<WatchUpdate> {
        if self.reconnect_pending {
            self.reconnect_pending = false;
            return Some(WatchUpdate::Reconnecting);
        }
        if self.snapshot_pending {
            self.snapshot_pending = false;
            self.snapshot_sent = true;
            self.reconnecting = false;
            self.upserted.clear();
            self.deleted.clear();
            let items = self.store.values().map(|(_, v)| v.clone()).collect();
            return Some(WatchUpdate::Snapshot { items });
        }
        // Changes wait until the first (or the post-reconnect) snapshot; it includes them.
        if !self.snapshot_sent || self.reconnecting {
            return None;
        }
        if self.upserted.is_empty() && self.deleted.is_empty() {
            return None;
        }
        Some(WatchUpdate::Delta {
            upserted: self.upserted.drain().map(|(_, v)| v).collect(),
            deleted: self.deleted.drain().collect(),
        })
    }

    fn json(&self, obj: DynamicObject) -> Option<Value> {
        // A DynamicObject always serializes; `None` only guards against the impossible.
        to_json(obj, &self.resource).ok()
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => futures::future::pending().await,
    }
}

/// `metadata.uid`, or `namespace/name` for the rare object without one.
fn uid_of(obj: &Value) -> String {
    let meta = &obj["metadata"];
    match meta["uid"].as_str() {
        Some(uid) => uid.to_owned(),
        None => format!(
            "{}/{}",
            meta["namespace"].as_str().unwrap_or_default(),
            meta["name"].as_str().unwrap_or_default()
        ),
    }
}

#[cfg(test)]
mod tests {
    //! The batcher against a fake API server on localhost (plain HTTP, no cluster needed).
    use std::time::Duration;

    use k8s_openapi::api::core::v1::Pod;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;

    const POD_LIST: &str = r#"{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"a","namespace":"default","uid":"uid-a","resourceVersion":"1"}}]}"#;
    const POD_ADDED: &str = r#"{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"b","namespace":"default","uid":"uid-b","resourceVersion":"2"}}}"#;

    /// Serves `GET /api/v1/pods`: the list answers [`POD_LIST`] at once; a watch sends [`POD_ADDED`] at once and then
    /// stays open.
    async fn fake_api_server() -> String {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            while let Ok((conn, _)) = listener.accept().await {
                tokio::spawn(serve(conn));
            }
        });
        url
    }

    async fn serve(mut conn: TcpStream) {
        let mut buf = Vec::new();
        loop {
            // One request head (GET, no body) at a time on a kept-alive connection.
            let head_end = loop {
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break end + 4;
                }
                let mut chunk = [0u8; 4096];
                match conn.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            };
            let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
            buf.drain(..head_end);
            if head.lines().next().unwrap_or_default().contains("watch=") {
                let line = format!("{POD_ADDED}\n");
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{line}\r\n",
                    line.len()
                );
                if conn.write_all(response.as_bytes()).await.is_err() {
                    return;
                }
                futures::future::pending::<()>().await;
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{POD_LIST}",
                POD_LIST.len()
            );
            if conn.write_all(response.as_bytes()).await.is_err() {
                return;
            }
        }
    }

    fn names(items: &[Value]) -> Vec<&str> {
        let mut names: Vec<&str> = items
            .iter()
            .map(|o| o["metadata"]["name"].as_str().unwrap_or_default())
            .collect();
        names.sort();
        names
    }

    #[tokio::test]
    async fn the_first_snapshot_is_sent_as_soon_as_it_is_listed_and_later_batches_keep_the_interval()
     {
        let url = fake_api_server().await;
        let client = kube::Client::try_from(kube::Config::new(url.parse().unwrap())).unwrap();
        let resource = ApiResource::erase::<Pod>(&());
        let api = Api::<DynamicObject>::all_with(client, &resource);
        // A long interval: a snapshot held back until the first tick could not arrive in time.
        let interval = Duration::from_secs(2);
        let started = Instant::now();
        let mut batcher = Batcher::new(vec![api], watcher::Config::default(), resource, interval);

        let first = tokio::time::timeout(interval / 2, batcher.next_update())
            .await
            .expect("the first snapshot waited for the batch interval")
            .unwrap();
        let snapshot_at = Instant::now();
        match first {
            WatchUpdate::Snapshot { items } => assert_eq!(names(&items), ["a"]),
            other => panic!("expected a snapshot, got {other:?}"),
        }
        assert!(snapshot_at - started < interval);

        // The pod added right after the list waits for the next tick: at most one batch per interval.
        let next = tokio::time::timeout(interval * 3, batcher.next_update())
            .await
            .expect("the delta never came")
            .unwrap();
        match next {
            WatchUpdate::Delta { upserted, deleted } => {
                assert_eq!(names(&upserted), ["b"]);
                assert!(deleted.is_empty());
            }
            other => panic!("expected a delta, got {other:?}"),
        }
        let gap = Instant::now() - snapshot_at;
        assert!(
            gap >= interval - Duration::from_millis(50),
            "a batch {gap:?} after the snapshot"
        );
    }
}
