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

const WATCH_FORBIDDEN: &str = r#"{"kind":"Status","apiVersion":"v1","status":"Failure","message":"cannot watch pods","reason":"Forbidden","code":403}"#;

/// A fake API server whose `n`-th pod list (from 0) has `pods(n)` pods; watches answer `watch`.
async fn changing_api(
    lists: Arc<AtomicUsize>,
    pods: impl Fn(usize) -> usize + Send + Sync + 'static,
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
            "/api/v1/pods" => pod_page(pods(lists.fetch_add(1, Ordering::SeqCst)), &req.query),
            _ => Reply::not_found(),
        }
    })
    .await
}

/// (upserted, deleted) of each delta.
fn deltas(updates: &[WatchUpdate]) -> Vec<(usize, usize)> {
    updates
        .iter()
        .filter_map(|u| match u {
            WatchUpdate::Delta { upserted, deleted } => Some((upserted.len(), deleted.len())),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_kind_that_can_be_listed_but_not_watched_is_listed_again_and_only_changes_are_sent() {
    // The right to list pods but not to watch them (#342): before, every refused watch was a lost connection, so
    // the pods were listed again and a full snapshot went to the window every second, and nothing counted as
    // resumed.
    let lists = Arc::new(AtomicUsize::new(0));
    let watches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&watches);
    // 3 pods, then a 4th comes, then two go.
    let api = changing_api(
        Arc::clone(&lists),
        |n| match n {
            0 | 1 => 3,
            2 | 3 => 4,
            _ => 2,
        },
        move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Reply::json(403, WATCH_FORBIDDEN)
        },
    )
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let before = watch_stats();
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    let seen = updates_for(watch, POLL_INTERVAL * 5 + POLL_INTERVAL / 2).await;
    assert!(
        !kinds(&seen).contains(&"reconnecting") && !kinds(&seen).contains(&"snapshot"),
        "{seen:?}"
    );
    assert_eq!(deltas(&seen), [(1, 0), (0, 2)], "{seen:?}");
    assert_eq!(
        watches.load(Ordering::SeqCst),
        1,
        "the refused watch is not tried again"
    );
    assert!(lists.load(Ordering::SeqCst) >= 5);
    let after = watch_stats();
    assert!(after.polled > before.polled);
    assert!(after.polls >= before.polls + 4);
}

#[tokio::test]
async fn a_relist_with_the_connection_up_sends_only_what_changed() {
    // An expired resourceVersion: kube's watcher lists again by itself. The window gets the one new pod, not the
    // whole list again.
    let lists = Arc::new(AtomicUsize::new(0));
    let watches = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&watches);
    let api = changing_api(
        Arc::clone(&lists),
        |n| if n == 0 { 3 } else { 4 },
        move |_| {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                Reply::stream(
                    r#"{"type":"ERROR","object":{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Expired","message":"too old resource version","code":410}}"#
                        .to_owned()
                        + "\n",
                )
            } else {
                Reply::stream(String::new())
            }
        },
    )
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    let seen = updates_for(watch, Duration::from_secs(3)).await;
    assert_eq!(kinds(&seen), vec!["delta"], "{seen:?}");
    assert_eq!(deltas(&seen), [(1, 0)]);
    assert_eq!(lists.load(Ordering::SeqCst), 2, "listed again once");
}
