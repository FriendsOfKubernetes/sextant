//! Stream delivery bounded by the window's acknowledgements (#342, ADR-0170).
//!
//! A backend stream (a watch, logs, a Loki read, a terminal, a file transfer, a GitOps install, an image read, an
//! extension's watch) sends its payloads through the Tauri `Channel` the window created (ADR-0078). Tauri keeps every
//! payload of 8 KB and more (1 KB raw) inside this process until the page fetches it, and a page that does not run —
//! a minimized or suspended WebView2 — fetches nothing: the queue would grow without bound, and the backend would
//! never learn. So every stream has a [`Flow`] here: the messages it sent and the count the window acknowledged
//! (`streams_ack`, from `openStream` in `src/api/stream.ts`). A stream may be at most [`MAX_UNACKED`] messages ahead
//! of the window; the first message always goes. What waiting means depends on the stream:
//!
//! - watches, logs and Loki reads wait before they take the next item from the core's stream ([`Outlet::room`]): the
//!   core's stream is simply not polled, so nothing piles up behind it;
//! - terminals stop reading their shell's output (`commands/terminal.rs`);
//! - transfers, installs and image reads never stall their work: [`Progress`] keeps only the newest progress payload
//!   while it waits and always delivers the last one;
//! - extensions' watches are skipped by the shared hub while they lag and get the list as it stands once they have
//!   room again (`extensions/watch_hub.rs`).
//!
//! Waiting never holds a lock. A flow is forgotten when its stream ends or is stopped (`*_stop`, `streams_reset`,
//! `close_cluster`, exit), which also wakes whatever waits on it.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::marker::PhantomData;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use sextant_core::ClusterId;
use tauri::Runtime;
use tauri::ipc::{Channel, CommandArg, CommandItem, InvokeError, InvokeResponseBody, IpcResponse};
use tokio::sync::Notify;

pub mod counters;
#[cfg(test)]
mod tests;

/// Messages a stream may send ahead of the window's acknowledgements. Watch batches go out at most every 250 ms and
/// log batches every 100 ms, and the window acknowledges at most every 250 ms (at once at half of this), so a window
/// that runs never makes a stream wait; one that stops reading holds a stream after 3 s (logs) to 8 s (watches).
/// Kept equal to `MAX_UNACKED` in `src/api/stream.ts` by a test.
pub const MAX_UNACKED: u64 = 32;

/// What a stream is, for the counters in the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StreamKind {
    Watch,
    Logs,
    Loki,
    Terminal,
    Transfer,
    Install,
    Image,
    ExtensionWatch,
}

impl StreamKind {
    /// The name in the log.
    pub fn name(self) -> &'static str {
        match self {
            Self::Watch => "watch",
            Self::Logs => "logs",
            Self::Loki => "loki",
            Self::Terminal => "terminal",
            Self::Transfer => "transfer",
            Self::Install => "install",
            Self::Image => "image",
            Self::ExtensionWatch => "extensionWatch",
        }
    }
}

/// Counts over every stream since the start.
#[derive(Debug, Default)]
struct Totals {
    messages: AtomicU64,
    bytes: AtomicU64,
    acknowledged: AtomicU64,
}

/// What [`Flows::counts`] reports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlowCounts {
    /// Open streams by kind.
    pub open: BTreeMap<StreamKind, u64>,
    /// Open streams that are [`MAX_UNACKED`] messages ahead of the window.
    pub waiting: u64,
    /// Messages sent to the window since the start.
    pub messages: u64,
    /// Bytes of those messages (JSON text, or raw bytes).
    pub bytes: u64,
    /// Messages the window acknowledged since the start.
    pub acknowledged: u64,
}

/// One stream's delivery: what it sent and what the window acknowledged.
#[derive(Debug)]
pub struct Flow {
    kind: StreamKind,
    cluster: Option<ClusterId>,
    sent: AtomicU64,
    acked: AtomicU64,
    closed: AtomicBool,
    room: Notify,
    totals: Arc<Totals>,
}

impl Flow {
    /// Messages sent and not acknowledged yet.
    pub fn unacked(&self) -> u64 {
        // `acked` is never above `sent` (see `ack`), and `sent` is read after it.
        let acked = self.acked.load(Ordering::SeqCst);
        self.sent.load(Ordering::SeqCst).saturating_sub(acked)
    }

    /// The stream was stopped: nothing waits on it any more.
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Whether the next message may go now (always on a closed flow: whatever is sent is dropped by its stream).
    pub fn has_room(&self) -> bool {
        self.is_closed() || self.unacked() < MAX_UNACKED
    }

    /// Waits until the next message may go: `true`, or `false` when the flow was closed meanwhile (the stream ends).
    /// Holds no lock while it waits; cancel-safe.
    pub async fn room(&self) -> bool {
        loop {
            let acked = self.room.notified();
            tokio::pin!(acked);
            // Registered before the check, so an acknowledgement right after it is not missed.
            acked.as_mut().enable();
            if self.is_closed() {
                return false;
            }
            if self.unacked() < MAX_UNACKED {
                return true;
            }
            acked.await;
        }
    }

    /// One message of `bytes` was sent to the window.
    pub fn sent(&self, bytes: usize) {
        self.sent.fetch_add(1, Ordering::SeqCst);
        self.totals.messages.fetch_add(1, Ordering::Relaxed);
        self.totals
            .bytes
            .fetch_add(u64::try_from(bytes).unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    /// The window received `count` messages of this stream in all (a count, not an increment, so a late or repeated
    /// acknowledgement changes nothing). More than was sent counts as everything sent.
    pub fn ack(&self, count: u64) {
        let now = count.min(self.sent.load(Ordering::SeqCst));
        let before = self.acked.fetch_max(now, Ordering::SeqCst);
        if now > before {
            self.totals
                .acknowledged
                .fetch_add(now - before, Ordering::Relaxed);
            self.room.notify_waiters();
        }
    }

    /// Ends the waits: [`Flow::room`] answers `false` from now on.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.room.notify_waiters();
    }
}

/// The flows of the running streams, by the stream id the window chose (`AppState.flows`).
#[derive(Debug, Default)]
pub struct Flows {
    map: Mutex<HashMap<String, Arc<Flow>>>,
    totals: Arc<Totals>,
}

impl Flows {
    /// The flow of the stream `id`, kept until the returned handle is dropped. A stream id already in use (its start
    /// fails) gets a flow of its own that acknowledgements never reach; the running stream's flow is not touched.
    pub fn open(
        self: &Arc<Self>,
        id: &str,
        kind: StreamKind,
        cluster: Option<ClusterId>,
    ) -> FlowHandle {
        let flow = Arc::new(Flow {
            kind,
            cluster,
            sent: AtomicU64::new(0),
            acked: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            room: Notify::new(),
            totals: Arc::clone(&self.totals),
        });
        self.lock()
            .entry(id.to_owned())
            .or_insert_with(|| Arc::clone(&flow));
        FlowHandle {
            flows: Arc::clone(self),
            id: id.to_owned(),
            flow,
        }
    }

    /// The window's acknowledgements: stream id → messages received in all. Unknown ids (streams that ended) are
    /// skipped.
    pub fn ack(&self, acks: &HashMap<String, u64>) {
        let flows: Vec<(Arc<Flow>, u64)> = {
            let map = self.lock();
            acks.iter()
                .filter_map(|(id, count)| Some((Arc::clone(map.get(id)?), *count)))
                .collect()
        };
        for (flow, count) in flows {
            flow.ack(count);
        }
    }

    /// Closes and forgets the flows of `cluster`'s streams (they are being stopped).
    pub fn close_cluster(&self, cluster: &ClusterId) {
        let closed: Vec<Arc<Flow>> = {
            let mut map = self.lock();
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, f)| f.cluster.as_ref() == Some(cluster))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        closed.iter().for_each(|f| f.close());
    }

    /// Closes and forgets every flow (`streams_reset`, exit).
    pub fn close_all(&self) {
        let closed: Vec<Arc<Flow>> = self.lock().drain().map(|(_, f)| f).collect();
        closed.iter().for_each(|f| f.close());
    }

    /// Open streams, the ones waiting for the window, and the totals.
    pub fn counts(&self) -> FlowCounts {
        let mut counts = FlowCounts {
            messages: self.totals.messages.load(Ordering::Relaxed),
            bytes: self.totals.bytes.load(Ordering::Relaxed),
            acknowledged: self.totals.acknowledged.load(Ordering::Relaxed),
            ..FlowCounts::default()
        };
        for flow in self.lock().values() {
            *counts.open.entry(flow.kind).or_default() += 1;
            if !flow.has_room() {
                counts.waiting += 1;
            }
        }
        counts
    }

    /// Flows registered (tests).
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Arc<Flow>>> {
        lock(&self.map)
    }
}

/// A stream's hold on its [`Flow`]: dropping it (the stream ended or its task was aborted) closes the flow and
/// forgets it.
#[derive(Debug)]
pub struct FlowHandle {
    flows: Arc<Flows>,
    id: String,
    flow: Arc<Flow>,
}

impl std::ops::Deref for FlowHandle {
    type Target = Flow;

    fn deref(&self) -> &Flow {
        &self.flow
    }
}

impl Drop for FlowHandle {
    fn drop(&mut self) {
        self.flow.close();
        let mut map = self.flows.lock();
        if map
            .get(&self.id)
            .is_some_and(|f| Arc::ptr_eq(f, &self.flow))
        {
            map.remove(&self.id);
        }
    }
}

/// The `onEvent` argument of a stream's start command: the window's channel, its payloads of type `T`. Sent as the
/// JSON body Tauri would send for `T`, so the size of each message is known for the counters.
pub struct StreamChannel<T> {
    channel: Channel<InvokeResponseBody>,
    payload: PhantomData<fn(T)>,
}

impl<T> From<Channel<InvokeResponseBody>> for StreamChannel<T> {
    fn from(channel: Channel<InvokeResponseBody>) -> Self {
        Self {
            channel,
            payload: PhantomData,
        }
    }
}

impl<T> Clone for StreamChannel<T> {
    fn clone(&self) -> Self {
        Self::from(self.channel.clone())
    }
}

impl<'de, R: Runtime, T> CommandArg<'de, R> for StreamChannel<T> {
    fn from_command(command: CommandItem<'de, R>) -> Result<Self, InvokeError> {
        <Channel<InvokeResponseBody> as CommandArg<'de, R>>::from_command(command).map(Self::from)
    }
}

/// A stream's sending end: its channel and its flow. Dropping it ends the flow.
pub struct Outlet<T> {
    channel: Channel<InvokeResponseBody>,
    flow: FlowHandle,
    payload: PhantomData<fn(T)>,
}

impl<T: IpcResponse> Outlet<T> {
    /// The outlet of the stream `id` (registers its flow).
    pub fn open(
        flows: &Arc<Flows>,
        id: &str,
        kind: StreamKind,
        cluster: Option<ClusterId>,
        channel: StreamChannel<T>,
    ) -> Self {
        Self {
            channel: channel.channel,
            flow: flows.open(id, kind, cluster),
            payload: PhantomData,
        }
    }

    /// The stream's flow.
    pub fn flow(&self) -> &Flow {
        &self.flow
    }

    /// See [`Flow::room`].
    pub async fn room(&self) -> bool {
        self.flow.room().await
    }

    /// Sends `payload` now, whatever the room (callers wait for [`Outlet::room`] first); `false` when it could not be
    /// sent (the stream should end).
    pub fn send(&self, payload: T) -> bool {
        let Ok(body) = payload.body() else {
            return false;
        };
        self.flow.sent(match &body {
            InvokeResponseBody::Json(json) => json.len(),
            InvokeResponseBody::Raw(bytes) => bytes.len(),
        });
        self.channel.send(body).is_ok()
    }
}

/// How a payload of a progress-only stream is delivered while the stream waits for the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Progress: only the newest one waiting is kept.
    Latest,
    /// An event the window keeps (an install's applied object): every one is delivered, in order. Its producer bounds
    /// how many there are.
    Each,
    /// The end (done, error, stopped): always delivered — sent at once after the `Each` events still waiting, even
    /// past the limit — and nothing after it.
    Last,
}

/// The sending end of a stream whose work must not wait for the window (a transfer, an install, an image read): a
/// payload goes at once while there is room, else waits as its [`Delivery`] says, and a task sends what waits when
/// the window acknowledges. Cheap to clone; the flow ends when the last clone is dropped.
pub struct Progress<T: IpcResponse + Send + 'static> {
    inner: Arc<ProgressInner<T>>,
    _closer: Arc<CloseOnDrop>,
}

impl<T: IpcResponse + Send + 'static> Clone for Progress<T> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            _closer: Arc::clone(&self._closer),
        }
    }
}

struct ProgressInner<T> {
    outlet: Outlet<T>,
    delivery: fn(&T) -> Delivery,
    held: Mutex<Held<T>>,
}

struct Held<T> {
    waiting: VecDeque<(Delivery, T)>,
    /// A task sends `waiting` as room comes.
    flushing: bool,
    /// The last payload went: nothing more is sent.
    finished: bool,
}

/// Closes the flow when the last [`Progress`] goes, so the task sending what waits ends too.
struct CloseOnDrop(Arc<Flow>);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        self.0.close();
    }
}

impl<T: IpcResponse + Send + 'static> Progress<T> {
    /// The progress outlet of the stream `id`; `delivery` tells how each payload waits.
    pub fn open(
        flows: &Arc<Flows>,
        id: &str,
        kind: StreamKind,
        cluster: Option<ClusterId>,
        channel: StreamChannel<T>,
        delivery: fn(&T) -> Delivery,
    ) -> Self {
        let outlet = Outlet::open(flows, id, kind, cluster, channel);
        let closer = Arc::new(CloseOnDrop(Arc::clone(&outlet.flow.flow)));
        Self {
            inner: Arc::new(ProgressInner {
                outlet,
                delivery,
                held: Mutex::new(Held {
                    waiting: VecDeque::new(),
                    flushing: false,
                    finished: false,
                }),
            }),
            _closer: closer,
        }
    }

    /// Sends `payload` now, or keeps it as its [`Delivery`] says. Never waits. The lock is held only around sends,
    /// which do not wait, so payloads keep their order.
    pub fn send(&self, payload: T) {
        let inner = &self.inner;
        let mut held = lock(&inner.held);
        if held.finished {
            return;
        }
        let delivery = (inner.delivery)(&payload);
        if delivery == Delivery::Last {
            held.finished = true;
            for (kept, waiting) in std::mem::take(&mut held.waiting) {
                if kept == Delivery::Each {
                    inner.outlet.send(waiting);
                }
            }
            inner.outlet.send(payload);
            return;
        }
        if held.waiting.is_empty() && inner.outlet.flow.has_room() {
            inner.outlet.send(payload);
            return;
        }
        match held.waiting.back_mut() {
            Some((Delivery::Latest, last)) if delivery == Delivery::Latest => *last = payload,
            _ => held.waiting.push_back((delivery, payload)),
        }
        if !held.flushing {
            held.flushing = true;
            let inner = Arc::clone(inner);
            tauri::async_runtime::spawn(async move { flush(inner).await });
        }
    }

    /// Payloads waiting for the window (tests).
    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        lock(&self.inner.held).waiting.len()
    }
}

/// Sends what waits, one payload per room, until nothing waits or the flow is closed.
async fn flush<T: IpcResponse>(inner: Arc<ProgressInner<T>>) {
    loop {
        let open = inner.outlet.room().await;
        let mut held = lock(&inner.held);
        let next = if open && !held.finished {
            held.waiting.pop_front()
        } else {
            None
        };
        match next {
            Some((_, payload)) => {
                inner.outlet.send(payload);
            }
            None => {
                held.flushing = false;
                return;
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
