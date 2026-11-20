//! Live watch of a kind: one `kube::runtime::watcher` per namespace (or one for all), a store of the objects
//! seen, and batches every 250 ms.
//!
//! What the stream yields (see [`WatchUpdate`]):
//! - `Snapshot` — the full list, first after the initial list and again after a lost connection;
//! - `Delta` — objects added/changed and uids deleted since the previous batch. A relist with the connection up
//!   (an expired `resourceVersion`, a source listed again because its watch was refused, a forbidden namespace
//!   leaving or coming back) is told as one too: what it changed, not the whole list again (#342);
//! - `Reconnecting` — the connection was lost; the data on screen stays, a new list follows with growing pauses
//!   (1 s, 2 s, 4 s, 8 s, then every 15 s) until the API server answers, and then a fresh `Snapshot`. Once data was
//!   shown, a watch that breaks now and then (a proxy such as Teleport's ending long requests) is not a lost
//!   connection: kube's watcher resumes it from its last `resourceVersion` after a growing pause (800 ms up to 30 s),
//!   with no list and no snapshot (#342). A stream that worked and broke is always resumed so; only a source whose
//!   watches cannot start or are refused ([`TRANSIENT_LIMIT`] in a row over at least [`TRANSIENT_WINDOW`]) counts as a
//!   lost connection;
//! - `Forbidden` — some of the selected namespaces cannot be listed (no permission), at the start or at any later
//!   moment (e.g. the right was revoked); they are left out and a delta removing their objects follows, the others
//!   keep streaming. A left-out namespace is checked again after 30 s, then after pauses that
//!   double up to 5 min: a one-item list. Only when it is accepted is it watched again, and
//!   once its list is in, a `Forbidden` naming the namespaces still left out (maybe none) and a delta with its
//!   objects follow; a refused check changes nothing on screen. Every `Forbidden` names all namespaces left out at
//!   that moment;
//! - `Error` — the watch cannot start (no permission to list the kind in any of the namespaces, unknown kind,
//!   rejected credentials); the stream ends after it.
//!
//! A source the API server lets list but whose watch it refuses (403/405 after the list; the right to list a kind
//! but not to watch it) is listed every [`POLL_INTERVAL`] instead, and each list sends only what it changed (#342):
//! before, every refused watch was a lost connection, so the kind was listed again and a full snapshot sent every
//! second. A lost connection tries watching it again.
//!
//! With `WatchSpec::metadata_only`, the lists and watches ask the API server for metadata only
//! (`PartialObjectMetadata`): every object is `apiVersion`, `kind` and `metadata`, without the annotation
//! `kubectl.kubernetes.io/last-applied-configuration` (a copy of the whole object; a CRD's holds its schema).
//!
//! A whole-object watch of core/v1 Secrets has two sources per namespace: `type!=helm.sh/release.v1` as whole
//! objects, and `type=helm.sh/release.v1` as metadata only, so the release payloads (often megabytes each) are never
//! downloaded. A release Secret gets `type` and one empty `release` key, so its row looks as if it were whole. Values
//! are hidden as everywhere (`get::to_json`).
//!
//! The store keeps each object as its JSON text ([`WatchObject`], #170), not as a `serde_json::Value` tree several
//! times its size; every update carries the stored objects themselves, and they are written out as they are.
//!
//! The first snapshot is sent as soon as everything is listed (the caller listens before it starts the watch);
//! after it, at most one update per 250 ms.
//!
//! [`WatchOptions`] (the window's tables, #157): with `progressive`, the first list goes out in parts while its pages
//! come in (kube lists 500 objects per page): `SnapshotPart` with the objects listed so far as soon as there are any,
//! then at most one part per 250 ms, and a `SnapshotEnd` that completes them (a list that is in before any part went
//! out is one `Snapshot`, as without the option). With `max_objects`, only that many objects are kept (the first ones
//! listed; a slot freed by a deletion goes to the next object that changes); the others are remembered by uid only,
//! so their bodies are neither kept nor sent, and `Capped { total }` follows a batch whenever the number of matching
//! objects changes.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{AbortHandle, BoxStream, FuturesUnordered, SelectAll};
use futures::{FutureExt, Stream, StreamExt, TryStreamExt};
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams, PartialObjectMeta, WatchParams};
use kube::core::ObjectList;
use kube::runtime::{WatchStreamExt, watcher};
use serde_json::Value;
use tokio::time::{Instant, Interval, MissedTickBehavior};

use super::get::{LAST_APPLIED_ANNOTATION, ResolvedKind, resolve_kind, to_watch_object};
use super::{WatchObject, WatchOptions, WatchSpec, WatchUpdate};
use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;

/// How often updates are sent at most.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(250);
/// First pause before a reconnect; it doubles up to [`MAX_RETRY_DELAY`].
const FIRST_RETRY_DELAY: Duration = Duration::from_secs(1);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(15);
/// A source's errors once data was shown are left to kube's watcher, which resumes it from its `resourceVersion`
/// after a growing pause, until there are this many in a row ...
const TRANSIENT_LIMIT: u32 = 4;
/// ... over at least this long: then the connection counts as lost, and everything is listed again.
#[cfg(not(test))]
const TRANSIENT_WINDOW: Duration = Duration::from_secs(15);
#[cfg(test)]
const TRANSIENT_WINDOW: Duration = Duration::from_secs(4);
/// How often a source whose watch the API server refused after its list (the right to list but not to watch) is
/// listed again instead (#342).
#[cfg(not(test))]
const POLL_INTERVAL: Duration = Duration::from_secs(30);
#[cfg(test)]
const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Objects per page of such a list (kube's watcher lists 500 at a time too).
const POLL_PAGE: u32 = 500;
/// An error this long after the previous one starts a new run.
const TRANSIENT_FORGET: Duration = Duration::from_secs(60);

/// What the watches did since the start, for the counters line of Sextant's log (#342): counts only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WatchStats {
    /// Lists of a source after the watch's first snapshot (an expired `resourceVersion`, a reconnect).
    pub relists: u64,
    /// Lost connections after the first snapshot: every source listed again.
    pub reconnects: u64,
    /// Why, of `reconnects`: every watch stream ended; an error that is about the request (401, 403, 404, an
    /// invalid request, the credentials); errors that went on ([`TRANSIENT_LIMIT`] in a row).
    pub reconnects_ended: u64,
    pub reconnects_refused: u64,
    pub reconnects_repeated: u64,
    /// Sources whose watch the API server refused after their list, from then on listed every [`POLL_INTERVAL`],
    /// and those lists.
    pub polled: u64,
    pub polls: u64,
    /// Expired `resourceVersion`s (410).
    pub gone: u64,
    /// Errors left to the watcher to resume, by kind: the stream broke, a watch could not start, the API server
    /// sent an error event, a list failed, anything else.
    pub resumed_broken: u64,
    pub resumed_start: u64,
    pub resumed_event: u64,
    pub resumed_list: u64,
    pub resumed_other: u64,
}

mod stats {
    use std::sync::atomic::{AtomicU64, Ordering};

    pub(super) static RELISTS: AtomicU64 = AtomicU64::new(0);
    pub(super) static RECONNECTS: AtomicU64 = AtomicU64::new(0);
    /// ended, refused, repeated.
    pub(super) static RECONNECT_CAUSES: [AtomicU64; 3] = [const { AtomicU64::new(0) }; 3];
    pub(super) static POLLED: AtomicU64 = AtomicU64::new(0);
    pub(super) static POLLS: AtomicU64 = AtomicU64::new(0);
    pub(super) static GONE: AtomicU64 = AtomicU64::new(0);
    /// broken, start, event, list, other.
    pub(super) static RESUMED: [AtomicU64; 5] = [const { AtomicU64::new(0) }; 5];

    pub(super) fn add(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub(super) fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::Relaxed)
    }
}

/// [`WatchStats`] since the start of the process.
pub fn watch_stats() -> WatchStats {
    WatchStats {
        relists: stats::get(&stats::RELISTS),
        reconnects: stats::get(&stats::RECONNECTS),
        reconnects_ended: stats::get(&stats::RECONNECT_CAUSES[0]),
        reconnects_refused: stats::get(&stats::RECONNECT_CAUSES[1]),
        reconnects_repeated: stats::get(&stats::RECONNECT_CAUSES[2]),
        polled: stats::get(&stats::POLLED),
        polls: stats::get(&stats::POLLS),
        gone: stats::get(&stats::GONE),
        resumed_broken: stats::get(&stats::RESUMED[0]),
        resumed_start: stats::get(&stats::RESUMED[1]),
        resumed_event: stats::get(&stats::RESUMED[2]),
        resumed_list: stats::get(&stats::RESUMED[3]),
        resumed_other: stats::get(&stats::RESUMED[4]),
    }
}

/// Whether an error says the API server could not be reached or refused (a watch that could not start, a failed
/// list, an error status), as opposed to a stream that worked and broke (its connection cut by a proxy, a broken
/// line): only the first kind counts toward a lost connection, since a break is followed by a resumed watch.
fn unreachable_or_refused(err: &watcher::Error) -> bool {
    match err {
        watcher::Error::WatchFailed(kube::Error::Api(_)) => true,
        watcher::Error::WatchFailed(_) => false,
        _ => true,
    }
}

/// Whether an error is the API server refusing a watch (403, or 405 where watching is not served), as it does where
/// the user may list a kind but not watch it.
fn watch_refused(err: &watcher::Error) -> bool {
    let refused = |code: u16| code == 403 || code == 405;
    match err {
        watcher::Error::WatchStartFailed(kube::Error::Api(status))
        | watcher::Error::WatchFailed(kube::Error::Api(status)) => refused(status.code),
        watcher::Error::WatchError(status) => refused(status.code),
        _ => false,
    }
}

/// The index in `stats::RESUMED` of an error left to the watcher.
fn resumed_class(err: &watcher::Error) -> usize {
    match err {
        watcher::Error::WatchFailed(_) => 0,
        watcher::Error::WatchStartFailed(_) => 1,
        watcher::Error::WatchError(_) => 2,
        watcher::Error::InitialListFailed(_) => 3,
        _ => 4,
    }
}

/// A source's errors in a row once data was shown.
#[derive(Debug, Clone, Copy, Default)]
struct TransientRun {
    count: u32,
    first: Option<Instant>,
    last: Option<Instant>,
}

/// Pauses before a namespace that answered 403 is listed again: `first`, doubling up to `max`.
#[derive(Debug, Clone, Copy)]
struct ForbiddenRetry {
    first: Duration,
    max: Duration,
}

const FORBIDDEN_RETRY: ForbiddenRetry = ForbiddenRetry {
    first: Duration::from_secs(30),
    max: Duration::from_secs(5 * 60),
};

/// Starts watching `spec.kind`. Fails right away when the cluster is not connected (`notFound`) or its discovery
/// does not list the kind (`notFound`); a built-in kind starts without discovery, so a version the server lacks
/// arrives as `Error` in the stream, like everything else later (including "forbidden"). Dropping the stream (or
/// this future, while discovery runs) stops the watch.
pub async fn watch(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    spec: WatchSpec,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + use<>> {
    watch_with(mgr, cluster, spec, WatchOptions::default(), FORBIDDEN_RETRY).await
}

/// [`watch`] delivered as `options` ask (the window's tables: the first list in parts, a cap on the objects kept).
pub async fn watch_with_options(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    spec: WatchSpec,
    options: WatchOptions,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + use<>> {
    watch_with(mgr, cluster, spec, options, FORBIDDEN_RETRY).await
}

/// [`watch`] with its own pauses before a forbidden namespace is tried again (tests make them short).
async fn watch_with(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    spec: WatchSpec,
    options: WatchOptions,
    forbidden_retry: ForbiddenRetry,
) -> CoreResult<impl Stream<Item = WatchUpdate> + Send + use<>> {
    let client = mgr.client(cluster)?;
    let kind = resolve_kind(mgr, cluster, &spec.kind).await?;

    // `None` or an empty list = all namespaces; cluster-scoped kinds ignore namespaces.
    let mut namespaces: Vec<String> = spec.namespaces.unwrap_or_default();
    namespaces.sort();
    namespaces.dedup();
    let namespaces: Vec<Option<String>> = if kind.namespaced && !namespaces.is_empty() {
        namespaces.into_iter().map(Some).collect()
    } else {
        vec![None]
    };

    let labels = spec
        .label_selector
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    let fields = spec
        .field_selector
        .as_deref()
        .filter(|s| !s.trim().is_empty());
    let config = |fields: Option<&str>| {
        let mut config = watcher::Config::default();
        if let Some(labels) = labels {
            config = config.labels(labels);
        }
        if let Some(fields) = fields {
            config = config.fields(fields);
        }
        config
    };
    // The caller's field selector and `type<op>helm.sh/release.v1`.
    let with_type = |op: &str| {
        let by_type = format!("type{op}{HELM_RELEASE_TYPE}");
        match fields {
            Some(fields) => format!("{fields},{by_type}"),
            None => by_type,
        }
    };
    // Whole Secrets: Helm release payloads (megabytes each, values hidden anyway) are not downloaded.
    let split_secrets = !spec.metadata_only && is_secret(&kind.resource);

    let mut sources = Vec::new();
    for namespace in namespaces {
        let ns = namespace.as_deref();
        if split_secrets {
            sources.push(Source {
                api: SourceApi::Whole(kind.api(client.clone(), ns)),
                config: config(Some(&with_type("!="))),
                namespace: namespace.clone(),
            });
            sources.push(Source {
                api: SourceApi::metadata(&kind, client.clone(), ns, true),
                config: config(Some(&with_type("="))),
                namespace,
            });
        } else if spec.metadata_only {
            sources.push(Source {
                api: SourceApi::metadata(&kind, client.clone(), ns, false),
                config: config(fields),
                namespace,
            });
        } else {
            sources.push(Source {
                api: SourceApi::Whole(kind.api(client.clone(), ns)),
                config: config(fields),
                namespace,
            });
        }
    }

    let mut state = Batcher::new(sources, kind.resource, BATCH_INTERVAL, forbidden_retry);
    state.progressive = options.progressive.then(HashMap::new);
    state.cap = options.max_objects.map(|max| max as usize);
    Ok(futures::stream::unfold(state, |mut state| async move {
        let update = state.next_update().await?;
        Some((update, state))
    }))
}

/// The `type` of the Secrets in which Helm keeps its releases.
const HELM_RELEASE_TYPE: &str = "helm.sh/release.v1";

/// A core/v1 Secret.
fn is_secret(resource: &ApiResource) -> bool {
    resource.group.is_empty() && resource.kind == "Secret"
}

type Events = BoxStream<'static, (usize, watcher::Result<watcher::Event<DynamicObject>>)>;

/// One watched API: a namespace, or all of them (`namespace: None`), with its selectors. A whole-object Secret
/// watch has two sources per namespace (see [`watch`]).
struct Source {
    api: SourceApi,
    config: watcher::Config,
    namespace: Option<String>,
}

/// The API of a source: whole objects, or only their metadata (`WatchSpec::metadata_only`, Helm release Secrets).
#[derive(Clone)]
enum SourceApi {
    Whole(Api<DynamicObject>),
    /// `helm_release`: the objects are Helm release Secrets, and each gets the `type` and the one `release` key
    /// (empty) such a Secret has, so its row looks like the row of a whole Secret with its values hidden.
    Metadata {
        api: Api<PartialObjectMeta<DynamicObject>>,
        helm_release: bool,
    },
}

impl SourceApi {
    /// Like `ResolvedKind::api`: `namespace` is ignored for a cluster-scoped kind.
    fn metadata(
        kind: &ResolvedKind,
        client: kube::Client,
        namespace: Option<&str>,
        helm_release: bool,
    ) -> Self {
        let api = match namespace {
            Some(ns) if kind.namespaced => Api::namespaced_with(client, ns, &kind.resource),
            _ => Api::all_with(client, &kind.resource),
        };
        Self::Metadata { api, helm_release }
    }

    /// A watcher of this API; metadata-only objects come as `DynamicObject`s without any other field.
    fn watch(
        &self,
        config: watcher::Config,
    ) -> BoxStream<'static, watcher::Result<watcher::Event<DynamicObject>>> {
        match self {
            // A growing pause after an error (800 ms up to 30 s), so a watch that keeps failing is not retried in a
            // tight loop while the batcher leaves its errors to the watcher (#342).
            Self::Whole(api) => watcher(api.clone(), config).default_backoff().boxed(),
            Self::Metadata { api, helm_release } => {
                let helm_release = *helm_release;
                let refused = Arc::new((
                    api.clone(),
                    config.label_selector.clone(),
                    config.field_selector.clone(),
                ));
                watcher(api.clone(), config)
                    .default_backoff()
                    .then(move |event| {
                        let refused = Arc::clone(&refused);
                        async move {
                            let event = match event {
                                Err(watcher::Error::WatchFailed(kube::Error::SerdeError(err))) => {
                                    let (api, labels, fields) = &*refused;
                                    Err(watcher::Error::WatchFailed(
                                        refused_metadata_watch(
                                            api,
                                            labels.as_deref(),
                                            fields.as_deref(),
                                        )
                                        .await
                                        .unwrap_or(kube::Error::SerdeError(err)),
                                    ))
                                }
                                other => other,
                            };
                            event.map(|event| metadata_event(event, helm_release))
                        }
                    })
                    .boxed()
            }
        }
    }
}

impl SourceApi {
    /// Instead of a watcher, for a source whose watch was refused after its list: the source listed again every
    /// [`POLL_INTERVAL`], told as a watcher tells a relist (`Init`, `InitApply` …, `InitDone`); a failed list is an
    /// `InitialListFailed`, and the next one follows after the same pause.
    fn poll(
        &self,
        config: watcher::Config,
    ) -> BoxStream<'static, watcher::Result<watcher::Event<DynamicObject>>> {
        let api = self.clone();
        let mut params = ListParams::default().limit(POLL_PAGE);
        if let Some(labels) = &config.label_selector {
            params = params.labels(labels);
        }
        if let Some(fields) = &config.field_selector {
            params = params.fields(fields);
        }
        futures::stream::unfold((api, params), |(api, params)| async move {
            tokio::time::sleep(POLL_INTERVAL).await;
            let events = match api.list_all(&params).await {
                Ok(objects) => {
                    stats::add(&stats::POLLS);
                    let mut events = Vec::with_capacity(objects.len() + 2);
                    events.push(Ok(watcher::Event::Init));
                    events.extend(
                        objects
                            .into_iter()
                            .map(|o| Ok(watcher::Event::InitApply(o))),
                    );
                    events.push(Ok(watcher::Event::InitDone));
                    events
                }
                Err(err) => vec![Err(watcher::Error::InitialListFailed(err))],
            };
            Some((futures::stream::iter(events), (api, params)))
        })
        .flatten()
        .boxed()
    }

    /// Every object of one list, page by page; metadata-only objects as [`metadata_event`] makes them.
    async fn list_all(&self, params: &ListParams) -> kube::Result<Vec<DynamicObject>> {
        let mut params = params.clone();
        let mut objects = Vec::new();
        loop {
            let next = match self {
                Self::Whole(api) => {
                    let page = api.list(&params).await?;
                    objects.extend(page.items);
                    page.metadata.continue_
                }
                Self::Metadata { api, helm_release } => {
                    let page = api.list(&params).await?;
                    objects.extend(
                        page.items
                            .into_iter()
                            .map(|meta| metadata_object(meta, *helm_release)),
                    );
                    page.metadata.continue_
                }
            };
            match next.filter(|token| !token.is_empty()) {
                Some(token) => params.continue_token = Some(token),
                None => return Ok(objects),
            }
        }
    }
}

impl Source {
    /// Whether this source may now be listed (see [`may_list`]).
    fn access_check(&self, index: usize) -> BoxFuture<'static, (usize, bool)> {
        let (url, client) = match &self.api {
            SourceApi::Whole(api) => (api.resource_url().to_owned(), api.clone().into_client()),
            SourceApi::Metadata { api, .. } => {
                (api.resource_url().to_owned(), api.clone().into_client())
            }
        };
        let labels = self.config.label_selector.clone();
        let fields = self.config.field_selector.clone();
        Box::pin(async move {
            let allowed = may_list(client, url, labels.as_deref(), fields.as_deref()).await;
            (index, allowed)
        })
    }
}

/// Whether the objects at `url` may be listed: a one-item metadata list. Any failure counts as "not yet". Its watch
/// is not asked: a source the API server lets list but not watch is listed again instead (#342).
async fn may_list(
    client: kube::Client,
    url: String,
    labels: Option<&str>,
    fields: Option<&str>,
) -> bool {
    let request = kube::core::Request::new(url);
    let mut list = ListParams::default().limit(1);
    if let Some(labels) = labels {
        list = list.labels(labels);
    }
    if let Some(fields) = fields {
        list = list.fields(fields);
    }
    let check = async {
        let listed: kube::Result<ObjectList<PartialObjectMeta<DynamicObject>>> =
            client.request(request.list_metadata(&list).ok()?).await;
        Some(listed.is_ok())
    };
    tokio::time::timeout(REFUSAL_CHECK_TIMEOUT, check)
        .await
        .ok()
        .flatten()
        .unwrap_or(false)
}

/// `Accept` of a metadata-only watch with a JSON fallback.
const METADATA_WATCH_ACCEPT: &str =
    "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1, application/json";

/// The error of a metadata-only watch the API server refused. It answers kube's `Accept` (metadata, no fallback)
/// with an indented `Status`, which kube reads line by line and reports as a serde error, so a 403 would look like
/// a broken response. The same watch with a JSON fallback in `Accept` gets a one-line `Status`: its error, or
/// `None` when that watch starts (then the serde error was something else).
async fn refused_metadata_watch(
    api: &Api<PartialObjectMeta<DynamicObject>>,
    labels: Option<&str>,
    fields: Option<&str>,
) -> Option<kube::Error> {
    let mut params = WatchParams::default().timeout(1);
    if let Some(labels) = labels {
        params = params.labels(labels);
    }
    if let Some(fields) = fields {
        params = params.fields(fields);
    }
    let mut request = kube::core::Request::new(api.resource_url())
        .watch_metadata(&params, "0")
        .ok()?;
    request.headers_mut().insert(
        http::header::ACCEPT,
        http::HeaderValue::from_static(METADATA_WATCH_ACCEPT),
    );
    let client = api.clone().into_client();
    let first = tokio::time::timeout(REFUSAL_CHECK_TIMEOUT, async {
        let events = client
            .request_events::<PartialObjectMeta<DynamicObject>>(request)
            .await?;
        Box::pin(events).try_next().await
    })
    .await
    .ok()?;
    match first {
        Err(err @ kube::Error::Api(_)) => Some(err),
        _ => None,
    }
}

/// At most this many events already received are taken in at once during a progressive first list (a page is 500).
const PAGE_DRAIN: usize = 2000;

/// How long [`refused_metadata_watch`] and [`may_list`] wait for the API server.
const REFUSAL_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Watcher streams + store + pending batch.
struct Batcher {
    sources: Vec<Source>,
    resource: ApiResource,
    /// Empty while waiting for a reconnect.
    streams: SelectAll<Events>,
    /// Stops the stream of one source (index = source) without touching the others.
    aborts: Vec<Option<AbortHandle>>,
    /// Sources whose namespace cannot be listed or watched (403); they are left out until a retry lists them.
    forbidden: Vec<bool>,
    /// When a forbidden source is tried again; `None` while that retry runs (or when it is not forbidden).
    retry_forbidden_at: Vec<Option<Instant>>,
    /// Retries of a source since it was forbidden; the pause doubles with each.
    forbidden_attempt: Vec<u32>,
    /// When a retry brought a forbidden source back.
    restored_at: Vec<Option<Instant>>,
    /// Running checks whether a forbidden source may be listed again: (source, allowed).
    access_checks: FuturesUnordered<BoxFuture<'static, (usize, bool)>>,
    forbidden_retry: ForbiddenRetry,
    /// A `Forbidden` update waits to be sent.
    forbidden_pending: bool,
    /// uid → (index of the source api, object).
    store: HashMap<String, (usize, WatchObject)>,
    /// Objects of a source's running relist (`Init` … `InitDone`), with their uids.
    init_buffers: Vec<Option<Vec<(String, WatchObject)>>>,
    /// Sources whose (re)list finished.
    listed: Vec<bool>,
    /// A full list was sent at least once (errors after that are never fatal).
    snapshot_sent: bool,
    snapshot_pending: bool,
    upserted: HashMap<String, WatchObject>,
    deleted: HashSet<String>,
    reconnecting: bool,
    reconnect_pending: bool,
    retry_at: Option<Instant>,
    attempt: u32,
    ticker: Interval,
    /// A fatal error waits here; the stream ends after it.
    fatal: Option<CoreError>,
    done: bool,
    /// `WatchOptions::progressive` while the first list runs: what the parts sent, by uid (the very object, so a
    /// changed one is told apart); `None` without the option and once the first full list went out.
    progressive: Option<HashMap<String, WatchObject>>,
    /// `WatchOptions::max_objects`.
    cap: Option<usize>,
    /// Matching objects left out for the cap: uid → source.
    dropped: HashMap<String, usize>,
    /// Uids a source's running (re)list leaves out for the cap.
    init_dropped: Vec<Vec<String>>,
    /// How many objects of the store a source's running (re)list replaces (they leave the store at its end).
    init_old: Vec<usize>,
    /// The `total` of the last `Capped` sent.
    capped_sent: Option<u64>,
    /// Each source's errors in a row once data was shown, left to its watcher until they go on.
    runs: Vec<TransientRun>,
    /// Sources listed every [`POLL_INTERVAL`] since their watch was refused (a fresh start tries watching again).
    polling: Vec<bool>,
    /// A `Capped` waits to be sent after the batch just returned.
    capped_pending: Option<u64>,
}

/// What woke the batcher up. Lives for one loop iteration, so its size does not matter.
#[allow(clippy::large_enum_variant)]
enum Wake {
    Tick,
    Event(Option<(usize, watcher::Result<watcher::Event<DynamicObject>>)>),
    Retry,
    RetryForbidden,
    Checked(Option<(usize, bool)>),
}

impl Batcher {
    fn new(
        sources: Vec<Source>,
        resource: ApiResource,
        interval: Duration,
        forbidden_retry: ForbiddenRetry,
    ) -> Self {
        let mut ticker = tokio::time::interval_at(Instant::now() + interval, interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let count = sources.len();
        let mut batcher = Self {
            sources,
            resource,
            streams: SelectAll::new(),
            aborts: vec![None; count],
            forbidden: vec![false; count],
            retry_forbidden_at: vec![None; count],
            forbidden_attempt: vec![0; count],
            restored_at: vec![None; count],
            access_checks: FuturesUnordered::new(),
            forbidden_retry,
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
            progressive: None,
            cap: None,
            dropped: HashMap::new(),
            init_dropped: vec![Vec::new(); count],
            init_old: vec![0; count],
            capped_sent: None,
            capped_pending: None,
            runs: vec![TransientRun::default(); count],
            polling: vec![false; count],
        };
        batcher.start_streams();
        batcher
    }

    /// (Re)starts the watchers of every source that may be listed.
    fn start_streams(&mut self) {
        self.streams = SelectAll::new();
        for index in 0..self.sources.len() {
            self.aborts[index] = None;
            if !self.forbidden[index] {
                self.start_source(index);
            }
        }
        self.listed.iter_mut().for_each(|l| *l = false);
        self.polling.iter_mut().for_each(|p| *p = false);
        self.runs
            .iter_mut()
            .for_each(|r| *r = TransientRun::default());
        self.init_buffers.iter_mut().for_each(|b| *b = None);
        self.init_dropped.iter_mut().for_each(Vec::clear);
        self.retry_at = None;
    }

    /// Starts the watcher of one source next to the running ones.
    fn start_source(&mut self, index: usize) {
        let source = &self.sources[index];
        let events = source
            .api
            .watch(source.config.clone())
            .map(move |event| (index, event));
        let (events, abort) = futures::stream::abortable(events);
        self.aborts[index] = Some(abort);
        self.streams.push(events.boxed());
    }

    /// Replaces the refused watcher of one source by its list every [`POLL_INTERVAL`]; its objects stay.
    fn start_polling(&mut self, index: usize) {
        if let Some(abort) = self.aborts[index].take() {
            abort.abort();
        }
        self.polling[index] = true;
        stats::add(&stats::POLLED);
        let source = &self.sources[index];
        let events = source
            .api
            .poll(source.config.clone())
            .map(move |event| (index, event));
        let (events, abort) = futures::stream::abortable(events);
        self.aborts[index] = Some(abort);
        self.streams.push(events.boxed());
    }

    /// Stops the watcher of one source and drops its objects.
    fn stop_source(&mut self, index: usize) {
        if let Some(abort) = self.aborts[index].take() {
            abort.abort();
        }
        self.init_buffers[index] = None;
        self.init_dropped[index].clear();
        self.store.retain(|_, (source, _)| *source != index);
        self.dropped.retain(|_, source| *source != index);
    }

    /// Every source that is still watched has finished its (re)list.
    fn all_listed(&self) -> bool {
        self.listed
            .iter()
            .zip(&self.forbidden)
            .all(|(listed, forbidden)| *listed || *forbidden)
    }

    /// The earliest retry of a forbidden source; none while the watch waits for a reconnect or its relist.
    fn next_forbidden_retry(&self) -> Option<Instant> {
        if self.retry_at.is_some() || self.reconnecting {
            return None;
        }
        self.retry_forbidden_at.iter().flatten().min().copied()
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
            if let Some(total) = self.capped_pending.take() {
                return Some(WatchUpdate::Capped { total });
            }
            if self.forbidden_pending {
                self.forbidden_pending = false;
                let mut namespaces: Vec<String> = self
                    .sources
                    .iter()
                    .zip(&self.forbidden)
                    .filter(|(_, forbidden)| **forbidden)
                    .filter_map(|(source, _)| source.namespace.clone())
                    .collect();
                // Sources are sorted by namespace; a Secret watch has two per namespace.
                namespaces.dedup();
                return Some(WatchUpdate::Forbidden { namespaces });
            }
            // The first full list goes out at once, and so does the first part of a progressive one; the interval
            // counts from it.
            let first_part = self.progressive.as_ref().is_some_and(HashMap::is_empty)
                && !self.snapshot_sent
                && self.has_listed_objects();
            if (self.snapshot_pending || first_part) && !self.snapshot_sent {
                self.ticker.reset();
                if let Some(update) = self.flush() {
                    return Some(update);
                }
            }
            let streaming = !self.streams.is_empty();
            let retry_at = self.retry_at;
            let retry_forbidden_at = self.next_forbidden_retry();
            let checking = !self.access_checks.is_empty();
            let wake = tokio::select! {
                _ = self.ticker.tick() => Wake::Tick,
                event = self.streams.next(), if streaming => Wake::Event(event),
                _ = sleep_until(retry_at), if retry_at.is_some() => Wake::Retry,
                _ = sleep_until(retry_forbidden_at), if retry_forbidden_at.is_some() => Wake::RetryForbidden,
                checked = self.access_checks.next(), if checking => Wake::Checked(checked),
            };
            match wake {
                Wake::Tick => {
                    if let Some(update) = self.flush() {
                        return Some(update);
                    }
                }
                Wake::Event(event) => {
                    self.handle(event);
                    // A progressive first list takes in everything already received (the rest of a page) before
                    // it decides on a part, so a part is not one object of a page.
                    if self.progressive.is_some() {
                        for _ in 0..PAGE_DRAIN {
                            // A lost connection empties the streams: an empty set "ends" at once, which is not
                            // another lost connection.
                            if self.streams.is_empty() {
                                break;
                            }
                            match self.streams.next().now_or_never() {
                                Some(event) => self.handle(event),
                                None => break,
                            }
                        }
                    }
                }
                Wake::Retry => self.start_streams(),
                Wake::RetryForbidden => self.retry_forbidden(),
                Wake::Checked(Some((index, allowed))) => self.checked(index, allowed),
                Wake::Checked(None) => {}
            }
        }
    }

    fn handle(&mut self, event: Option<(usize, watcher::Result<watcher::Event<DynamicObject>>)>) {
        match event {
            Some((index, Ok(event))) => self.apply(index, event),
            Some((index, Err(err))) => self.fail(index, err),
            // Watcher streams do not end by themselves; treat it like a lost connection.
            None => {
                if self.snapshot_sent {
                    stats::add(&stats::RECONNECT_CAUSES[0]);
                }
                self.lose_connection();
            }
        }
    }

    fn apply(&mut self, index: usize, event: watcher::Event<DynamicObject>) {
        // The source answers again: its errors in a row are over.
        self.runs[index] = TransientRun::default();
        match event {
            watcher::Event::Init => {
                self.init_buffers[index] = Some(Vec::new());
                self.init_dropped[index].clear();
                self.listed[index] = false;
                self.init_old[index] = match self.cap {
                    Some(_) => self.store.values().filter(|(s, _)| *s == index).count(),
                    None => 0,
                };
            }
            watcher::Event::InitApply(obj) => {
                if !self.has_room_while_listing() {
                    // Over the cap: only the uid is remembered, the object is neither converted nor kept.
                    self.init_dropped[index].push(meta_uid(&obj.metadata));
                } else {
                    let uid = meta_uid(&obj.metadata);
                    if let Some(value) = self.json(obj) {
                        self.init_buffers[index]
                            .get_or_insert_with(Vec::new)
                            .push((uid, value));
                    }
                }
            }
            watcher::Event::InitDone => {
                if self.snapshot_sent && !self.polling[index] {
                    stats::add(&stats::RELISTS);
                }
                // A relist once data was shown, with the connection up (an expired `resourceVersion`, a source
                // listed again for its refused watch, a forbidden namespace back): the window gets what changed
                // since, not the whole list again (#342). After a lost connection a full snapshot ends
                // `Reconnecting`.
                let changes_only = self.snapshot_sent && !self.reconnecting;
                let items = self.init_buffers[index].take().unwrap_or_default();
                let left_out = std::mem::take(&mut self.init_dropped[index]);
                let before: HashMap<String, WatchObject> = if changes_only {
                    self.store
                        .iter()
                        .filter(|(_, (source, _))| *source == index)
                        .map(|(uid, (_, value))| (uid.clone(), value.clone()))
                        .collect()
                } else {
                    HashMap::new()
                };
                self.store.retain(|_, (source, _)| *source != index);
                self.dropped.retain(|_, source| *source != index);
                for (uid, value) in items {
                    if self.has_room() {
                        self.store.insert(uid, (index, value));
                    } else {
                        self.dropped.insert(uid, index);
                    }
                }
                for uid in left_out {
                    if !self.store.contains_key(&uid) {
                        self.dropped.insert(uid, index);
                    }
                }
                if changes_only {
                    self.note_changes(index, before);
                }
                if self.forbidden[index] {
                    // A retry listed the forbidden namespace: it is back, and a snapshot with its objects follows.
                    self.forbidden[index] = false;
                    self.restored_at[index] = Some(Instant::now());
                    self.forbidden_pending = true;
                }
                self.listed[index] = true;
                if self.all_listed() {
                    self.snapshot_pending = !changes_only;
                    self.attempt = 0;
                }
            }
            watcher::Event::Apply(obj) => {
                let uid = meta_uid(&obj.metadata);
                if !self.store.contains_key(&uid) && !self.has_room() {
                    // Over the cap: counted, not kept.
                    self.dropped.insert(uid, index);
                    return;
                }
                if let Some(value) = self.json(obj) {
                    self.dropped.remove(&uid);
                    self.deleted.remove(&uid);
                    self.upserted.insert(uid.clone(), value.clone());
                    self.store.insert(uid, (index, value));
                }
            }
            watcher::Event::Delete(obj) => {
                let uid = meta_uid(&obj.metadata);
                if self.dropped.remove(&uid).is_some() {
                    // The window never had it.
                    return;
                }
                self.upserted.remove(&uid);
                if self.store.remove(&uid).is_some() || self.snapshot_sent {
                    self.deleted.insert(uid);
                }
            }
        }
    }

    /// What a relist of `index` changed against `before` (its objects in the store before it), as the next delta:
    /// objects new or with another text upserted, objects gone (or now left out for the cap) deleted.
    fn note_changes(&mut self, index: usize, before: HashMap<String, WatchObject>) {
        for (uid, (source, value)) in &self.store {
            if *source == index && before.get(uid) != Some(value) {
                self.deleted.remove(uid);
                self.upserted.insert(uid.clone(), value.clone());
            }
        }
        for uid in before.into_keys() {
            if !self.store.contains_key(&uid) {
                self.upserted.remove(&uid);
                self.deleted.insert(uid);
            }
        }
    }

    /// Whether a running (re)list may keep one more object: the cap counts what every source keeps and what the
    /// running lists have taken so far (namespaces listed side by side share the cap), less what those lists replace.
    fn has_room_while_listing(&self) -> bool {
        let Some(cap) = self.cap else { return true };
        let (mut taken, mut replaced) = (0, 0);
        for (buffer, old) in self.init_buffers.iter().zip(&self.init_old) {
            if let Some(buffer) = buffer {
                taken += buffer.len();
                replaced += old;
            }
        }
        self.store.len().saturating_sub(replaced) + taken < cap
    }

    /// Whether one more object may be kept (always, without a cap).
    fn has_room(&self) -> bool {
        self.cap.is_none_or(|cap| self.store.len() < cap)
    }

    /// Objects listed so far, kept by the store or by a running list.
    fn has_listed_objects(&self) -> bool {
        !self.store.is_empty() || self.init_buffers.iter().flatten().any(|b| !b.is_empty())
    }

    /// Matching objects: those kept and those left out for the cap.
    fn total(&self) -> u64 {
        (self.store.len() + self.dropped.len()) as u64
    }

    /// Notes a `Capped` to send after the current batch when the total changed while a cap is (or was) in force.
    fn note_capped(&mut self) {
        let Some(cap) = self.cap else { return };
        let total = self.total();
        let was_over = self.capped_sent.is_some_and(|sent| sent > cap as u64);
        if self.capped_sent != Some(total) && (total > cap as u64 || was_over) {
            self.capped_sent = Some(total);
            self.capped_pending = Some(total);
        }
    }

    fn fail(&mut self, index: usize, err: watcher::Error) {
        // An expired resourceVersion: the watcher relists by itself, the relist ends in a new snapshot.
        if matches!(&err, watcher::Error::WatchError(status) if status.code == 410) {
            stats::add(&stats::GONE);
            return;
        }
        // A retry of a forbidden namespace failed (403 again, or anything else): it stays out and is tried later;
        // the other namespaces are not disturbed.
        if self.forbidden[index] {
            self.stop_source(index);
            self.schedule_forbidden_retry(index);
            return;
        }
        // Listed, but its watch refused: the user may list the kind and not watch it. Watching again only lists
        // it again and again (a full snapshot each time, every second); it is listed every `POLL_INTERVAL` instead.
        if self.listed[index] && !self.polling[index] && watch_refused(&err) {
            self.start_polling(index);
            return;
        }
        let class = resumed_class(&err);
        let counts = unreachable_or_refused(&err);
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
        // Once data was shown, an error that is not about the request itself (a broken stream, a watch that could
        // not start, a failed relist) is left to the watcher, which resumes from its `resourceVersion` after a pause,
        // unless the errors go on (#342).
        if self.snapshot_sent && !fatal && (!counts || self.tolerate(index)) {
            stats::add(&stats::RESUMED[class]);
            return;
        }
        // Once data was shown, any other error is treated as a lost connection: an API server that is starting up
        // answers 401/403 for a moment.
        if fatal && !self.snapshot_sent {
            self.streams = SelectAll::new();
            self.fatal = Some(err);
        } else {
            if self.snapshot_sent {
                stats::add(&stats::RECONNECT_CAUSES[if fatal { 1 } else { 2 }]);
            }
            self.lose_connection();
        }
    }

    /// Leaves out a namespace that cannot be listed or watched, if other namespaces remain: the watchers of its
    /// sources stop, the others go on, and its objects leave the store (a delta without them follows once
    /// everything left is listed). It is tried again after [`ForbiddenRetry`] pauses. `false` when it is not such
    /// a namespace (all namespaces, or the last one).
    fn forbid(&mut self, index: usize) -> bool {
        let Some(namespace) = self.sources[index].namespace.clone() else {
            return false;
        };
        let same = |source: &Source| source.namespace.as_deref() == Some(namespace.as_str());
        let others = self
            .sources
            .iter()
            .zip(&self.forbidden)
            .any(|(source, forbidden)| !same(source) && !*forbidden);
        if !others {
            return false;
        }
        let now = Instant::now();
        // Once data was shown, the window is told which objects left with it, not sent the rest again.
        let changes_only = self.snapshot_sent && !self.reconnecting;
        for i in 0..self.sources.len() {
            if !same(&self.sources[i]) || self.forbidden[i] {
                continue;
            }
            if changes_only {
                for (uid, (source, _)) in &self.store {
                    if *source == i {
                        self.upserted.remove(uid);
                        self.deleted.insert(uid.clone());
                    }
                }
            }
            self.forbidden[i] = true;
            // Lost again soon after a retry brought it back (its list allowed and refused by turns): the pauses
            // keep growing instead of starting over.
            if self.restored_at[i].is_none_or(|at| now - at >= self.forbidden_retry.max) {
                self.forbidden_attempt[i] = 0;
            }
            self.stop_source(i);
            self.schedule_forbidden_retry(i);
        }
        self.forbidden_pending = true;
        if self.all_listed() {
            self.snapshot_pending = !changes_only;
            self.attempt = 0;
        }
        true
    }

    /// The next retry of a forbidden source, after a pause that doubles with each attempt.
    fn schedule_forbidden_retry(&mut self, index: usize) {
        let attempt = self.forbidden_attempt[index];
        let delay = self
            .forbidden_retry
            .first
            .saturating_mul(1u32 << attempt.min(16))
            .min(self.forbidden_retry.max);
        self.forbidden_attempt[index] = attempt.saturating_add(1);
        self.retry_forbidden_at[index] = Some(Instant::now() + delay);
    }

    /// Checks every forbidden source whose pause is over: may it be listed again?
    fn retry_forbidden(&mut self) {
        let now = Instant::now();
        for index in 0..self.sources.len() {
            if self.retry_forbidden_at[index].is_some_and(|at| at <= now) {
                self.retry_forbidden_at[index] = None;
                self.access_checks
                    .push(self.sources[index].access_check(index));
            }
        }
    }

    /// The answer of an access check. Refused: the source stays out without a word and waits longer. Allowed: its
    /// watcher starts, and the source is back once its list completes.
    fn checked(&mut self, index: usize, allowed: bool) {
        if !self.forbidden[index] {
            return;
        }
        if !allowed {
            self.schedule_forbidden_retry(index);
        } else if self.retry_at.is_some() || self.reconnecting {
            // The others are reconnecting: check it again once they are back.
            self.retry_forbidden_at[index] = Some(Instant::now());
        } else {
            self.start_source(index);
        }
    }

    /// Drops the watchers and schedules a fresh list after a growing pause.
    /// Whether another error of `index` in a row is still left to its watcher: no, once there were
    /// [`TRANSIENT_LIMIT`] over at least [`TRANSIENT_WINDOW`] (an error long after the previous one starts anew).
    fn tolerate(&mut self, index: usize) -> bool {
        let now = Instant::now();
        let run = &mut self.runs[index];
        if run.last.is_some_and(|last| now - last > TRANSIENT_FORGET) {
            *run = TransientRun::default();
        }
        run.count += 1;
        let first = *run.first.get_or_insert(now);
        run.last = Some(now);
        !(run.count >= TRANSIENT_LIMIT && now - first >= TRANSIENT_WINDOW)
    }

    fn lose_connection(&mut self) {
        if self.snapshot_sent {
            stats::add(&stats::RECONNECTS);
        }
        self.streams = SelectAll::new();
        // A retry of a forbidden namespace that was running is tried again as soon as the others are back.
        for index in 0..self.sources.len() {
            if self.forbidden[index] && self.aborts[index].take().is_some() {
                self.init_buffers[index] = None;
                self.retry_forbidden_at[index] = Some(Instant::now());
            }
        }
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
        let update = self.batch();
        match &update {
            Some(
                WatchUpdate::Snapshot { .. }
                | WatchUpdate::SnapshotEnd { .. }
                | WatchUpdate::Delta { .. },
            ) => self.note_capped(),
            Some(_) => {}
            // Nothing else changed, but objects left out for the cap may have come or gone.
            None if self.snapshot_sent && !self.reconnecting => {
                self.note_capped();
                return self
                    .capped_pending
                    .take()
                    .map(|total| WatchUpdate::Capped { total });
            }
            None => {}
        }
        update
    }

    fn batch(&mut self) -> Option<WatchUpdate> {
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
            if let Some(sent) = self.progressive.take().filter(|sent| !sent.is_empty()) {
                // The parts sent so far, completed: what changed or came since, and what went.
                let items = self
                    .store
                    .iter()
                    .filter(|(uid, (_, v))| !sent.get(*uid).is_some_and(|s| s.same(v)))
                    .map(|(_, (_, v))| v.clone())
                    .collect();
                let deleted = sent
                    .into_keys()
                    .filter(|uid| !self.store.contains_key(uid))
                    .collect();
                return Some(WatchUpdate::SnapshotEnd { items, deleted });
            }
            // Pointers to the stored objects, not copies: a deep copy of a large list was several times its size.
            let items = self.store.values().map(|(_, v)| v.clone()).collect();
            return Some(WatchUpdate::Snapshot { items });
        }
        if !self.snapshot_sent {
            return self.part();
        }
        // Changes wait until the post-reconnect snapshot; it includes them.
        if self.reconnecting {
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

    /// A part of a progressive first list: the objects listed (or changed) since the previous part.
    fn part(&mut self) -> Option<WatchUpdate> {
        let sent = self.progressive.as_mut()?;
        let listed = self.store.iter().map(|(uid, (_, v))| (uid, v)).chain(
            self.init_buffers
                .iter()
                .flatten()
                .flatten()
                .map(|(uid, v)| (uid, v)),
        );
        let mut items = Vec::new();
        for (uid, value) in listed {
            if sent.get(uid).is_some_and(|s| s.same(value)) {
                continue;
            }
            sent.insert(uid.clone(), value.clone());
            items.push(value.clone());
        }
        (!items.is_empty()).then_some(WatchUpdate::SnapshotPart { items })
    }

    fn json(&self, obj: DynamicObject) -> Option<WatchObject> {
        // A DynamicObject always serializes; `None` only guards against the impossible.
        to_watch_object(obj, &self.resource).ok()
    }
}

/// An event of a metadata-only watcher as the batcher handles every event: objects with only `metadata`, plus
/// `type` and an empty `release` key for Helm release Secrets (`to_json` then marks their values hidden).
fn metadata_event(
    event: watcher::Event<PartialObjectMeta<DynamicObject>>,
    helm_release: bool,
) -> watcher::Event<DynamicObject> {
    let object = |meta| metadata_object(meta, helm_release);
    match event {
        watcher::Event::Apply(meta) => watcher::Event::Apply(object(meta)),
        watcher::Event::Delete(meta) => watcher::Event::Delete(object(meta)),
        watcher::Event::Init => watcher::Event::Init,
        watcher::Event::InitApply(meta) => watcher::Event::InitApply(object(meta)),
        watcher::Event::InitDone => watcher::Event::InitDone,
    }
}

/// A metadata-only object as a `DynamicObject` (see [`metadata_event`]), without `last-applied-configuration`: that
/// annotation is a copy of the whole object as `kubectl apply` sent it (a CRD's with its OpenAPI schema), which no
/// metadata-only list needs and which made the window's list of CRDs megabytes (#342).
fn metadata_object(meta: PartialObjectMeta<DynamicObject>, helm_release: bool) -> DynamicObject {
    let mut metadata = meta.metadata;
    if let Some(annotations) = metadata.annotations.as_mut() {
        annotations.remove(LAST_APPLIED_ANNOTATION);
    }
    DynamicObject {
        types: None,
        metadata,
        data: if helm_release {
            serde_json::json!({ "type": HELM_RELEASE_TYPE, "data": { "release": "" } })
        } else {
            Value::Object(serde_json::Map::new())
        },
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => futures::future::pending().await,
    }
}

/// The store's key of an object kube handed over, before it is converted: `metadata.uid`, or `namespace/name` for
/// the rare object without one.
fn meta_uid(meta: &kube::api::ObjectMeta) -> String {
    match &meta.uid {
        Some(uid) => uid.clone(),
        None => format!(
            "{}/{}",
            meta.namespace.as_deref().unwrap_or_default(),
            meta.name.as_deref().unwrap_or_default()
        ),
    }
}

/// [`meta_uid`] of an object the watch sent (the tests).
#[cfg(test)]
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
#[path = "watch_scale_tests.rs"]
mod scale_tests;

#[cfg(test)]
#[path = "watch_resume_tests.rs"]
mod resume_tests;

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

    fn names(items: &[WatchObject]) -> Vec<String> {
        let mut names: Vec<String> = items
            .iter()
            .map(|o| {
                let name = &o.to_value()["metadata"]["name"];
                name.as_str().unwrap_or_default().to_owned()
            })
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
            metadata_only: false,
        }
    }

    /// The first snapshot of a fresh watch.
    async fn first_snapshot(
        mgr: &ClusterManager,
        id: &ClusterId,
        spec: WatchSpec,
    ) -> Vec<WatchObject> {
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

    #[test]
    fn shared_items_serialize_exactly_as_plain_values() {
        let pod = serde_json::json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": { "name": "a", "namespace": "default", "uid": "uid-a", "labels": { "app": "x" } },
            "spec": { "containers": [{ "name": "c", "image": "busybox", "ports": [{ "containerPort": 80 }] }] },
            "status": { "phase": "Running", "restartCount": 0, "ready": true, "ratio": 0.5, "none": null }
        });
        let node = serde_json::json!({ "metadata": { "name": "node-1", "uid": "uid-node-1" } });
        let object = |value: &Value| WatchObject::new(value).unwrap();
        let snapshot = WatchUpdate::Snapshot {
            items: vec![object(&pod), object(&node)],
        };
        let delta = WatchUpdate::Delta {
            upserted: vec![object(&pod)],
            deleted: vec!["uid-node-1".into()],
        };
        // The bytes of the old `Vec<Value>` payloads: the tag first, then the fields, each object as it serializes.
        let (pod, node) = (pod.to_string(), node.to_string());
        assert_eq!(
            serde_json::to_string(&snapshot).unwrap(),
            format!(r#"{{"type":"snapshot","items":[{pod},{node}]}}"#)
        );
        assert_eq!(
            serde_json::to_string(&delta).unwrap(),
            format!(r#"{{"type":"delta","upserted":[{pod}],"deleted":["uid-node-1"]}}"#)
        );
        for update in [snapshot, delta] {
            let json = serde_json::to_string(&update).unwrap();
            assert_eq!(serde_json::from_str::<WatchUpdate>(&json).unwrap(), update);
        }
    }

    #[tokio::test]
    async fn a_snapshot_shares_the_stored_objects_instead_of_copying_them() {
        let api = fake_api(Behaviour::default()).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let mut updates = Box::pin(watch(&mgr, &id, spec("", "Pod", None)).await.unwrap());
        let items = match tokio::time::timeout(Duration::from_secs(5), updates.next()).await {
            Ok(Some(WatchUpdate::Snapshot { items })) => items,
            other => panic!("expected a snapshot, got {other:?}"),
        };
        assert_eq!(names(&items), ["a"]);
        // The running watch keeps the object in its store: the snapshot holds a second pointer to it, not a copy.
        assert_eq!(items[0].holders(), 2);
        drop(updates);
        assert_eq!(items[0].holders(), 1);
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

    /// A Helm release Secret and an ordinary one, as the fake server lists them: always whole, whatever the client
    /// asks for, but filtered by a `type=` / `type!=` field selector like a real API server.
    const HELM_SECRET: &str = r#"{"metadata":{"name":"sh.helm.release.v1.web.v1","namespace":"apps","uid":"uid-web-1","resourceVersion":"1","labels":{"owner":"helm"}},"type":"helm.sh/release.v1","data":{"release":"eA=="}}"#;
    const OPAQUE_SECRET: &str = r#"{"metadata":{"name":"db","namespace":"apps","uid":"uid-db","resourceVersion":"1"},"type":"Opaque","data":{"password":"cA==","user":"dQ=="}}"#;
    const HELM_RELEASE_TYPE: &str = "helm.sh/release.v1";

    /// `%XX` and `+` decoded.
    fn decoded(query: &str) -> String {
        let bytes = query.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            match bytes[i] {
                b'%' if i + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                    out.push(u8::from_str_radix(hex, 16).unwrap_or(b'?'));
                    i += 3;
                }
                b'+' => {
                    out.push(b' ');
                    i += 1;
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    /// The `fieldSelector` of a request, decoded; empty if none.
    fn field_selector(req: &Request) -> String {
        decoded(&req.query)
            .split('&')
            .find_map(|pair| pair.strip_prefix("fieldSelector="))
            .unwrap_or_default()
            .to_owned()
    }

    fn secrets_server() -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        |req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/apps/secrets" if req.query.contains("watch=") => Reply::stream(""),
            "/api/v1/namespaces/apps/secrets" => {
                let selector = field_selector(req);
                let items = if selector.contains(&format!("type!={HELM_RELEASE_TYPE}")) {
                    OPAQUE_SECRET.to_owned()
                } else if selector.contains(&format!("type={HELM_RELEASE_TYPE}")) {
                    HELM_SECRET.to_owned()
                } else {
                    format!("{HELM_SECRET},{OPAQUE_SECRET}")
                };
                Reply::json(
                    200,
                    format!(
                        r#"{{"apiVersion":"v1","kind":"SecretList","metadata":{{"resourceVersion":"1"}},"items":[{items}]}}"#
                    ),
                )
            }
            _ => Reply::not_found(),
        }
    }

    /// Whether the Secret list of `apps` asked for metadata only (`Accept: …;as=PartialObjectMetadataList;…`).
    fn asked_for_metadata(api: &FakeApi) -> Vec<bool> {
        api.requests()
            .iter()
            .filter(|r| r.path == "/api/v1/namespaces/apps/secrets")
            .map(|r| r.header("accept").contains("as=PartialObjectMetadata"))
            .collect()
    }

    #[tokio::test]
    async fn a_metadata_only_watch_asks_for_metadata_and_gives_objects_without_their_data() {
        let api = FakeApi::start(secrets_server()).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = WatchSpec {
            metadata_only: true,
            ..spec("", "Secret", Some(&["apps"]))
        };
        let items = first_snapshot(&mgr, &id, spec).await;
        assert_eq!(names(&items), ["db", "sh.helm.release.v1.web.v1"]);
        let secret = by_name(&items, "sh.helm.release.v1.web.v1");
        let secret = secret.as_object().unwrap();
        assert_eq!(
            (secret["apiVersion"].as_str(), secret["kind"].as_str()),
            (Some("v1"), Some("Secret"))
        );
        assert_eq!(secret["metadata"]["labels"]["owner"], "helm");
        assert!(
            !secret.contains_key("data") && !secret.contains_key("type"),
            "metadata only: {secret:?}"
        );
        let asked = asked_for_metadata(&api);
        assert!(
            !asked.is_empty() && asked.iter().all(|m| *m),
            "the list and the watch ask for metadata only: {asked:?}"
        );
    }

    #[tokio::test]
    async fn a_metadata_only_watch_leaves_out_the_last_applied_configuration() {
        // `kubectl apply` keeps a copy of the whole object in this annotation (a CRD's with its OpenAPI schema): a
        // metadata-only list of CRDs carried megabytes of it (#342). Other annotations stay.
        let api = FakeApi::start(|req: &Request| match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1/namespaces/apps/configmaps" if req.query.contains("watch=") => {
                Reply::stream("")
            }
            "/api/v1/namespaces/apps/configmaps" => Reply::json(
                200,
                r#"{"apiVersion":"v1","kind":"ConfigMapList","metadata":{"resourceVersion":"1"},"items":[{"metadata":{"name":"cm","namespace":"apps","uid":"uid-cm","resourceVersion":"1","annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"apiVersion\":\"v1\",\"kind\":\"ConfigMap\"}","owner":"team-a"}}}]}"#,
            ),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = WatchSpec {
            metadata_only: true,
            ..spec("", "ConfigMap", Some(&["apps"]))
        };
        let items = first_snapshot(&mgr, &id, spec).await;
        let cm = by_name(&items, "cm");
        assert_eq!(
            cm["metadata"]["annotations"],
            serde_json::json!({ "owner": "team-a" }),
            "{cm}"
        );
    }

    fn by_name(items: &[WatchObject], name: &str) -> Value {
        items
            .iter()
            .map(WatchObject::to_value)
            .find(|o| o["metadata"]["name"] == name)
            .unwrap_or_else(|| panic!("no {name} in {items:?}"))
    }

    #[tokio::test]
    async fn a_secret_watch_gets_helm_releases_as_metadata_and_other_secrets_whole() {
        let api = FakeApi::start(secrets_server()).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let items = first_snapshot(&mgr, &id, spec("", "Secret", Some(&["apps"]))).await;
        assert_eq!(names(&items), ["db", "sh.helm.release.v1.web.v1"]);

        // An ordinary Secret: whole, values hidden, keys kept.
        let db = by_name(&items, "db");
        assert_eq!(db["type"], "Opaque");
        assert_eq!(db["data"], serde_json::json!({"password": "", "user": ""}));
        assert_eq!(
            db["metadata"]["annotations"][super::super::get::VALUES_HIDDEN_ANNOTATION],
            "true"
        );

        // A Helm release: the row looks as before (type, one `release` key), from metadata alone.
        let release = by_name(&items, "sh.helm.release.v1.web.v1");
        assert_eq!(release["type"], HELM_RELEASE_TYPE);
        assert_eq!(release["data"], serde_json::json!({"release": ""}));
        assert_eq!(release["metadata"]["labels"]["owner"], "helm");
        assert_eq!(
            release["metadata"]["annotations"][super::super::get::VALUES_HIDDEN_ANNOTATION],
            "true"
        );
        assert_eq!(
            (release["apiVersion"].as_str(), release["kind"].as_str()),
            (Some("v1"), Some("Secret"))
        );

        // The data of release Secrets is never asked for: every request that may return them is metadata-only.
        let requests: Vec<Request> = api
            .requests()
            .into_iter()
            .filter(|r| r.path == "/api/v1/namespaces/apps/secrets")
            .collect();
        assert!(!requests.is_empty());
        for req in &requests {
            let whole = !req.header("accept").contains("as=PartialObjectMetadata");
            if whole {
                assert!(
                    field_selector(req).contains(&format!("type!={HELM_RELEASE_TYPE}")),
                    "a whole-object request that would return release payloads: {:?} {:?}",
                    req.line(),
                    decoded(&req.query)
                );
            } else {
                assert!(
                    field_selector(req).contains(&format!("type={HELM_RELEASE_TYPE}")),
                    "a metadata request for other Secrets: {:?}",
                    decoded(&req.query)
                );
            }
        }
    }

    #[tokio::test]
    async fn a_secret_watch_keeps_the_callers_field_selector_on_both_halves() {
        let api = FakeApi::start(secrets_server()).await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = WatchSpec {
            field_selector: Some("metadata.name!=other".into()),
            ..spec("", "Secret", Some(&["apps"]))
        };
        first_snapshot(&mgr, &id, spec).await;
        let selectors: Vec<String> = api
            .requests()
            .iter()
            .filter(|r| r.path == "/api/v1/namespaces/apps/secrets")
            .map(field_selector)
            .collect();
        assert!(!selectors.is_empty());
        assert!(
            selectors
                .iter()
                .all(|s| s.contains("metadata.name!=other") && s.contains("type")),
            "{selectors:?}"
        );
    }

    #[tokio::test]
    async fn a_metadata_watch_refused_with_an_indented_status_is_read_as_refused() {
        // Like a real API server: a refused watch with kube's metadata `Accept` (no fallback) gets an indented
        // `Status`, which kube cannot read as watch events. Read as the 403 it is, the namespace (which may be
        // listed) is listed again instead of watched; read as a broken stream, it would only be resumed.
        let indented: String =
            serde_json::to_string_pretty(&serde_json::from_str::<Value>(FORBIDDEN).unwrap())
                .unwrap();
        let api = FakeApi::start(move |req: &Request| {
            let ns = req
                .path
                .strip_prefix("/api/v1/namespaces/")
                .and_then(|rest| rest.strip_suffix("/secrets"));
            match (req.path.as_str(), ns) {
                ("/api", _) => Reply::json(200, API_VERSIONS),
                (_, Some("b")) if req.query.contains("watch=") => {
                    if req.header("accept").contains(',') {
                        Reply::json(403, FORBIDDEN)
                    } else {
                        Reply::json(403, indented.clone())
                    }
                }
                (_, Some(_)) if req.query.contains("watch=") => Reply::stream(""),
                (_, Some(ns)) => Reply::json(
                    200,
                    format!(
                        r#"{{"apiVersion":"v1","kind":"SecretList","metadata":{{"resourceVersion":"1"}},"items":[{{"metadata":{{"name":"s-{ns}","namespace":"{ns}","uid":"uid-{ns}","resourceVersion":"1"}}}}]}}"#
                    ),
                ),
                _ => Reply::not_found(),
            }
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let spec = WatchSpec {
            metadata_only: true,
            ..spec("", "Secret", Some(&["a", "b"]))
        };
        let updates = watch(&mgr, &id, spec).await.unwrap();
        let (forbidden, states) =
            shown_states(updates, Duration::from_millis(1500), |_, _| false).await;
        assert!(forbidden.is_empty(), "{forbidden:?}");
        assert_eq!(names(states.last().unwrap()), ["s-a", "s-b"]);
        let lists_in_b = api
            .requests()
            .iter()
            .filter(|r| r.path == "/api/v1/namespaces/b/secrets" && !r.query.contains("watch="))
            .count();
        assert!(lists_in_b >= 2, "listed again: {lists_in_b}");
    }

    /// ConfigMaps in `a` and `b`; in `b` the first `refused_lists` lists and the first `refused_watches` watches
    /// answer 403 (an access check's requests count too).
    fn flaky_namespace_server(
        refused_lists: usize,
        refused_watches: usize,
    ) -> impl Fn(&Request) -> Reply + Send + Sync + 'static {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (lists_in_b, watches_in_b) = (AtomicUsize::new(0), AtomicUsize::new(0));
        move |req: &Request| {
            let ns = req
                .path
                .strip_prefix("/api/v1/namespaces/")
                .and_then(|rest| rest.strip_suffix("/configmaps"));
            let watching = req.query.contains("watch=");
            match (req.path.as_str(), ns) {
                ("/api", _) => Reply::json(200, API_VERSIONS),
                (_, Some(ns)) => {
                    let refused = ns == "b"
                        && if watching {
                            watches_in_b.fetch_add(1, Ordering::SeqCst) < refused_watches
                        } else {
                            lists_in_b.fetch_add(1, Ordering::SeqCst) < refused_lists
                        };
                    if refused {
                        Reply::json(403, FORBIDDEN)
                    } else if watching {
                        Reply::stream("")
                    } else {
                        Reply::json(
                            200,
                            format!(
                                r#"{{"apiVersion":"v1","kind":"ConfigMapList","metadata":{{"resourceVersion":"1"}},"items":[{{"metadata":{{"name":"cm-{ns}","namespace":"{ns}","uid":"uid-{ns}","resourceVersion":"1"}}}}]}}"#
                            ),
                        )
                    }
                }
                _ => Reply::not_found(),
            }
        }
    }

    /// Short pauses for the retries of a forbidden namespace.
    const SHORT_RETRY: ForbiddenRetry = ForbiddenRetry {
        first: Duration::from_millis(50),
        max: Duration::from_millis(200),
    };

    /// Every `Forbidden` and every state the window shows (snapshots and deltas applied, each state its objects)
    /// of `updates`, until `done(forbidden, shown)` or `wait` is over.
    async fn shown_states(
        updates: impl futures::Stream<Item = WatchUpdate>,
        wait: Duration,
        done: impl Fn(&[Vec<String>], &[WatchObject]) -> bool,
    ) -> (Vec<Vec<String>>, Vec<Vec<WatchObject>>) {
        let mut updates = Box::pin(updates);
        let mut shown: std::collections::BTreeMap<String, WatchObject> = Default::default();
        let (mut forbidden, mut states): (Vec<Vec<String>>, Vec<Vec<WatchObject>>) =
            (Vec::new(), Vec::new());
        let uid = |o: &WatchObject| {
            let v: Value = serde_json::from_str(o.json()).unwrap();
            v["metadata"]["uid"].as_str().unwrap().to_owned()
        };
        let deadline = Instant::now() + wait;
        while !done(&forbidden, states.last().map_or(&[], |s| s.as_slice())) {
            let left = deadline.saturating_duration_since(Instant::now());
            match tokio::time::timeout(left, updates.next()).await {
                Ok(Some(WatchUpdate::Snapshot { items })) => {
                    shown = items.into_iter().map(|o| (uid(&o), o)).collect();
                }
                Ok(Some(WatchUpdate::Delta { upserted, deleted })) => {
                    for o in upserted {
                        shown.insert(uid(&o), o);
                    }
                    for gone in deleted {
                        shown.remove(&gone);
                    }
                }
                Ok(Some(WatchUpdate::Forbidden { namespaces })) => {
                    forbidden.push(namespaces);
                    continue;
                }
                Err(_) => break,
                other => panic!("unexpected {other:?} (forbidden {forbidden:?})"),
            }
            states.push(shown.values().cloned().collect());
        }
        (forbidden, states)
    }

    /// [`shown_states`] of a ConfigMap watch of `a` and `b`.
    async fn watch_flaky_namespace(
        api: &FakeApi,
        wait: Duration,
        done: impl Fn(&[Vec<String>], &[WatchObject]) -> bool,
    ) -> (Vec<Vec<String>>, Vec<Vec<WatchObject>>) {
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let updates = watch_with(
            &mgr,
            &id,
            spec("", "ConfigMap", Some(&["a", "b"])),
            WatchOptions::default(),
            SHORT_RETRY,
        )
        .await
        .unwrap();
        shown_states(updates, wait, done).await
    }

    fn requests_in_b(api: &FakeApi, watches: bool) -> usize {
        api.requests()
            .iter()
            .filter(|r| {
                r.path == "/api/v1/namespaces/b/configmaps" && r.query.contains("watch=") == watches
            })
            .count()
    }

    #[tokio::test]
    async fn a_namespace_that_answered_403_comes_back_when_access_returns() {
        let api = FakeApi::start(flaky_namespace_server(2, 0)).await;
        let (forbidden, snapshots) =
            watch_flaky_namespace(&api, Duration::from_secs(5), |forbidden, items| {
                forbidden.last().is_some_and(Vec::is_empty) && names(items) == ["cm-a", "cm-b"]
            })
            .await;
        assert_eq!(forbidden, [vec!["b".to_owned()], vec![]], "{snapshots:?}");
        assert_eq!(names(snapshots.last().unwrap()), ["cm-a", "cm-b"]);
        // The watch's list, a check refused at its list, a check let through, the list that brought it back.
        assert_eq!(requests_in_b(&api, false), 4);
    }

    #[tokio::test]
    async fn a_namespace_that_can_be_listed_but_not_watched_is_listed_again_instead() {
        // The right to list ConfigMaps in `b` but not to watch them: before #342 the namespace was left out (or,
        // as the only one, its watch reconnected and sent a full snapshot every second).
        let api = FakeApi::start(flaky_namespace_server(0, usize::MAX)).await;
        let (forbidden, states) =
            watch_flaky_namespace(&api, Duration::from_millis(1800), |_, _| false).await;
        assert!(forbidden.is_empty(), "{forbidden:?}");
        // Only the first list was a snapshot: the lists of `b` that followed changed nothing, so nothing was sent.
        assert_eq!(states.len(), 1, "{states:?}");
        assert_eq!(names(&states[0]), ["cm-a", "cm-b"]);
        assert_eq!(
            requests_in_b(&api, true),
            1,
            "the refused watch is not tried again"
        );
        assert!(
            requests_in_b(&api, false) >= 3,
            "listed every POLL_INTERVAL: {} lists",
            requests_in_b(&api, false)
        );
    }

    #[tokio::test]
    async fn a_namespace_whose_list_is_refused_and_its_watch_too_stays_out() {
        // Neither listed nor watched: left out and checked again, as before; its access check never lets it in.
        let api = FakeApi::start(flaky_namespace_server(usize::MAX, usize::MAX)).await;
        let (forbidden, states) =
            watch_flaky_namespace(&api, Duration::from_millis(1500), |_, _| false).await;
        assert_eq!(forbidden, [vec!["b".to_owned()]], "{states:?}");
        assert!(
            states.iter().all(|items| names(items) == ["cm-a"]),
            "{states:?}"
        );
    }

    #[tokio::test]
    async fn a_namespace_that_can_be_listed_but_not_watched_keeps_the_others_streaming() {
        let api = fake_api(Behaviour {
            no_watch_in: Some("b"),
            ..Behaviour::default()
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let updates = watch(&mgr, &id, spec("", "Secret", Some(&["a", "b"])))
            .await
            .unwrap();
        let (forbidden, states) =
            shown_states(updates, Duration::from_millis(1500), |_, _| false).await;
        assert!(forbidden.is_empty(), "{forbidden:?}");
        assert_eq!(names(states.last().unwrap()), ["s-a", "s-b"]);
    }
}
