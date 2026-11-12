use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::Duration;

use serde_json::{Value, json};

use super::counters::{Sample, WindowShown, line};
use super::*;
use crate::events::test_channel;

fn watch_outlet(flows: &Arc<Flows>, id: &str) -> (Outlet<Value>, Receiver<Value>) {
    let (channel, rx) = test_channel();
    (
        Outlet::open(flows, id, StreamKind::Watch, Some("c".into()), channel),
        rx,
    )
}

fn acks(id: &str, count: u64) -> HashMap<String, u64> {
    HashMap::from([(id.to_owned(), count)])
}

/// Whether `room()` answers within a short while (`None`: it still waits).
async fn room_soon(flow: &Flow) -> Option<bool> {
    tokio::time::timeout(Duration::from_millis(100), flow.room())
        .await
        .ok()
}

#[test]
fn the_window_and_the_backend_allow_the_same_number_of_unacknowledged_payloads() {
    let ts = include_str!("../../../src/api/stream.ts");
    let expected = format!("export const MAX_UNACKED = {MAX_UNACKED};");
    assert!(
        ts.contains(&expected),
        "src/api/stream.ts lacks `{expected}`"
    );
}

#[tokio::test]
async fn a_stream_waits_past_the_limit_and_an_acknowledgement_lets_it_go_on() {
    let flows = Arc::new(Flows::default());
    let (outlet, rx) = watch_outlet(&flows, "s-1");
    // The first message always goes, and so does every one up to the limit.
    for n in 0..MAX_UNACKED {
        assert_eq!(room_soon(outlet.flow()).await, Some(true), "message {n}");
        assert!(outlet.send(json!({ "n": n })));
    }
    assert_eq!(rx.try_iter().count() as u64, MAX_UNACKED);
    assert!(!outlet.flow().has_room());
    assert_eq!(
        room_soon(outlet.flow()).await,
        None,
        "past the limit it waits"
    );

    // A waiter wakes on the acknowledgement.
    let waiting = {
        let flows = Arc::clone(&flows);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            flows.ack(&acks("s-1", 1));
        })
    };
    assert!(
        tokio::time::timeout(Duration::from_secs(2), outlet.room())
            .await
            .unwrap()
    );
    waiting.await.unwrap();
    assert_eq!(outlet.flow().unacked(), MAX_UNACKED - 1);

    // A count, not an increment: an older or repeated acknowledgement changes nothing, and more than was sent counts
    // as everything sent.
    flows.ack(&acks("s-1", 1));
    assert_eq!(outlet.flow().unacked(), MAX_UNACKED - 1);
    flows.ack(&acks("s-1", 10_000));
    assert_eq!(outlet.flow().unacked(), 0);
    assert!(outlet.send(json!({ "n": "after" })));
    assert_eq!(outlet.flow().unacked(), 1);
    // Unknown streams are skipped.
    flows.ack(&acks("gone", 3));
}

#[tokio::test]
async fn stopping_wakes_the_stream_and_forgets_its_flow() {
    let flows = Arc::new(Flows::default());
    let (outlet, _rx) = watch_outlet(&flows, "s-1");
    for _ in 0..MAX_UNACKED {
        outlet.send(json!(1));
    }
    let flow_waits = {
        let flows = Arc::clone(&flows);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            flows.close_all();
        })
    };
    assert!(
        !tokio::time::timeout(Duration::from_secs(2), outlet.room())
            .await
            .unwrap(),
        "a reset ends the wait: the stream ends"
    );
    flow_waits.await.unwrap();
    assert!(flows.is_empty());

    // A cluster's flows close with it, the others stay.
    let (a, _) = watch_outlet(&flows, "a");
    let (channel, _rx) = test_channel();
    let b: Outlet<Value> = Outlet::open(&flows, "b", StreamKind::Logs, Some("d".into()), channel);
    flows.close_cluster(&"c".into());
    assert!(a.flow().is_closed() && !b.flow().is_closed());
    assert_eq!(flows.len(), 1);

    // Dropping a stream's outlet (its task ended or was aborted) closes and forgets its flow.
    drop(b);
    assert!(flows.is_empty());
}

#[test]
fn a_taken_stream_id_does_not_touch_the_running_streams_flow() {
    let flows = Arc::new(Flows::default());
    let (running, _rx) = watch_outlet(&flows, "s-1");
    let (taken, _rx2) = watch_outlet(&flows, "s-1");
    running.send(json!(1));
    flows.ack(&acks("s-1", 1));
    assert_eq!(running.flow().unacked(), 0);
    drop(taken);
    assert_eq!(flows.len(), 1, "the running stream keeps its flow");
    flows.ack(&acks("s-1", 1));
    drop(running);
    assert!(flows.is_empty());
}

#[test]
fn counts_say_what_is_open_what_waits_and_what_went() {
    let flows = Arc::new(Flows::default());
    let (watch, _rx) = watch_outlet(&flows, "w");
    let (channel, _rx2) = test_channel();
    let logs: Outlet<Value> = Outlet::open(&flows, "l", StreamKind::Logs, None, channel);
    for _ in 0..MAX_UNACKED {
        watch.send(json!("12345"));
    }
    logs.send(json!(null));
    flows.ack(&acks("l", 1));
    let counts = flows.counts();
    assert_eq!(
        counts.open,
        [(StreamKind::Watch, 1), (StreamKind::Logs, 1)].into()
    );
    assert_eq!(counts.waiting, 1);
    assert_eq!(counts.messages, MAX_UNACKED + 1);
    assert_eq!(counts.bytes, MAX_UNACKED * 7 + 4);
    assert_eq!(counts.acknowledged, 1);
}

fn delivery(event: &Value) -> Delivery {
    match event["type"].as_str() {
        Some("progress") => Delivery::Latest,
        Some("applied") => Delivery::Each,
        _ => Delivery::Last,
    }
}

fn progress(flows: &Arc<Flows>) -> (Progress<Value>, Receiver<Value>) {
    let (channel, rx) = test_channel();
    let progress = Progress::open(
        flows,
        "p",
        StreamKind::Transfer,
        Some("c".into()),
        channel,
        delivery,
    );
    (progress, rx)
}

fn received(rx: &Receiver<Value>) -> Vec<Value> {
    rx.try_iter().collect()
}

#[tokio::test]
async fn progress_keeps_only_the_newest_while_it_waits_and_always_delivers_the_end() {
    let flows = Arc::new(Flows::default());
    let (out, rx) = progress(&flows);
    for n in 0..MAX_UNACKED {
        out.send(json!({ "type": "progress", "n": n }));
    }
    assert_eq!(received(&rx).len() as u64, MAX_UNACKED);
    // The window does not read: the work goes on, and only the newest progress waits.
    out.send(json!({ "type": "progress", "n": 100 }));
    out.send(json!({ "type": "applied", "name": "a" }));
    out.send(json!({ "type": "progress", "n": 101 }));
    out.send(json!({ "type": "progress", "n": 102 }));
    out.send(json!({ "type": "applied", "name": "b" }));
    assert_eq!(out.waiting(), 4, "progress, a, progress, b");
    assert!(received(&rx).is_empty());

    // Room for two: the oldest waiting go first, in order.
    flows.ack(&acks("p", 2));
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut got = Vec::new();
    while got.len() < 2 {
        assert!(std::time::Instant::now() < deadline, "{got:?}");
        got.extend(received(&rx));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        got,
        [
            json!({ "type": "progress", "n": 100 }),
            json!({ "type": "applied", "name": "a" })
        ]
    );
    // The end goes at once, past the limit, after the kept events still waiting; the progress waiting is dropped and
    // nothing goes after the end.
    out.send(json!({ "type": "done" }));
    out.send(json!({ "type": "progress", "n": 200 }));
    assert_eq!(
        received(&rx),
        [
            json!({ "type": "applied", "name": "b" }),
            json!({ "type": "done" })
        ]
    );
    assert_eq!(out.waiting(), 0);
    // The last clone gone, the flow goes too.
    drop(out);
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !flows.is_empty() {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn a_stopped_progress_stream_sends_nothing_that_waited() {
    let flows = Arc::new(Flows::default());
    let (out, rx) = progress(&flows);
    for _ in 0..=MAX_UNACKED {
        out.send(json!({ "type": "progress" }));
    }
    assert_eq!(received(&rx).len() as u64, MAX_UNACKED);
    flows.close_all();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(received(&rx).is_empty());
    // Its end is still said (a stopped transfer says so).
    out.send(json!({ "type": "error" }));
    assert_eq!(received(&rx), [json!({ "type": "error" })]);
}

#[test]
fn the_counters_line_has_counts_only() {
    let mut before = Sample::default();
    before.flows.messages = 100;
    before.flows.bytes = 1024 * 1024;
    before.flows.acknowledged = 90;
    before.api_requests = 40;
    let now = Sample {
        memory: vec![
            ("workingSet", 300 * 1024 * 1024),
            ("private", 512 * 1024 * 1024),
        ],
        flows: FlowCounts {
            open: [(StreamKind::Watch, 9), (StreamKind::Terminal, 1)].into(),
            waiting: 2,
            messages: 1300,
            bytes: 11 * 1024 * 1024 + 512 * 1024,
            acknowledged: 1250,
        },
        api_requests: 552,
        clusters_connected: 1,
        window: Some(WindowShown::Minimized),
    };
    assert_eq!(
        line(&now, &before, Duration::from_secs(600)),
        "counters (10 min): memory workingSet=300.0MiB private=512.0MiB; streams open=10 (watch=9 terminal=1) \
         waiting=2; to the window messages=1200 bytes=10.5MiB acknowledged=1160; API requests=512; clusters \
         connected=1; window=minimized"
    );
    let empty = line(
        &Sample::default(),
        &Sample::default(),
        Duration::from_secs(61),
    );
    assert_eq!(
        empty,
        "counters (2 min): memory unknown; streams open=0 waiting=0; to the window messages=0 bytes=0.0MiB \
         acknowledged=0; API requests=0; clusters connected=0; window=none"
    );
}

#[test]
fn neither_agents_nor_extensions_acknowledge_streams() {
    let tools = crate::mcp::server::all_tools().names();
    assert!(tools.len() > 10, "{tools:?}");
    assert!(
        !tools
            .iter()
            .any(|t| t.contains("stream") || t.ends_with("_ack")),
        "{tools:?}"
    );
    let methods = crate::extensions::api::METHODS;
    assert!(
        !methods
            .iter()
            .any(|m| m.starts_with("streams") || m.ends_with("ack")),
        "{methods:?}"
    );
}
