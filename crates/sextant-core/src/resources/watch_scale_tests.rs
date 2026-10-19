//! Scale of a watch (#157): a fake API server that lists `N` realistic pods in pages of `limit` (with `continue`
//! tokens, as the API server does), and measurements of how long the first rows and the whole list take and how much
//! memory the watch keeps per object. The measurements are `#[ignore]`d (run them by hand:
//! `cargo test -p sextant-core --lib scale_ -- --ignored --nocapture --test-threads=1`); the behaviour tests run
//! always.

use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::Value;
use tokio::time::Instant;

use super::*;
use crate::fake_api::{FakeApi, Reply, Request, connected_to};
use crate::resources::KindRef;
use crate::resources::{ObjectCount, count, watch_with_options};

const API_VERSIONS: &str =
    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#;
const CORE_RESOURCES: &str = r#"{"kind":"APIResourceList","groupVersion":"v1","resources":[{"name":"pods","singularName":"pod","namespaced":true,"kind":"Pod","verbs":["get","list","watch"]}]}"#;
const API_GROUPS: &str = r#"{"kind":"APIGroupList","apiVersion":"v1","groups":[]}"#;

/// One pod as a real cluster lists it (managedFields left out, the core strips them anyway): about 2.5 KB of JSON.
pub(super) fn pod_json(i: usize) -> String {
    let ns = format!("team-{}", i % 50);
    format!(
        r#"{{"apiVersion":"v1","kind":"Pod","metadata":{{"name":"web-{i}-7f9c6d5b8-x{i:05}","generateName":"web-{i}-7f9c6d5b8-","namespace":"{ns}","uid":"00000000-0000-4000-8000-{i:012}","resourceVersion":"{rv}","creationTimestamp":"2026-10-01T10:00:00Z","labels":{{"app":"web-{app}","pod-template-hash":"7f9c6d5b8","tier":"frontend"}},"annotations":{{"kubectl.kubernetes.io/restartedAt":"2026-10-01T09:59:00Z","prometheus.io/scrape":"true"}},"ownerReferences":[{{"apiVersion":"apps/v1","kind":"ReplicaSet","name":"web-{i}-7f9c6d5b8","uid":"11111111-0000-4000-8000-{i:012}","controller":true,"blockOwnerDeletion":true}}]}},"spec":{{"containers":[{{"name":"web","image":"registry.example.com/web:1.2.3","ports":[{{"containerPort":8080,"protocol":"TCP"}}],"env":[{{"name":"MODE","value":"production"}},{{"name":"POD_NAME","valueFrom":{{"fieldRef":{{"apiVersion":"v1","fieldPath":"metadata.name"}}}}}}],"resources":{{"requests":{{"cpu":"100m","memory":"128Mi"}},"limits":{{"memory":"256Mi"}}}},"volumeMounts":[{{"name":"kube-api-access","mountPath":"/var/run/secrets/kubernetes.io/serviceaccount","readOnly":true}}],"terminationMessagePath":"/dev/termination-log","terminationMessagePolicy":"File","imagePullPolicy":"IfNotPresent"}}],"restartPolicy":"Always","terminationGracePeriodSeconds":30,"dnsPolicy":"ClusterFirst","serviceAccountName":"default","nodeName":"node-{node}","securityContext":{{}},"schedulerName":"default-scheduler","tolerations":[{{"key":"node.kubernetes.io/not-ready","operator":"Exists","effect":"NoExecute","tolerationSeconds":300}}],"volumes":[{{"name":"kube-api-access","projected":{{"sources":[{{"serviceAccountToken":{{"expirationSeconds":3607,"path":"token"}}}}],"defaultMode":420}}}}]}},"status":{{"phase":"Running","conditions":[{{"type":"Initialized","status":"True","lastTransitionTime":"2026-10-01T10:00:00Z"}},{{"type":"Ready","status":"True","lastTransitionTime":"2026-10-01T10:00:05Z"}},{{"type":"ContainersReady","status":"True","lastTransitionTime":"2026-10-01T10:00:05Z"}},{{"type":"PodScheduled","status":"True","lastTransitionTime":"2026-10-01T10:00:00Z"}}],"hostIP":"10.0.0.{node}","podIP":"10.244.{node}.{ip}","startTime":"2026-10-01T10:00:00Z","containerStatuses":[{{"name":"web","state":{{"running":{{"startedAt":"2026-10-01T10:00:04Z"}}}},"ready":true,"restartCount":0,"image":"registry.example.com/web:1.2.3","imageID":"registry.example.com/web@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","containerID":"containerd://{i:064}","started":true}}],"qosClass":"Burstable"}}}}"#,
        rv = 1000 + i,
        app = i % 200,
        node = i % 250,
        ip = i % 250,
    )
}

/// The value of `name` in a query string.
fn query_value<'a>(query: &'a str, name: &str) -> Option<&'a str> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

/// A pod list page: pods `from..from+limit` of `total`, with a `continue` token and `remainingItemCount` while more
/// follow (the API server sends both). A metadata-only list (`as=PartialObjectMetadata`) gets the same pods; kube
/// reads their metadata.
pub(super) fn pod_page(total: usize, query: &str) -> Reply {
    pod_page_from(0, total, query)
}

/// [`pod_page`] of pods `offset..offset + total` (another namespace's pods).
fn pod_page_from(offset: usize, total: usize, query: &str) -> Reply {
    // As the API server: no `remainingItemCount` for a list with a label selector.
    let remaining = !query.contains("labelSelector");
    let from: usize = query_value(query, "continue")
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let limit: usize = query_value(query, "limit")
        .and_then(|l| l.parse().ok())
        .unwrap_or(total)
        .max(1);
    let to = (from + limit).min(total);
    let items: Vec<String> = (offset + from..offset + to).map(pod_json).collect();
    let more = if to < total && remaining {
        format!(r#","continue":"{to}","remainingItemCount":{}"#, total - to)
    } else if to < total {
        format!(r#","continue":"{to}""#)
    } else {
        String::new()
    };
    Reply::json(
        200,
        format!(
            r#"{{"apiVersion":"v1","kind":"PodList","metadata":{{"resourceVersion":"5000"{more}}},"items":[{}]}}"#,
            items.join(",")
        ),
    )
}

/// A fake API server with `total` pods (listed in pages) whose watches stay open and quiet. Each page waits
/// `page_delay`, as a busy API server would.
pub(super) async fn pods_api(total: usize, page_delay: Duration) -> FakeApi {
    FakeApi::start(move |req: &Request| {
        if req.query.contains("watch=") {
            return Reply::stream(String::new());
        }
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE_RESOURCES),
            "/apis" => Reply::json(200, API_GROUPS),
            "/api/v1/pods" => pod_page(total, &req.query).after(page_delay),
            path if path.starts_with("/api/v1/namespaces/") && path.ends_with("/pods") => {
                pod_page(total, &req.query).after(page_delay)
            }
            _ => Reply::not_found(),
        }
    })
    .await
}

pub(super) fn pods_spec() -> WatchSpec {
    WatchSpec {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespaces: None,
        label_selector: None,
        field_selector: None,
        metadata_only: false,
    }
}

/// Resident memory of this process in KiB (Linux; 0 elsewhere).
fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1))
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or(0)
}

#[test]
fn a_pod_of_the_scale_fixture_is_valid_json_of_a_realistic_size() {
    let pod: Value = serde_json::from_str(&pod_json(7)).unwrap();
    assert_eq!(pod["metadata"]["namespace"], "team-7");
    let size = pod_json(12345).len();
    assert!((2000..4000).contains(&size), "{size} bytes");
}

/// What one measured watch did: when the first rows came, when the whole list was in, and the memory it kept.
#[derive(Debug)]
struct Measured {
    first_rows: Duration,
    first_rows_count: usize,
    complete: Duration,
    objects: usize,
    rss_per_object_bytes: u64,
    /// Estimated heap the sent (and stored: the same `Arc`s) objects take, in bytes.
    kept_bytes: usize,
}

/// Watches `total` pods (pages of 500, `page_delay` each) until the list is complete; the stream and what it sent
/// are kept while the memory is read.
async fn measure(total: usize, page_delay: Duration, open: Open) -> Measured {
    let api = pods_api(total, page_delay).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let before = rss_kib();
    let started = Instant::now();
    let mut updates = Box::pin(open(mgr.clone(), id.clone()).await);
    let mut kept: Vec<WatchUpdate> = Vec::new();
    let (mut first_rows, mut first_rows_count, mut objects) = (None, 0, 0);
    let complete = loop {
        let update = tokio::time::timeout(Duration::from_secs(120), updates.next())
            .await
            .expect("the list never completed")
            .expect("the stream ended");
        let (count, done) = rows_of(&update);
        objects += count;
        if count > 0 && first_rows.is_none() {
            first_rows = Some(started.elapsed());
            first_rows_count = count;
        }
        kept.push(update);
        if done {
            break started.elapsed();
        }
    };
    let after = rss_kib();
    let measured = Measured {
        first_rows: first_rows.unwrap_or(complete),
        first_rows_count,
        complete,
        objects,
        rss_per_object_bytes: after.saturating_sub(before) * 1024 / total.max(1) as u64,
        kept_bytes: kept.iter().map(update_heap).sum(),
    };
    drop(kept);
    measured
}

type Open =
    fn(
        ClusterManager,
        ClusterId,
    )
        -> futures::future::BoxFuture<'static, futures::stream::BoxStream<'static, WatchUpdate>>;

/// Objects an update brings, and whether the list is complete with it.
fn rows_of(update: &WatchUpdate) -> (usize, bool) {
    match update {
        WatchUpdate::Snapshot { items } => (items.len(), true),
        WatchUpdate::SnapshotPart { items } => (items.len(), false),
        WatchUpdate::SnapshotEnd { items, .. } => (items.len(), true),
        WatchUpdate::Capped { .. } => (0, false),
        other => panic!("unexpected update {other:?}"),
    }
}

fn open_plain(
    mgr: ClusterManager,
    id: ClusterId,
) -> futures::future::BoxFuture<'static, futures::stream::BoxStream<'static, WatchUpdate>> {
    Box::pin(async move { watch(&mgr, &id, pods_spec()).await.unwrap().boxed() })
}

fn open_progressive(
    mgr: ClusterManager,
    id: ClusterId,
) -> futures::future::BoxFuture<'static, futures::stream::BoxStream<'static, WatchUpdate>> {
    Box::pin(async move {
        let options = WatchOptions {
            progressive: true,
            max_objects: None,
        };
        watch_with_options(&mgr, &id, pods_spec(), options)
            .await
            .unwrap()
            .boxed()
    })
}

fn open_capped(
    mgr: ClusterManager,
    id: ClusterId,
) -> futures::future::BoxFuture<'static, futures::stream::BoxStream<'static, WatchUpdate>> {
    Box::pin(async move {
        let options = WatchOptions {
            progressive: true,
            max_objects: Some(TABLE_CAP),
        };
        watch_with_options(&mgr, &id, pods_spec(), options)
            .await
            .unwrap()
            .boxed()
    })
}

/// The cap the window's tables ask for (`TABLE_MAX_OBJECTS` in `src/components/Table/limits.ts`).
const TABLE_CAP: u32 = 20_000;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "a measurement; run by hand with --ignored --nocapture"]
async fn scale_watch_of_many_pods() {
    let modes: [(&str, Open); 3] = [
        ("plain", open_plain),
        ("progressive", open_progressive),
        ("capped", open_capped),
    ];
    for total in [10_000, 50_000] {
        for delay in [Duration::ZERO, Duration::from_millis(50)] {
            for (name, open) in modes {
                let m = measure(total, delay, open).await;
                println!(
                    "{name:<11} {total:>6} pods, page delay {delay:>4?}: first rows {:>8.1?} ({} rows), complete {:>8.1?}, {} objects sent, kept {:.1} MB ({} B/object listed), RSS {} B/object",
                    m.first_rows,
                    m.first_rows_count,
                    m.complete,
                    m.objects,
                    m.kept_bytes as f64 / 1e6,
                    m.kept_bytes / total,
                    m.rss_per_object_bytes
                );
            }
        }
    }
}

/// Estimated heap of the objects of an update (see [`value_heap`]).
fn update_heap(update: &WatchUpdate) -> usize {
    match update {
        WatchUpdate::Snapshot { items }
        | WatchUpdate::SnapshotPart { items }
        | WatchUpdate::SnapshotEnd { items, .. } => items.iter().map(|v| value_heap(v)).sum(),
        _ => 0,
    }
}

/// Estimated heap of a JSON value: 32 bytes per value slot, string capacities, and per object entry its key and a
/// map slot (an estimate of serde_json's layout, enough to compare modes).
fn value_heap(value: &Value) -> usize {
    match value {
        Value::String(s) => s.capacity(),
        Value::Array(items) => items.iter().map(|v| 32 + value_heap(v)).sum(),
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| 24 + k.capacity() + 32 + 16 + value_heap(v))
            .sum(),
        _ => 0,
    }
}

/// Updates of a watch until (and with) the one that completes its first list, plus what follows within `after`.
async fn first_list(
    updates: impl Stream<Item = WatchUpdate>,
    after: Duration,
) -> (Vec<WatchUpdate>, Vec<WatchUpdate>) {
    let mut updates = Box::pin(updates);
    let mut list = Vec::new();
    loop {
        let update = tokio::time::timeout(Duration::from_secs(30), updates.next())
            .await
            .expect("the list never completed")
            .expect("the stream ended");
        let done = rows_of(&update).1;
        list.push(update);
        if done {
            break;
        }
    }
    let mut more = Vec::new();
    let deadline = Instant::now() + after;
    while let Ok(Some(update)) = tokio::time::timeout_at(deadline, updates.next()).await {
        more.push(update);
    }
    (list, more)
}

fn options(progressive: bool, max_objects: Option<u32>) -> WatchOptions {
    WatchOptions {
        progressive,
        max_objects,
    }
}

fn uids(items: &[Arc<Value>]) -> Vec<String> {
    items.iter().map(|v| uid_of(v)).collect()
}

#[tokio::test]
async fn a_progressive_first_list_shows_its_first_page_before_the_whole_list_is_in() {
    let api = pods_api(2000, Duration::from_millis(150)).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let watch = watch_with_options(&mgr, &id, pods_spec(), options(true, None))
        .await
        .unwrap();
    let (list, _) = first_list(watch, Duration::ZERO).await;

    let Some(WatchUpdate::SnapshotPart { items: first }) = list.first() else {
        panic!(
            "the first update is not a part: {:?}",
            list.first().map(rows_of)
        );
    };
    // The first page (kube lists 500 per page) goes out whole, before the other three pages are in.
    assert_eq!(first.len(), 500);
    let Some(WatchUpdate::SnapshotEnd { deleted, .. }) = list.last() else {
        panic!("the list does not end with SnapshotEnd");
    };
    assert!(deleted.is_empty());
    let mut all: Vec<String> = list
        .iter()
        .flat_map(|u| match u {
            WatchUpdate::SnapshotPart { items } | WatchUpdate::SnapshotEnd { items, .. } => {
                uids(items)
            }
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    let sent = all.len();
    all.sort();
    all.dedup();
    assert_eq!((sent, all.len()), (2000, 2000), "each object is sent once");
}

#[tokio::test]
async fn a_progressive_list_that_is_in_at_once_is_one_snapshot_and_a_plain_watch_sends_no_parts() {
    let api = pods_api(300, Duration::ZERO).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    for progressive in [true, false] {
        let watch = watch_with_options(&mgr, &id, pods_spec(), options(progressive, None))
            .await
            .unwrap();
        let (list, _) = first_list(watch, Duration::ZERO).await;
        assert!(
            matches!(list.as_slice(), [WatchUpdate::Snapshot { items }] if items.len() == 300),
            "progressive {progressive}: {:?}",
            list.iter().map(rows_of).collect::<Vec<_>>()
        );
    }
    let big = pods_api(2000, Duration::from_millis(100)).await;
    let (_tmp, mgr, id) = connected_to(big.url()).await;
    let watch = watch(&mgr, &id, pods_spec()).await.unwrap();
    let (list, _) = first_list(watch, Duration::ZERO).await;
    assert!(matches!(list.as_slice(), [WatchUpdate::Snapshot { items }] if items.len() == 2000));
}

#[tokio::test]
async fn a_capped_watch_keeps_and_sends_only_the_cap_and_says_how_many_match() {
    let api = pods_api(2000, Duration::from_millis(100)).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    for progressive in [false, true] {
        let watch = watch_with_options(&mgr, &id, pods_spec(), options(progressive, Some(700)))
            .await
            .unwrap();
        let (list, more) = first_list(watch, Duration::from_millis(400)).await;
        let sent: usize = list.iter().map(|u| rows_of(u).0).sum();
        assert_eq!(sent, 700, "progressive {progressive}");
        assert!(
            matches!(more.as_slice(), [WatchUpdate::Capped { total: 2000 }]),
            "progressive {progressive}: {more:?}"
        );
    }
}

#[tokio::test]
async fn a_capped_watch_gives_a_freed_slot_to_the_next_object_and_counts_what_it_leaves_out() {
    let pod = |i: usize, kind: &str| {
        let object = pod_json(i);
        format!(r#"{{"type":"{kind}","object":{object}}}"#)
    };
    let events = format!("{}\n{}\n", pod(0, "DELETED"), pod(3, "ADDED"));
    let api = FakeApi::start(move |req: &Request| {
        if req.query.contains("watch=") {
            return Reply::stream(events.clone());
        }
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE_RESOURCES),
            "/apis" => Reply::json(200, API_GROUPS),
            "/api/v1/pods" => pod_page(3, &req.query),
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    let watch = watch_with_options(&mgr, &id, pods_spec(), options(false, Some(2)))
        .await
        .unwrap();
    let (list, more) = first_list(watch, BATCH_INTERVAL * 4).await;
    let [WatchUpdate::Snapshot { items }] = list.as_slice() else {
        panic!("{list:?}");
    };
    let id_of = |i: usize| format!("00000000-0000-4000-8000-{i:012}");
    let mut kept = uids(items);
    kept.sort();
    assert_eq!(kept, [id_of(0), id_of(1)]);
    // Pod 0 is deleted and pod 3 takes its slot; pod 2 stays left out: 3 match, 2 are kept.
    match more.as_slice() {
        [
            WatchUpdate::Capped { total: 3 },
            WatchUpdate::Delta { upserted, deleted },
        ] => {
            assert_eq!(uids(upserted), [id_of(3)]);
            assert_eq!(deleted, &[id_of(0)]);
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn count_reads_one_object_and_the_remaining_count_per_namespace() {
    let api = pods_api(2000, Duration::ZERO).await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let kind = pods_spec().kind;
    let before = api.requests().len();
    let all = count(&mgr, &id, &kind, None, None, 1000).await.unwrap();
    assert_eq!(
        all,
        ObjectCount {
            count: 2000,
            exact: true
        }
    );
    let listed: Vec<_> = api.requests()[before..].to_vec();
    assert_eq!(listed.len(), 1, "one request");
    assert!(listed[0].query.contains("limit=1"), "{}", listed[0].query);
    assert!(listed[0].header("accept").contains("PartialObjectMetadata"));

    let two = ["a".to_owned(), "b".to_owned()];
    let both = count(&mgr, &id, &kind, Some(&two), None, 10_000)
        .await
        .unwrap();
    assert_eq!(
        both,
        ObjectCount {
            count: 4000,
            exact: true
        }
    );

    // With a label selector the API server does not count the rest: pages up to `up_to`, then "at least".
    let some = count(&mgr, &id, &kind, None, Some("app=web"), 1000)
        .await
        .unwrap();
    assert_eq!(
        some,
        ObjectCount {
            count: 1001,
            exact: false
        }
    );
    let few = pods_api(300, Duration::ZERO).await;
    let (_tmp, mgr, id) = connected_to(few.url()).await;
    let all = count(&mgr, &id, &kind, None, Some("app=web"), 1000)
        .await
        .unwrap();
    assert_eq!(
        all,
        ObjectCount {
            count: 300,
            exact: true
        }
    );
}

#[tokio::test]
async fn a_count_that_does_not_answer_times_out_and_namespaces_are_counted_side_by_side() {
    let api = FakeApi::start(|req: &Request| match req.path.as_str() {
        "/api" => Reply::json(200, API_VERSIONS),
        "/api/v1" => Reply::json(200, CORE_RESOURCES),
        "/apis" => Reply::json(200, API_GROUPS),
        "/api/v1/pods" => Reply::hang(),
        _ => pod_page(10, &req.query).after(Duration::from_millis(600)),
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let kind = pods_spec().kind;
    let started = Instant::now();
    let err = count(&mgr, &id, &kind, None, None, 100).await.unwrap_err();
    assert_eq!(err.code, crate::error::ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5));
    // Eight namespaces that take 600 ms each are counted together, not one after another.
    let namespaces: Vec<String> = (0..8).map(|i| format!("ns-{i}")).collect();
    let started = Instant::now();
    let all = count(&mgr, &id, &kind, Some(&namespaces), None, 100)
        .await
        .unwrap();
    assert_eq!(
        all,
        ObjectCount {
            count: 80,
            exact: true
        }
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "{:?}",
        started.elapsed()
    );
}

#[tokio::test]
async fn a_progressive_list_that_loses_its_connection_waits_the_first_pause_only() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    let failed = Arc::new(AtomicBool::new(false));
    let lists: Arc<Mutex<Vec<(Instant, bool)>>> = Arc::default();
    let (fail, seen) = (Arc::clone(&failed), Arc::clone(&lists));
    let api = FakeApi::start(move |req: &Request| {
        if req.query.contains("watch=") {
            return Reply::stream(String::new());
        }
        match req.path.as_str() {
            "/api" => Reply::json(200, API_VERSIONS),
            "/api/v1" => Reply::json(200, CORE_RESOURCES),
            "/apis" => Reply::json(200, API_GROUPS),
            "/api/v1/pods" => {
                let second_page = req.query.contains("continue=");
                seen.lock().unwrap().push((Instant::now(), second_page));
                // The second page fails once, as an API server restarting under the list.
                if second_page && !fail.swap(true, Ordering::SeqCst) {
                    return Reply::json(500, r#"{"kind":"Status","status":"Failure","code":500}"#);
                }
                pod_page(1000, &req.query)
            }
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let watch = watch_with_options(&mgr, &id, pods_spec(), options(true, None))
        .await
        .unwrap();
    let (list, _) = first_list(
        watch.filter(|u| futures::future::ready(!matches!(u, WatchUpdate::Reconnecting))),
        Duration::ZERO,
    )
    .await;
    assert!(matches!(list.last(), Some(WatchUpdate::SnapshotEnd { .. })));
    let lists = lists.lock().unwrap().clone();
    let failed_at = lists.iter().find(|(_, second)| *second).unwrap().0;
    let relisted_at = lists
        .iter()
        .find(|(at, second)| !*second && *at > failed_at)
        .expect("listed again")
        .0;
    // The first pause is 1 s; a second lost connection counted by mistake would double it.
    let pause = relisted_at - failed_at;
    assert!(pause < Duration::from_millis(1800), "{pause:?}");
}

#[tokio::test]
async fn namespaces_listed_side_by_side_share_the_cap_while_they_list() {
    let api = FakeApi::start(|req: &Request| {
        if req.query.contains("watch=") {
            return Reply::stream(String::new());
        }
        let ns = req
            .path
            .strip_prefix("/api/v1/namespaces/ns-")
            .and_then(|rest| rest.strip_suffix("/pods"))
            .and_then(|n| n.parse::<usize>().ok());
        match (req.path.as_str(), ns) {
            ("/api", _) => Reply::json(200, API_VERSIONS),
            ("/api/v1", _) => Reply::json(200, CORE_RESOURCES),
            ("/apis", _) => Reply::json(200, API_GROUPS),
            (_, Some(n)) => {
                pod_page_from(n * 10_000, 600, &req.query).after(Duration::from_millis(100))
            }
            _ => Reply::not_found(),
        }
    })
    .await;
    let (_tmp, mgr, id) = connected_to(api.url()).await;
    mgr.kinds(&id).await.unwrap();
    let mut spec = pods_spec();
    spec.namespaces = Some((0..4).map(|n| format!("ns-{n}")).collect());
    let watch = watch_with_options(&mgr, &id, spec, options(true, Some(700)))
        .await
        .unwrap();
    let (list, more) = first_list(watch, Duration::from_millis(400)).await;
    // Never more than the cap on the way: no namespace takes a cap of its own only to lose it at the end.
    let sent: usize = list.iter().map(|u| rows_of(u).0).sum();
    assert_eq!(
        sent,
        700,
        "{:?}",
        list.iter().map(rows_of).collect::<Vec<_>>()
    );
    if let Some(WatchUpdate::SnapshotEnd { deleted, .. }) = list.last() {
        assert!(deleted.is_empty());
    }
    assert!(
        matches!(more.as_slice(), [WatchUpdate::Capped { total: 2400 }]),
        "{more:?}"
    );
}
