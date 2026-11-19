//! A watch whose watches break once data was shown (#342): a proxy such as Teleport's ending long requests made every
//! break a lost connection, so the whole kind was listed again and a full snapshot sent every second or two. Now the
//! watcher resumes from its `resourceVersion` after a growing pause, with no list; only errors that go on are a lost
//! connection.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::StreamExt;
use tokio::time::Instant;

use super::scale_tests::{pod_page, pods_spec};
use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]}]}"#;
const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;
const SERVER_ERROR: &str =
    r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"proxy error","code":500}"#;

/// A fake API server with 3 pods whose watches answer `watch`; the lists are counted in `lists`.
async fn api(
    lists: Arc<AtomicUsize>,
    watch: impl Fn(&Request) -> Reply + Send + Sync + 'static,
) -> FakeApi {
    FakeApi::start(move |req: &Request| {
        if req.query.contains("watch=") {
            return watch(req);
        }
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE_RESOURCES),
            "/apis" => Reply::json(200, API_GROUPS),
            "/api/v1/pods" => {
                lists.fetch_add(1, Ordering::SeqCst);
                pod_page(3, &req.query)
            }
            _ => Reply::not_found(),
        }
    })
    .await
}

/// The updates of `watch` for `wait`, after its first snapshot.
async fn updates_for(
    watch: impl futures::Stream<Item = WatchUpdate>,
    wait: Duration,
) -> Vec<WatchUpdate> {
    let mut watch = Box::pin(watch);
    let first = tokio::time::timeout(Duration::from_secs(5), watch.next())
        .await
        .unwrap();
    assert!(
        matches!(first, Some(WatchUpdate::Snapshot { .. })),
        "{first:?}"
    );
    let mut seen = Vec::new();
    let until = Instant::now() + wait;
    while let Ok(Some(update)) = tokio::time::timeout_at(until, watch.next()).await {
        seen.push(update);
    }
    seen
}

fn kinds(updates: &[WatchUpdate]) -> Vec<&'static str> {
    updates
        .iter()
        .map(|u| match u {
            WatchUpdate::Snapshot { .. } => "snapshot",
            WatchUpdate::Reconnecting => "reconnecting",
            WatchUpdate::Delta { .. } => "delta",
            _ => "other",
        })
        .collect()
}

#[tokio::test]
async fn a_watch_that_cannot_start_again_is_retried_without_listing_again() {
    let lists = Arc::new(AtomicUsize::new(0));
    let watches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&watches);
    let api = api(Arc::clone(&lists), move |_| {
        // The first watch opens and ends at once (as a proxy cutting it); every later one is refused with a 500.
        if counted.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::json(200, "")
        } else {
            Reply::json(500, SERVER_ERROR)
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let before = watch_stats();
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    let seen = updates_for(watch, Duration::from_secs(3)).await;
    // Before #342 every refused watch was a lost connection: "Reconnecting", the pods listed again, a snapshot.
    assert_eq!(kinds(&seen), Vec::<&str>::new());
    assert_eq!(lists.load(Ordering::SeqCst), 1, "listed again");
    // The watcher tried again after a growing pause, not in a tight loop.
    let tried = watches.load(Ordering::SeqCst);
    assert!((2..=6).contains(&tried), "{tried} watch requests in 3 s");
    // Counted for the log as errors the watcher resumed (kube tells a refused watch as a broken or unstarted one).
    let resumed = |s: WatchStats| {
        s.resumed_broken + s.resumed_start + s.resumed_event + s.resumed_list + s.resumed_other
    };
    assert!(resumed(watch_stats()) > resumed(before));
}

#[tokio::test]
async fn a_watch_that_breaks_is_resumed_from_its_resource_version() {
    let lists = Arc::new(AtomicUsize::new(0));
    let watches: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let seen_watches = Arc::clone(&watches);
    let api = api(Arc::clone(&lists), move |req| {
        let mut asked = seen_watches.lock().unwrap();
        asked.push(req.query.clone());
        if asked.len() == 1 {
            // A pod comes, a broken line follows, and the stream ends (as a proxy cutting it).
            Reply::json(
                200,
                concat!(
                    r#"{"type":"ADDED","object":{"apiVersion":"v1","kind":"Pod","metadata":{"name":"new","namespace":"default","uid":"uid-new","resourceVersion":"7"}}}"#,
                    "\n{\"type\":\"MODIF\n"
                ),
            )
        } else {
            Reply::stream(String::new())
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    let seen = updates_for(watch, Duration::from_secs(3)).await;
    assert_eq!(kinds(&seen), vec!["delta"], "{seen:?}");
    assert_eq!(lists.load(Ordering::SeqCst), 1, "listed again");
    let asked = watches.lock().unwrap().clone();
    assert!(asked.len() >= 2, "{asked:?}");
    // The second watch starts where the first one got to.
    assert!(asked[1].contains("resourceVersion=7"), "{asked:?}");
}

#[tokio::test]
async fn errors_that_go_on_are_a_lost_connection_after_all() {
    let lists = Arc::new(AtomicUsize::new(0));
    let watches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&watches);
    let api = api(Arc::clone(&lists), move |_| {
        if counted.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::json(200, "")
        } else {
            Reply::json(500, SERVER_ERROR)
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    // TRANSIENT_WINDOW is shorter in tests; the backoff's growing pauses reach the 4th error in a few seconds.
    let seen = updates_for(watch, TRANSIENT_WINDOW + Duration::from_secs(12)).await;
    let kinds = kinds(&seen);
    assert_eq!(kinds.first(), Some(&"reconnecting"), "{kinds:?}");
    assert!(kinds.contains(&"snapshot"), "{kinds:?}");
    assert!(lists.load(Ordering::SeqCst) >= 2);
}
