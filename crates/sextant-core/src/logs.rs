//! Pod logs as a stream of line batches (every 100 ms).

use std::time::Duration;

use futures::Stream;
use futures::io::{AsyncBufRead, AsyncBufReadExt};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kube::api::LogParams;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use ts_rs::TS;

use crate::cluster::ClusterManager;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::kubeconfig::ClusterId;
use crate::resources::ObjectRef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LogOptions {
    pub container: String,
    pub follow: bool,
    pub previous: bool,
    pub timestamps: bool,
    pub tail_lines: Option<i64>,
}

/// Serialized with a `type` tag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum LogUpdate {
    Lines { lines: Vec<String> },
    Ended,
    Error(CoreError),
}

/// How often buffered lines are sent on.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// A batch that grows to this many lines is sent without waiting for the interval.
const MAX_BATCH_LINES: usize = 2_000;

/// Streams the logs of one container of a pod as batches of lines (at most one batch per [`BATCH_INTERVAL`]).
///
/// Failing to open the stream (no such pod or container, no previous container, no permission) is the `Err`;
/// afterwards the stream ends with [`LogUpdate::Ended`] when the pod's log is over (the container stopped, the
/// pod was deleted, or `follow` is off and the tail was sent) or with [`LogUpdate::Error`] when the connection
/// broke. Dropping the stream closes the connection.
pub async fn stream_logs(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    opts: LogOptions,
) -> CoreResult<impl Stream<Item = LogUpdate> + Send + 'static> {
    let client = mgr.client(cluster)?;
    let namespace = pod.namespace.as_deref().ok_or_else(|| {
        CoreError::new(
            ErrorCode::Invalid,
            "a pod needs a namespace to read its logs",
        )
    })?;
    let params = LogParams {
        container: Some(opts.container).filter(|c| !c.is_empty()),
        follow: opts.follow,
        previous: opts.previous,
        timestamps: opts.timestamps,
        tail_lines: opts.tail_lines,
        ..LogParams::default()
    };
    let reader = Api::<Pod>::namespaced(client, namespace)
        .log_stream(&pod.name, &params)
        .await?;
    Ok(Box::pin(batch_lines(Box::pin(reader), BATCH_INTERVAL)))
}

struct Batcher<R> {
    reader: R,
    /// Bytes of the line being read; survives a cancelled read.
    line: Vec<u8>,
    batch: Vec<String>,
    flush_at: Option<Instant>,
    interval: Duration,
    /// What follows the batch that is being flushed.
    then: Option<LogUpdate>,
    eof: bool,
    finished: bool,
}

/// Turns log text into batches: lines are collected for `interval` after the first one arrives (or until
/// [`MAX_BATCH_LINES`]), then sent together. The end of the text becomes `Ended`, a read error `Error`; what was
/// read before either is sent first. Lines that are not UTF-8 are decoded lossily.
pub(crate) fn batch_lines<R>(
    reader: R,
    interval: Duration,
) -> impl Stream<Item = LogUpdate> + Send + 'static
where
    R: AsyncBufRead + Unpin + Send + 'static,
{
    let state = Batcher {
        reader,
        line: Vec::new(),
        batch: Vec::new(),
        flush_at: None,
        interval,
        then: None,
        eof: false,
        finished: false,
    };
    futures::stream::unfold(state, |mut st| async move {
        loop {
            if st.finished {
                return None;
            }
            if st.batch.len() >= MAX_BATCH_LINES || (st.then.is_some() && !st.batch.is_empty()) {
                return Some((flush(&mut st), st));
            }
            if let Some(last) = st.then.take() {
                st.finished = true;
                return Some((last, st));
            }
            if st.eof {
                st.then = Some(LogUpdate::Ended);
                continue;
            }
            let read = st.reader.read_until(b'\n', &mut st.line);
            let outcome = match st.flush_at {
                Some(at) => tokio::time::timeout_at(at, read).await.ok(),
                None => Some(read.await),
            };
            match outcome {
                None => return Some((flush(&mut st), st)),
                Some(Ok(_)) => {
                    // `read_until` returns without the delimiter only at the end of the text.
                    let complete = st.line.last() == Some(&b'\n');
                    if st.line.is_empty() {
                        st.eof = true;
                    } else {
                        if !complete {
                            st.eof = true;
                        }
                        let text = std::mem::take(&mut st.line);
                        st.batch.push(decode_line(&text));
                        st.flush_at
                            .get_or_insert_with(|| Instant::now() + st.interval);
                    }
                }
                Some(Err(err)) => {
                    st.then = Some(LogUpdate::Error(CoreError::new(
                        ErrorCode::Unreachable,
                        format!("the log stream broke: {err}"),
                    )));
                }
            }
        }
    })
}

fn flush<R>(st: &mut Batcher<R>) -> LogUpdate {
    st.flush_at = None;
    LogUpdate::Lines {
        lines: std::mem::take(&mut st.batch),
    }
}

fn decode_line(raw: &[u8]) -> String {
    let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    String::from_utf8_lossy(raw).into_owned()
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use futures::channel::mpsc;
    use futures::{StreamExt, TryStreamExt};

    use super::*;

    type Chunk = Result<Vec<u8>, std::io::Error>;

    fn reader() -> (
        mpsc::UnboundedSender<Chunk>,
        impl AsyncBufRead + Unpin + Send + 'static,
    ) {
        let (tx, rx) = mpsc::unbounded::<Chunk>();
        (tx, rx.into_async_read())
    }

    fn lines(update: LogUpdate) -> Vec<String> {
        match update {
            LogUpdate::Lines { lines } => lines,
            other => panic!("expected lines, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn lines_written_within_one_interval_arrive_as_one_batch_then_the_stream_ends() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(100)));
        tx.unbounded_send(Ok(b"one\ntwo\r\nth".to_vec())).unwrap();
        tx.unbounded_send(Ok(b"ree\n".to_vec())).unwrap();
        let started = Instant::now();
        assert_eq!(
            lines(updates.next().await.unwrap()),
            ["one", "two", "three"]
        );
        assert!(
            started.elapsed() >= Duration::from_millis(90),
            "sent before the interval"
        );
        drop(tx);
        assert_eq!(updates.next().await, Some(LogUpdate::Ended));
        assert_eq!(updates.next().await, None);
    }

    #[tokio::test]
    async fn the_last_line_without_newline_is_kept_and_invalid_utf8_is_replaced() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(100)));
        tx.unbounded_send(Ok(b"caf\xff\ntail".to_vec())).unwrap();
        drop(tx);
        assert_eq!(
            lines(updates.next().await.unwrap()),
            ["caf\u{fffd}", "tail"]
        );
        assert_eq!(updates.next().await, Some(LogUpdate::Ended));
    }

    #[tokio::test]
    async fn lines_in_later_intervals_form_later_batches() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(100)));
        tx.unbounded_send(Ok(b"a\n".to_vec())).unwrap();
        assert_eq!(lines(updates.next().await.unwrap()), ["a"]);
        tx.unbounded_send(Ok(b"b\n".to_vec())).unwrap();
        assert_eq!(lines(updates.next().await.unwrap()), ["b"]);
    }

    #[tokio::test]
    async fn a_read_error_flushes_what_was_read_and_then_reports_the_error() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(100)));
        tx.unbounded_send(Ok(b"x\n".to_vec())).unwrap();
        tx.unbounded_send(Err(std::io::Error::other("connection reset")))
            .unwrap();
        assert_eq!(lines(updates.next().await.unwrap()), ["x"]);
        match updates.next().await {
            Some(LogUpdate::Error(e)) => assert!(e.message.contains("connection reset"), "{e}"),
            other => panic!("expected an error, got {other:?}"),
        }
        assert_eq!(updates.next().await, None);
    }

    #[tokio::test]
    async fn a_burst_is_split_into_bounded_batches() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_secs(60)));
        let total = MAX_BATCH_LINES * 2 + 5;
        let text: String = (0..total).map(|i| format!("l{i}\n")).collect();
        tx.unbounded_send(Ok(text.into_bytes())).unwrap();
        drop(tx);
        let mut seen = Vec::new();
        while let Some(update) = updates.next().await {
            if let LogUpdate::Lines { lines } = update {
                assert!(lines.len() <= MAX_BATCH_LINES);
                seen.extend(lines);
            }
        }
        assert_eq!(seen.len(), total);
        assert_eq!(seen[total - 1], format!("l{}", total - 1));
    }
}
