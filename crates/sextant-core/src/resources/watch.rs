//! Live watch of a kind: one `kube::runtime::watcher` per namespace (or one for all), a store of the objects
//! seen, and batches every 250 ms.
//!
//! What the stream yields (see [`WatchUpdate`]):
//! - `Snapshot` — the full list, first after the initial list and again after every relist (reconnect,
//!   expired `resourceVersion`);
//! - `Delta` — objects added/changed and uids deleted since the previous batch;
//! - `Reconnecting` — the connection was lost; the data on screen stays, a new list follows with growing pauses
//!   (1 s, 2 s, 4 s, 8 s, then every 15 s) until the API server answers, and then a fresh `Snapshot`;
//! - `Forbidden` — some of the selected namespaces cannot be listed or watched (no permission), at the start or at
//!   any later moment (e.g. the right was revoked); they are left out for the rest of the watch and a new
//!   `Snapshot` without their objects follows, the others keep streaming. Every `Forbidden` names all such
//!   namespaces so far;
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

/// Starts watching `spec.kind`. Fails right away when the cluster is not connected (`notFound`) or its discovery
/// does not list the kind (`notFound`); a built-in kind starts without discovery, so a version the server lacks
/// arrives as `Error` in the stream, like everything else later (including "forbidden"). Dropping the stream (or
/// this future, while discovery runs) stops the watch.
pub async fn watch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    spec: WatchSpec,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + use<>> {
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
        // Once data was shown, any other error is treated as a lost connection: an API server that is starting up
        // answers 401/403 for a moment.
        if fatal && !self.snapshot_sent {
            self.streams = SelectAll::new();
            self.fatal = Some(err);
        } else {
            self.lose_connection();
        }
    }

    /// Leaves out a namespace that cannot be listed or watched, if other sources remain: its watcher stops, the
    /// others go on, and its objects leave the store (a new snapshot without them follows once everything left is
    /// listed). `false` when it is not such a namespace (all namespaces, or the last source).
    fn forbid(&mut self, index: usize) -> bool {
        let others = (0..self.sources.len()).any(|i| i != index && !self.forbidden[i]);
        if self.sources[index].namespace.is_none() || !others {
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
    //! `watch()` and discovery against a fake API server on localhost (plain HTTP, no cluster needed).
    use super::*;
    use crate::fake_api::{FakeApi, Reply, Request, connected_to};
    use crate::resources::KindRef;

    const API_VERSIONS: &str =
        r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
    const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]},{"name":"pods/log","singularName":"","namespaced":true,"kind":"Pod","verbs":["get"]},{"name":"nodes","singularName":"node","namespaced":false,"kind":"Node","verbs":["get","list","watch"]},{"name":"secrets","singularName":"secret","namespaced":true,"kind":"Secret","verbs":["get","list","watch"]}]}"#;
    const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[{"name":"demo.sextant.dev","versions":[{"groupVersion":"demo.sextant.dev/v1","version":"v1"}],"preferredVersion":{"groupVersion":"demo.sextant.dev/v1","version":"v1"}}]}"#;
    const DEMO_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"demo.sextant.dev/v1","resources":[{"name":"widgets","singularName":"widget","namespaced":true,"kind":"Widget","verbs":["get","list","watch"]}]}"#;
    /// Aggregated discovery (Kubernetes 1.30+): the core group and every other group in one answer each.
    const AGGREGATED_CORE: &str = r#"{"kind":"APIGroupDiscoveryList","apiVersion":"apidiscovery.k8s.io/v2","metadata":{},"items":[{"metadata":{},"versions":[{"version":"v1","resources":[{"resource":"pods","responseKind":{"group":"","version":"","kind":"Pod"},"scope":"Namespaced","singularResource":"pod","verbs":["get","list","watch"],"subresources":[{"subresource":"log","responseKind":{"group":"","version":"","kind":"Pod"},"verbs":["get"]}]},{"resource":"nodes","responseKind":{"group":"","version":"","kind":"Node"},"scope":"Cluster","singularResource":"node","verbs":["get","list","watch"]},{"resource":"secrets","responseKind":{"group":"","version":"","kind":"Secret"},"scope":"Namespaced","singularResource":"secret","verbs":["get","list","watch"]}],"freshness":"Current"}]}]}"#;
    const AGGREGATED_GROUPS: &str = r#"{"kind":"APIGroupDiscoveryList","apiVersion":"apidiscovery.k8s.io/v2","metadata":{},"items":[{"metadata":{"name":"demo.sextant.dev"},"versions":[{"version":"v1","resources":[{"resource":"widgets","responseKind":{"group":"demo.sextant.dev","version":"v1","kind":"Widget"},"scope":"Namespaced","singularResource":"widget","verbs":["get","list","watch"]}],"freshness":"Current"}]}]}"#;
    const CRD_LIST: &str = r#"{"apiVersion":"apiextensions.k8s.io/v1","kind":"CustomResourceDefinitionList","metadata":{"resourceVersion":"1"},"items":[]}"#;
    const FORBIDDEN: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","message":"cannot watch secrets","code":403}"#;
    const POD_LIST: &str = r#"{"apiVersion":"v1","kind":"PodList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"a","namespace":"default","uid":"uid-a","resourceVersion":"1"}}]}"#;
    const POD_ADDED: &str = r#"{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"b","namespace":"default","uid":"uid-b","resourceVersion":"2"}}}"#;
    const NODE_LIST: &str = r#"{"apiVersion":"v1","kind":"NodeList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"node-1","uid":"uid-node-1","resourceVersion":"1"}}]}"#;
    const WIDGET_LIST: &str = r#"{"apiVersion":"demo.sextant.dev/v1","kind":"WidgetList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"w","namespace":"default","uid":"uid-w","resourceVersion":"1"}}]}"#;

    /// How the fake API server behaves.
    #[derive(Clone, Copy, Default)]
    struct Behaviour {
        /// Answers aggregated discovery like Kubernetes 1.30+; otherwise only the per-group-version discovery.
        aggregated: bool,
        /// Pause before answering `/apis`.
        discovery_delay: Duration,
        /// `/apis` never answers.
        hang_discovery: bool,
        /// Secrets in this namespace can be listed but not watched (403).
        no_watch_in: Option<&'static str>,
    }

    /// A fake API server: discovery (core `v1` with pods, nodes, secrets; group `demo.sextant.dev/v1` with
    /// widgets), lists of those, and watches that stay open (the pod watch first sends [`POD_ADDED`]).
    async fn fake_api(behaviour: Behaviour) -> FakeApi {
        FakeApi::start(move |req: &Request| answer(behaviour, req)).await
    }

    fn answer(behaviour: Behaviour, req: &Request) -> Reply {
        let path = req.path.as_str();
        if path == "/apis" && behaviour.hang_discovery {
            return Reply::hang();
        }
        let secrets_ns = path
            .strip_prefix("/api/v1/namespaces/")
            .and_then(|rest| rest.strip_suffix("/secrets"));
        if req.query.contains("watch=") {
            if secrets_ns.is_some() && secrets_ns == behaviour.no_watch_in {
                return Reply::json(403, FORBIDDEN);
            }
            return Reply::stream(if path == "/api/v1/pods" {
                format!("{POD_ADDED}\n")
            } else {
                String::new()
            });
        }
        let aggregated = behaviour.aggregated && req.header("accept").contains("apidiscovery");
        match path {
            "/api" if aggregated => Reply::json(200, AGGREGATED_CORE),
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE_RESOURCES),
            "/apis" if aggregated => {
                Reply::json(200, AGGREGATED_GROUPS).after(behaviour.discovery_delay)
            }
            "/apis" => Reply::json(200, API_GROUPS).after(behaviour.discovery_delay),
            "/apis/demo.sextant.dev/v1" => Reply::json(200, DEMO_RESOURCES),
            "/apis/apiextensions.k8s.io/v1/customresourcedefinitions" => Reply::json(200, CRD_LIST),
            "/api/v1/pods" => Reply::json(200, POD_LIST),
            "/api/v1/nodes" => Reply::json(200, NODE_LIST),
            "/apis/demo.sextant.dev/v1/widgets" => Reply::json(200, WIDGET_LIST),
            _ => match secrets_ns {
                Some(ns) => Reply::json(
                    200,
                    format!(
                        r#"{{"apiVersion":"v1","kind":"SecretList","metadata":{{"resourceVersion":"1"}},"items":[{{"metadata":{{"name":"s-{ns}","namespace":"{ns}","uid":"uid-{ns}","resourceVersion":"1"}}}}]}}"#
                    ),
                ),
                None => Reply::not_found(),
            },
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

    fn spec(group: &str, kind: &str, namespaces: Option<&[&str]>) -> WatchSpec {
        WatchSpec {
            kind: KindRef {
                group: group.into(),
                version: "v1".into(),
                kind: kind.into(),
            },
            namespaces: namespaces.map(|ns| ns.iter().map(|n| n.to_string()).collect()),
            label_selector: None,
            field_selector: None,
        }
    }

    /// The first snapshot of a fresh watch.
    async fn first_snapshot(mgr: &ClusterManager, id: &ClusterId, spec: WatchSpec) -> Vec<Value> {
        let mut updates = Box::pin(watch(mgr, id, spec).await.unwrap());
        match tokio::time::timeout(Duration::from_secs(5), updates.next()).await {
            Ok(Some(WatchUpdate::Snapshot { items })) => items,
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_first_snapshot_is_sent_as_soon_as_it_is_listed_and_later_batches_keep_the_interval()
     {
        let api = fake_api(Behaviour::default()).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        // Discovery first, so that only the list itself is timed.
        mgr.kinds(&id).await.unwrap();
        let started = Instant::now();
        let mut updates = Box::pin(watch(&mgr, &id, spec("", "Pod", None)).await.unwrap());

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

    #[tokio::test]
    async fn ten_watches_started_at_once_on_a_cold_cache_share_one_discovery() {
        for aggregated in [true, false] {
            let api = fake_api(Behaviour {
                aggregated,
                discovery_delay: Duration::from_millis(300),
                ..Behaviour::default()
            })
            .await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let starts =
                (0..10).map(|_| watch(&mgr, &id, spec("demo.sextant.dev", "Widget", None)));
            for started in futures::future::join_all(starts).await {
                assert!(started.is_ok(), "aggregated={aggregated}");
            }
            // Each discovery asks once for the groups (aggregated) or once for the group's resources (per group
            // version, after an aggregated attempt the server did not understand).
            let discoveries = || {
                api.count(if aggregated {
                    "/apis"
                } else {
                    "/apis/demo.sextant.dev/v1"
                })
            };
            assert_eq!(discoveries(), 1, "aggregated={aggregated}: one discovery");
            // Cached: a later watch asks nothing again.
            first_snapshot(&mgr, &id, spec("demo.sextant.dev", "Widget", None)).await;
            assert_eq!(discoveries(), 1, "aggregated={aggregated}: cached");
        }
    }

    #[tokio::test]
    async fn built_in_kinds_are_watched_without_discovery() {
        let api = fake_api(Behaviour {
            aggregated: true,
            ..Behaviour::default()
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let before = api.requests().len();
        assert_eq!(
            names(&first_snapshot(&mgr, &id, spec("", "Node", None)).await),
            ["node-1"]
        );
        assert_eq!(
            names(&first_snapshot(&mgr, &id, spec("", "Pod", None)).await),
            ["a"]
        );
        let asked: Vec<String> = api.requests()[before..]
            .iter()
            .map(|s| s.path.clone())
            .collect();
        assert!(
            asked
                .iter()
                .all(|p| p == "/api/v1/nodes" || p == "/api/v1/pods"),
            "only the lists themselves: {asked:?}"
        );
    }

    #[tokio::test]
    async fn discovery_lists_custom_kinds_without_downloading_the_crds() {
        for aggregated in [true, false] {
            let api = fake_api(Behaviour {
                aggregated,
                ..Behaviour::default()
            })
            .await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;
            let kinds = mgr.kinds(&id).await.unwrap();
            let found: Vec<(String, String, bool)> = kinds
                .iter()
                .map(|k| (k.kind_ref.kind.clone(), k.plural.clone(), k.namespaced))
                .collect();
            for expected in [
                ("Pod", "pods", true),
                ("Node", "nodes", false),
                ("Widget", "widgets", true),
            ] {
                assert!(
                    found.contains(&(expected.0.into(), expected.1.into(), expected.2)),
                    "aggregated={aggregated}: {expected:?} in {found:?}"
                );
            }
            assert!(
                !kinds.iter().any(|k| k.plural.contains('/')),
                "no subresources"
            );
            assert_eq!(
                api.count("/apis/apiextensions.k8s.io/v1/customresourcedefinitions"),
                0,
                "aggregated={aggregated}: the CRDs (with their schemas) are not downloaded"
            );
        }
    }

    #[tokio::test]
    async fn requests_accept_gzip() {
        let api = fake_api(Behaviour::default()).await;
        let (_tmp, _mgr, _id) = connected_to(api.url()).await;
        let first = api
            .requests()
            .into_iter()
            .next()
            .expect("the connection check");
        assert!(
            first.header("accept-encoding").contains("gzip"),
            "{first:?}"
        );
    }

    #[tokio::test]
    async fn a_watch_given_up_during_discovery_cancels_the_discovery() {
        let api = fake_api(Behaviour {
            hang_discovery: true,
            ..Behaviour::default()
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let given_up = tokio::time::timeout(
            Duration::from_millis(300),
            watch(&mgr, &id, spec("demo.sextant.dev", "Widget", None)),
        )
        .await;
        assert!(given_up.is_err(), "discovery never answers");
        let deadline = Instant::now() + Duration::from_secs(5);
        while api.abandoned() == 0 {
            assert!(
                Instant::now() < deadline,
                "the discovery request is still running"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn a_namespace_that_can_be_listed_but_not_watched_is_left_out_and_the_others_stay() {
        let api = fake_api(Behaviour {
            no_watch_in: Some("b"),
            ..Behaviour::default()
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let mut updates = Box::pin(
            watch(&mgr, &id, spec("", "Secret", Some(&["a", "b"])))
                .await
                .unwrap(),
        );
        let mut forbidden = None;
        let mut last_items = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        while forbidden.is_none()
            || last_items
                .as_ref()
                .is_none_or(|items: &Vec<Value>| items.len() != 1)
        {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, updates.next()).await {
                Ok(Some(WatchUpdate::Snapshot { items })) => last_items = Some(items),
                Ok(Some(WatchUpdate::Forbidden { namespaces })) => forbidden = Some(namespaces),
                Ok(Some(WatchUpdate::Delta { .. })) => {}
                other => panic!(
                    "expected snapshots and forbidden, got {other:?} (forbidden {forbidden:?}, items {last_items:?})"
                ),
            }
        }
        assert_eq!(forbidden.unwrap(), ["b"]);
        assert_eq!(
            names(&last_items.unwrap()),
            ["s-a"],
            "the other namespace's data stays"
        );
    }
}
