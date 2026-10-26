//! Watches of large lists (#157) against the kind test cluster: the first list in parts, the cap, and object counts.
//!
//! ```sh
//! SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) cargo test -p sextant-core --test watch_scale -- --test-threads=1
//! ```
//!
//! `scale_measure_pods_on_kind` is a measurement (`--ignored --nocapture`); give it many pods first with the load
//! fixture (`scripts/fixtures/load/load.sh apply`, then `delete`).

mod common;

use std::collections::BTreeSet;
use std::time::{Duration, Instant};

use futures::{Stream, StreamExt};
use sextant_core::resources::{
    self, KindRef, ObjectCount, WatchObject, WatchOptions, WatchSpec, WatchUpdate,
};

fn pods(namespaces: Option<&[&str]>) -> WatchSpec {
    WatchSpec {
        kind: KindRef {
            group: String::new(),
            version: "v1".into(),
            kind: "Pod".into(),
        },
        namespaces: namespaces.map(|ns| ns.iter().map(|n| n.to_string()).collect()),
        label_selector: None,
        field_selector: None,
        metadata_only: false,
    }
}

fn uids(items: &[WatchObject]) -> Vec<String> {
    items
        .iter()
        .map(|o| {
            o.to_value()["metadata"]["uid"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .collect()
}

/// The objects of the first list (parts and their end, or one snapshot), when the first rows came and when it was
/// complete, plus the `Capped` total that follows it (if any, within a second).
async fn first_list(
    updates: impl Stream<Item = WatchUpdate>,
) -> (BTreeSet<String>, Duration, Duration, Option<u64>) {
    let started = Instant::now();
    let mut updates = Box::pin(updates);
    let mut seen = BTreeSet::new();
    let mut first = None;
    let complete = loop {
        let update = tokio::time::timeout(Duration::from_secs(60), updates.next())
            .await
            .expect("no complete list in 60 s")
            .expect("the watch ended");
        let (items, deleted, done) = match update {
            WatchUpdate::Snapshot { items } => (items, Vec::new(), true),
            WatchUpdate::SnapshotPart { items } => (items, Vec::new(), false),
            WatchUpdate::SnapshotEnd { items, deleted } => (items, deleted, true),
            WatchUpdate::Reconnecting | WatchUpdate::Forbidden { .. } => continue,
            other => panic!("unexpected {other:?}"),
        };
        if first.is_none() && !items.is_empty() {
            first = Some(started.elapsed());
        }
        seen.extend(uids(&items));
        for uid in deleted {
            seen.remove(&uid);
        }
        if done {
            break started.elapsed();
        }
    };
    let capped = match tokio::time::timeout(Duration::from_secs(1), updates.next()).await {
        Ok(Some(WatchUpdate::Capped { total })) => Some(total),
        _ => None,
    };
    (seen, first.unwrap_or(complete), complete, capped)
}

#[tokio::test]
async fn a_progressive_capped_watch_and_a_count_agree_with_a_plain_watch() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    let plain = resources::watch(&mgr, &id, pods(None)).await.unwrap();
    let (all, ..) = first_list(plain).await;
    assert!(all.len() > 3, "the cluster has pods: {}", all.len());

    let options = WatchOptions {
        progressive: true,
        max_objects: None,
    };
    let progressive = resources::watch_with_options(&mgr, &id, pods(None), options)
        .await
        .unwrap();
    let (listed, ..) = first_list(progressive).await;
    assert_eq!(listed, all);

    let cap = 3;
    let capped = WatchOptions {
        progressive: false,
        max_objects: Some(cap),
    };
    let watch = resources::watch_with_options(&mgr, &id, pods(None), capped)
        .await
        .unwrap();
    let (kept, _, _, total) = first_list(watch).await;
    assert_eq!(kept.len(), cap as usize);
    assert!(kept.is_subset(&all));
    assert_eq!(total, Some(all.len() as u64));

    let kind = pods(None).kind;
    let ObjectCount { count, exact } = resources::count(&mgr, &id, &kind, None, None, 10_000)
        .await
        .unwrap();
    assert!(exact);
    assert_eq!(count, all.len() as u64);
    let system = ["kube-system".to_owned()];
    let in_system = resources::count(&mgr, &id, &kind, Some(&system), None, 10_000)
        .await
        .unwrap();
    assert!(
        in_system.count > 0 && in_system.count < count,
        "{in_system:?}"
    );
}

#[tokio::test]
#[ignore = "a measurement; run by hand with --ignored --nocapture"]
async fn scale_measure_pods_on_kind() {
    let Some(cluster) = common::test_cluster() else {
        return;
    };
    let (_tmp, mgr, id) = common::connected(&cluster.kubeconfig).await;
    mgr.kinds(&id).await.unwrap();
    let kind = pods(None).kind;
    for round in 0..2 {
        let started = Instant::now();
        let count = resources::count(&mgr, &id, &kind, None, None, 10_000)
            .await
            .unwrap();
        let counted = started.elapsed();
        let plain = resources::watch(&mgr, &id, pods(None)).await.unwrap();
        let (all, first, complete, _) = first_list(plain).await;
        println!(
            "round {round}: count {count:?} in {counted:.1?}; plain watch: {} pods, first rows {first:.1?}, complete {complete:.1?}",
            all.len()
        );
        for options in [
            WatchOptions {
                progressive: true,
                max_objects: None,
            },
            WatchOptions {
                progressive: true,
                max_objects: Some(500),
            },
        ] {
            let watch = resources::watch_with_options(&mgr, &id, pods(None), options)
                .await
                .unwrap();
            let (kept, first, complete, total) = first_list(watch).await;
            println!(
                "round {round}: {options:?}: {} kept of {total:?}, first rows {first:.1?}, complete {complete:.1?}",
                kept.len()
            );
        }
    }
}
