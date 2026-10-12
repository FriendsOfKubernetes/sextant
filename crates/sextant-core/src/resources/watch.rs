//! Live watch of a kind: one `kube::runtime::watcher` per namespace (or one for all), a store of the objects
//! seen, and batches every 250 ms.
//!
//! What the stream yields (see [`WatchUpdate`]):
//! - `Snapshot` — the full list, first after the initial list and again after every relist (reconnect,
//!   expired `resourceVersion`);
//! - `Delta` — objects added/changed and uids deleted since the previous batch;
//! - `Reconnecting` — the connection was lost; the data on screen stays, a new list follows with growing pauses
//!   (1 s, 2 s, 4 s, 8 s, then every 15 s) until the API server answers, and then a fresh `Snapshot`;
//! - `Forbidden` — some of the selected namespaces cannot be listed (no permission); they are left out for the rest
//!   of the watch, the others keep streaming. Every `Forbidden` names all such namespaces so far;
//! - `Error` — the watch cannot start (no permission to list the kind in any of the namespaces, unknown kind,
//!   rejected credentials); the stream ends after it.
//!
//! The first snapshot is sent as soon as everything is listed (the caller listens before it starts the watch);
//! after it, at most one update per 250 ms.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures::stream::{AbortHandle, BoxStream, SelectAll};
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
    let sources: Vec<Source> = if kind.namespaced && !namespaces.is_empty() {
        namespaces
            .into_iter()
            .map(|ns| Source {
                api: kind.api(client.clone(), Some(&ns)),
                namespace: Some(ns),
            })
            .collect()
    } else {
        vec![Source {
            api: kind.api(client, None),
            namespace: None,
        }]
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

    let state = Batcher::new(sources, config, kind.resource, BATCH_INTERVAL);
    Ok(futures::stream::unfold(state, |mut state| async move {
        let update = state.next_update().await?;
        Some((update, state))
    }))
}

type Events = BoxStream<'static, (usize, watcher::Result<watcher::Event<DynamicObject>>)>;

/// One watched API: a namespace, or all of them (`namespace: None`).
struct Source {
    api: Api<DynamicObject>,
    namespace: Option<String>,
}

/// Watcher streams + store + pending batch.
struct Batcher {
    sources: Vec<Source>,
    config: watcher::Config,
    resource: ApiResource,
    /// Empty while waiting for a reconnect.
    streams: SelectAll<Events>,
    /// Stops the stream of one source (index = source) without touching the others.
    aborts: Vec<Option<AbortHandle>>,
    /// Sources whose namespace cannot be listed; they are not watched any more.
    forbidden: Vec<bool>,
    /// A `Forbidden` update waits to be sent.
    forbidden_pending: bool,
    /// Sources listed at least once (a later refusal is not "no permission" but a hiccup).
    ever_listed: Vec<bool>,
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
        sources: Vec<Source>,
        config: watcher::Config,
        resource: ApiResource,
        interval: Duration,
    ) -> Self {
        let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let count = sources.len();
        let mut batcher = Self {
            sources,
            config,
            resource,
            streams: SelectAll::new(),
            aborts: vec![None; count],
            forbidden: vec![false; count],
            forbidden_pending: false,
            ever_listed: vec![false; count],
            store: HashMap::new(),
            init_buffers: vec![None; count],
            listed: vec![false; count],
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

    /// (Re)starts the watchers of every source that may be listed.
    fn start_streams(&mut self) {
        self.streams = SelectAll::new();
        for (index, source) in self.sources.iter().enumerate() {
            self.aborts[index] = None;
            if self.forbidden[index] {
                continue;
            }
            let events =
                watcher(source.api.clone(), self.config.clone()).map(move |event| (index, event));
            let (events, abort) = futures::stream::abortable(events);
            self.aborts[index] = Some(abort);
            self.streams.push(events.boxed());
        }
        self.listed.iter_mut().for_each(|l| *l = false);
        self.init_buffers.iter_mut().for_each(|b| *b = None);
        self.retry_at = None;
    }

    /// Every source that is still watched has finished its (re)list.
    fn all_listed(&self) -> bool {
        self.listed
            .iter()
            .zip(&self.forbidden)
            .all(|(listed, forbidden)| *listed || *forbidden)
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
            if self.forbidden_pending {
                self.forbidden_pending = false;
                let namespaces = self
                    .sources
                    .iter()
                    .zip(&self.forbidden)
                    .filter(|(_, forbidden)| **forbidden)
                    .filter_map(|(source, _)| source.namespace.clone())
                    .collect();
                return Some(WatchUpdate::Forbidden { namespaces });
            }
            // The first full list goes out at once; the interval counts from it.
            if self.snapshot_pending && !self.snapshot_sent {
                self.ticker.reset();
                if let Some(update) = self.flush() {
                    return Some(update);
                }
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
                Wake::Event(Some((index, Ok(event)))) => self.apply(index, event),
                Wake::Event(Some((index, Err(err)))) => self.fail(index, err),
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
                self.ever_listed[index] = true;
                if self.all_listed() {
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

    fn fail(&mut self, index: usize, err: watcher::Error) {
        // An expired resourceVersion: the watcher relists by itself, the relist ends in a new snapshot.
        if matches!(&err, watcher::Error::WatchError(status) if status.code == 410) {
            return;
        }
        let err = CoreError::from(err);
        if err.code == ErrorCode::Forbidden && self.forbid(index) {
            return;
        }
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

    /// Leaves out a namespace that cannot be listed, if other sources remain: its watcher stops, the others go on.
    /// `false` when it is not such a namespace (all namespaces, already listed once, or the last source).
    fn forbid(&mut self, index: usize) -> bool {
        let others = (0..self.sources.len()).any(|i| i != index && !self.forbidden[i]);
        if self.sources[index].namespace.is_none() || self.ever_listed[index] || !others {
            return false;
        }
        self.forbidden[index] = true;
        self.forbidden_pending = true;
        if let Some(abort) = self.aborts[index].take() {
            abort.abort();
        }
        self.init_buffers[index] = None;
        self.store.retain(|_, (source, _)| *source != index);
        if self.all_listed() {
            self.snapshot_pending = true;
            self.attempt = 0;
        }
        true
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
    //! `watch()` against a fake API server on localhost (plain HTTP, no cluster needed).
    use std::sync::{Arc, RwLock};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::*;
    use crate::kubeconfig::{KubeconfigEnv, KubeconfigRegistry};
    use crate::resources::KindRef;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]}]}"#;
    const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;
    const NOT_FOUND: &str =
        r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#;
    const POD_LIST: &str = r#"{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"a","namespace":"default","uid":"uid-a","resourceVersion":"1"}}]}"#;
    const POD_ADDED: &str = r#"{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"b","namespace":"default","uid":"uid-b","resourceVersion":"2"}}}"#;

    /// Serves discovery (core `v1` with pods only) and `GET /api/v1/pods`: the list answers [`POD_LIST`] at once; a
    /// watch sends [`POD_ADDED`] at once and then stays open.
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
            let target = head.split_whitespace().nth(1).unwrap_or_default();
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            if path == "/api/v1/pods" && query.contains("watch=") {
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
            let (status, body) = match path {
                "/api" => ("200 OK", API_VERSIONS),
                "/api/v1" => ("200 OK", CORE_RESOURCES),
                "/apis" => ("200 OK", API_GROUPS),
                "/api/v1/pods" => ("200 OK", POD_LIST),
                _ => ("404 Not Found", NOT_FOUND),
            };
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            if conn.write_all(response.as_bytes()).await.is_err() {
                return;
            }
        }
    }

    /// A manager connected to the fake server through a kubeconfig without credentials.
    async fn connected_to(url: &str) -> (tempfile::TempDir, ClusterManager, ClusterId) {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("kubeconfig");
        std::fs::write(
            &path,
            format!(
                "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster:\n    server: {url}\n\
                 contexts:\n- name: fake\n  context:\n    cluster: fake\n    user: fake\n\
                 users:\n- name: fake\n  user: {{}}\ncurrent-context: fake\n"
            ),
        )
        .unwrap();
        let registry =
            KubeconfigRegistry::new(Vec::new(), tmp.path().join("state")).with_env(KubeconfigEnv {
                kubeconfig: Some(path.into_os_string()),
                home: None,
            });
        let id = registry.clusters().unwrap()[0].id.clone();
        let mgr = ClusterManager::new(Arc::new(RwLock::new(registry)));
        mgr.connect(&id).await.unwrap();
        (tmp, mgr, id)
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
        let (_tmp, mgr, id) = connected_to(&url).await;
        let spec = WatchSpec {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
            },
            namespaces: None,
            label_selector: None,
            field_selector: None,
        };
        // Discovery first, so that only the list itself is timed.
        mgr.kinds(&id).await.unwrap();
        let started = Instant::now();
        let mut updates = Box::pin(watch(&mgr, &id, spec).await.unwrap());

        // A snapshot held back until the first batch tick would come BATCH_INTERVAL after the start.
        let first = tokio::time::timeout(BATCH_INTERVAL * 4, updates.next())
            .await
            .expect("no snapshot")
            .unwrap();
        let snapshot_at = Instant::now();
        match first {
            WatchUpdate::Snapshot { items } => assert_eq!(names(&items), ["a"]),
            other => panic!("expected a snapshot, got {other:?}"),
        }
        assert!(
            snapshot_at - started < BATCH_INTERVAL,
            "the first snapshot waited {:?}",
            snapshot_at - started
        );

        // The pod added right after the list waits for the next tick: at most one batch per interval.
        let next = tokio::time::timeout(BATCH_INTERVAL * 8, updates.next())
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
            gap >= BATCH_INTERVAL - Duration::from_millis(50),
            "a batch {gap:?} after the snapshot"
        );
    }
}
