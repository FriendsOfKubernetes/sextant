//! Pod logs as a stream of line batches (every 100 ms).

use std::time::Duration;

use futures::Stream;
use futures::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt};
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
    Lines {
        lines: Vec<String>,
        /// Indices into `lines` of the lines cut at [`MAX_LINE_BYTES`]: the rest of such a line follows as the
        /// next line (in this batch or a later one). Absent when nothing was cut.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[ts(optional, type = "Array<number>")]
        cut: Vec<u32>,
    },
    Ended,
    Error(CoreError),
}

/// How often buffered lines are sent on.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// A batch that grows to this many lines is sent without waiting for the interval.
const MAX_BATCH_LINES: usize = 2_000;
/// A batch that grows to this many bytes of text is sent without waiting for the interval (so one batch holds
/// at most this plus one line).
pub const MAX_BATCH_BYTES: usize = 1024 * 1024;
/// The longest line [`stream_logs`] sends, in bytes: a longer one (a progress bar redrawn with `\r`, binary
/// output) is sent in pieces of this size, each but the last marked in [`LogUpdate::Lines::cut`].
pub const MAX_LINE_BYTES: usize = 64 * 1024;
/// The most lines [`tail`] reads.
pub const MAX_TAIL_LINES: u32 = 2_000;
/// The most bytes [`tail`] returns (and, about twice this, holds while reading): the newest ones.
pub const MAX_TAIL_BYTES: usize = 1024 * 1024;

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
    let namespace = pod.required_namespace()?;
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

/// The last `lines` lines (at most [`MAX_TAIL_LINES`]) of the log of `container` of `pod` (when `None`, the
/// container `kubectl` would pick: the `kubectl.kubernetes.io/default-container` annotation, else the first one), of its previous instance when `previous`. One string, lines separated by `\n`;
/// bytes that are not UTF-8 are decoded lossily. No such pod, container or previous instance is the server's error.
///
/// At most [`MAX_TAIL_BYTES`] are kept, the newest ones: when the lines are longer, the oldest are dropped
/// while reading, and the text starts at a line boundary (only a single newest line longer than the cap is
/// cut inside, keeping its end). The request carries no `limitBytes`: the kubelet applies it from the start
/// of the tail window and would drop the newest lines instead.
pub async fn tail(
    mgr: &ClusterManager,
    cluster: &ClusterId,
    pod: &ObjectRef,
    container: Option<&str>,
    lines: u32,
    previous: bool,
) -> CoreResult<String> {
    let client = mgr.client(cluster)?;
    let namespace = pod.required_namespace()?;
    let api = Api::<Pod>::namespaced(client, namespace);
    let container = match container.filter(|c| !c.is_empty()) {
        Some(name) => name.to_owned(),
        None => crate::exec::default_container(&api, &pod.name).await?,
    };
    let params = LogParams {
        container: Some(container),
        previous,
        tail_lines: Some(i64::from(lines.min(MAX_TAIL_LINES))),
        ..LogParams::default()
    };
    let reader = api.log_stream(&pod.name, &params).await?;
    let bytes = read_newest(reader, MAX_TAIL_BYTES).await.map_err(|err| {
        CoreError::new(
            ErrorCode::Unreachable,
            format!("the log stream broke: {err}"),
        )
    })?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Reads `reader` to its end keeping only the last `cap` bytes (memory stays within about twice the cap).
/// When anything was dropped, the result starts after the first newline of what is kept, so no line is
/// partial; a kept tail without such a newline (one line longer than `cap`) keeps its end, starting at a
/// UTF-8 character boundary.
async fn read_newest<R: AsyncRead + Unpin>(mut reader: R, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    // The last byte dropped so far, if any.
    let mut dropped: Option<u8> = None;
    let mut drop_front = |kept: &mut Vec<u8>| {
        let excess = kept.len() - cap;
        dropped = Some(kept[excess - 1]);
        kept.drain(..excess);
    };
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..n]);
        // Trimming only past twice the cap keeps the copying amortized.
        if kept.len() > cap.saturating_mul(2) {
            drop_front(&mut kept);
        }
    }
    if kept.len() > cap {
        drop_front(&mut kept);
    }
    // Nothing to cut when nothing was dropped or the drop ended exactly at a line boundary.
    if dropped.is_some_and(|last| last != b'\n') {
        // A newline that ends the text does not start a line.
        let body = kept.strip_suffix(b"\n").unwrap_or(&kept);
        let start = match body.iter().position(|&b| b == b'\n') {
            Some(newline) => newline + 1,
            // No line starts inside: keep the end of the one long line, from a character boundary.
            None => kept
                .iter()
                .position(|&b| b & 0b1100_0000 != 0b1000_0000)
                .unwrap_or(kept.len()),
        };
        kept.drain(..start);
    }
    Ok(kept)
}

struct Batcher<R> {
    reader: R,
    /// Bytes of the line being read (at most [`MAX_LINE_BYTES`] plus the newline); survives a cancelled read.
    line: Vec<u8>,
    batch: Vec<String>,
    /// Bytes of text in `batch`.
    batch_bytes: usize,
    /// Indices into `batch` of the lines cut at the cap.
    cut: Vec<u32>,
    flush_at: Option<Instant>,
    interval: Duration,
    /// What follows the batch that is being flushed.
    then: Option<LogUpdate>,
    eof: bool,
    finished: bool,
}

/// Turns log text into batches: lines are collected for `interval` after the first one arrives (or until
/// [`MAX_BATCH_LINES`] or [`MAX_BATCH_BYTES`]), then sent together. A line longer than [`MAX_LINE_BYTES`] is
/// sent in pieces as it is read, so an endless line without a newline never holds more than the cap. The end of
/// the text becomes `Ended`, a read error `Error`; what was read before either is sent first. Lines that are not
/// UTF-8 are decoded lossily.
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
        batch_bytes: 0,
        cut: Vec::new(),
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
            if st.batch.len() >= MAX_BATCH_LINES
                || st.batch_bytes >= MAX_BATCH_BYTES
                || (st.then.is_some() && !st.batch.is_empty())
            {
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
            let read = read_line_capped(&mut st.reader, &mut st.line, MAX_LINE_BYTES);
            let outcome = match st.flush_at {
                Some(at) => tokio::time::timeout_at(at, read).await.ok(),
                None => Some(read.await),
            };
            match outcome {
                None => return Some((flush(&mut st), st)),
                Some(Ok(LineEnd::Newline)) => {
                    let text = std::mem::take(&mut st.line);
                    push_line(&mut st, &text, false);
                }
                Some(Ok(LineEnd::Cap)) => {
                    // Cut at a character boundary; the bytes of a split character start the next piece.
                    let at = char_boundary_before(&st.line);
                    let rest = st.line.split_off(at);
                    let text = std::mem::replace(&mut st.line, rest);
                    push_line(&mut st, &text, true);
                }
                Some(Ok(LineEnd::Eof)) => {
                    st.eof = true;
                    if !st.line.is_empty() {
                        let text = std::mem::take(&mut st.line);
                        push_line(&mut st, &text, false);
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

fn push_line<R>(st: &mut Batcher<R>, raw: &[u8], cut: bool) {
    let text = decode_line(raw);
    if cut {
        st.cut.push(st.batch.len() as u32);
    }
    st.batch_bytes += text.len();
    st.batch.push(text);
    st.flush_at
        .get_or_insert_with(|| Instant::now() + st.interval);
}

fn flush<R>(st: &mut Batcher<R>) -> LogUpdate {
    st.flush_at = None;
    st.batch_bytes = 0;
    LogUpdate::Lines {
        lines: std::mem::take(&mut st.batch),
        cut: std::mem::take(&mut st.cut),
    }
}

/// Why [`read_line_capped`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineEnd {
    /// `line` ends with `\n`.
    Newline,
    /// `line` holds `cap` bytes and the next byte is not `\n`.
    Cap,
    /// The text is over; `line` holds what was left (maybe nothing).
    Eof,
}

/// Appends to `line` up to and including the next `\n`, but never more than `cap` bytes of text: a line that
/// reaches the cap ends there ([`LineEnd::Cap`]) unless a `\n` follows right away. Cancel-safe: the only
/// await is `fill_buf`, which consumes nothing, so a cancelled call loses no bytes and the next call goes on
/// with the same `line`.
async fn read_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<LineEnd> {
    loop {
        let available = match reader.fill_buf().await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(LineEnd::Eof);
        }
        let room = cap.saturating_sub(line.len());
        // One byte past the room: a newline right at the cap still ends the line whole.
        let window = &available[..available.len().min(room + 1)];
        let (used, end) = match window.iter().position(|&b| b == b'\n') {
            Some(newline) => (newline + 1, Some(LineEnd::Newline)),
            None if window.len() > room => (room, Some(LineEnd::Cap)),
            None => (window.len(), None),
        };
        line.extend_from_slice(&available[..used]);
        reader.consume_unpin(used);
        if let Some(end) = end {
            return Ok(end);
        }
    }
}

/// Where to cut `text` so that no UTF-8 character is split: `text.len()`, or the start of a character that the
/// end of `text` cuts short. Text that is not UTF-8 there is cut at its end.
fn char_boundary_before(text: &[u8]) -> usize {
    let end = text.len();
    // The last byte that is not a continuation byte, looking back at most 3 bytes.
    let Some(start) = (end.saturating_sub(4)..end)
        .rev()
        .find(|&i| text[i] & 0b1100_0000 != 0b1000_0000)
    else {
        return end;
    };
    let width = match text[start] {
        b if b & 0b1000_0000 == 0 => 1,
        b if b & 0b1110_0000 == 0b1100_0000 => 2,
        b if b & 0b1111_0000 == 0b1110_0000 => 3,
        b if b & 0b1111_1000 == 0b1111_0000 => 4,
        _ => return end,
    };
    if start + width > end && start > 0 {
        start
    } else {
        end
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
            LogUpdate::Lines { lines, .. } => lines,
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

    mod tail {
        use crate::error::ErrorCode;
        use crate::fake_api::{FakeApi, Reply, Request, connected_to};
        use crate::resources::{KindRef, ObjectRef};

        fn pod(namespace: Option<&str>) -> ObjectRef {
            ObjectRef {
                kind: KindRef {
                    group: String::new(),
                    version: "v1".into(),
                    kind: "Pod".into(),
                },
                namespace: namespace.map(str::to_owned),
                name: "web".into(),
            }
        }

        async fn server() -> FakeApi {
            FakeApi::start(|req: &Request| match req.path.as_str() {
                "/api" => Reply::json(
                    200,
                    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
                ),
                "/api/v1/namespaces/ns/pods/web/log" => Reply::json(200, "one\ntwo\n"),
                _ => Reply::not_found(),
            })
            .await
        }

        #[tokio::test]
        async fn tail_reads_the_last_lines_of_the_container_capped_at_the_maximum() {
            let api = server().await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let text = super::super::tail(&mgr, &id, &pod(Some("ns")), Some("app"), 5_000, true)
                .await
                .unwrap();
            assert_eq!(text, "one\ntwo\n");
            let request = api
                .requests()
                .into_iter()
                .find(|r| r.path.ends_with("/log"))
                .expect("a log request");
            assert!(
                request.query.contains("tailLines=2000"),
                "{}",
                request.query
            );
            assert!(request.query.contains("previous=true"), "{}", request.query);
            assert!(request.query.contains("container=app"), "{}", request.query);
            assert!(!request.query.contains("follow=true"), "{}", request.query);
        }

        #[tokio::test]
        async fn tail_of_long_lines_keeps_only_the_newest_whole_lines_within_the_byte_cap() {
            use super::super::MAX_TAIL_BYTES;
            // 2000 lines of ~1.1 KB: about twice the cap.
            let line = |i: usize| format!("line-{i:05}-{}\n", "x".repeat(1_100));
            let log: String = (0..2_000).map(line).collect();
            assert!(log.len() > MAX_TAIL_BYTES * 2);
            let expected_last = line(1_999);
            let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
                "/api" => Reply::json(
                    200,
                    r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
                ),
                "/api/v1/namespaces/ns/pods/web/log" => Reply::json(200, log.clone()),
                _ => Reply::not_found(),
            })
            .await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let text = super::super::tail(&mgr, &id, &pod(Some("ns")), Some("app"), 2_000, false)
                .await
                .unwrap();
            assert!(text.len() <= MAX_TAIL_BYTES, "{} bytes", text.len());
            assert!(text.len() > MAX_TAIL_BYTES - 1_200, "{} bytes", text.len());
            assert!(text.ends_with(&expected_last), "the newest line is kept");
            let lines: Vec<&str> = text.lines().collect();
            let first: usize = lines[0]
                .strip_prefix("line-")
                .and_then(|rest| rest.split('-').next())
                .expect("the text starts at a line boundary")
                .parse()
                .unwrap();
            assert_eq!(
                first + lines.len(),
                2_000,
                "consecutive lines up to the last"
            );
            let query = api
                .requests()
                .into_iter()
                .find(|r| r.path.ends_with("/log"))
                .expect("a log request")
                .query;
            assert!(!query.contains("limitBytes"), "{query}");
        }

        #[tokio::test]
        async fn tail_of_a_missing_pod_is_not_found_and_without_a_namespace_invalid() {
            let api = server().await;
            let (_tmp, mgr, id) = connected_to(api.url()).await;

            let mut other = pod(Some("ns"));
            other.name = "gone".into();
            let err = super::super::tail(&mgr, &id, &other, None, 10, false)
                .await
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::NotFound);
            let err = super::super::tail(&mgr, &id, &pod(None), None, 10, false)
                .await
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Invalid);
        }
    }

    async fn newest(text: &[u8], cap: usize) -> Vec<u8> {
        read_newest(futures::io::Cursor::new(text.to_vec()), cap)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn read_newest_keeps_the_last_whole_lines_within_the_cap() {
        // Short enough: untouched, even without a final newline.
        assert_eq!(newest(b"a\nb", 10).await, b"a\nb");
        // The cut falls inside "bbb": the partial line is dropped.
        assert_eq!(newest(b"aaa\nbbb\nccc\n", 6).await, b"ccc\n");
        // The cut falls exactly after a newline: the first kept line is whole and stays.
        assert_eq!(newest(b"aaa\nbbb\nccc\n", 8).await, b"bbb\nccc\n");
        // One line longer than the cap keeps its end, from a UTF-8 character boundary.
        assert_eq!(newest("aaaaé-tail\n".as_bytes(), 7).await, b"-tail\n");
        // More than twice the cap, read in several chunks.
        let big: Vec<u8> = (0..100_000)
            .flat_map(|i| format!("{i}\n").into_bytes())
            .collect();
        let kept = newest(&big, 1_000).await;
        assert!(kept.len() <= 1_000);
        assert!(kept.ends_with(b"\n99999\n"));
        assert!(big.ends_with(&kept) && big[big.len() - kept.len() - 1] == b'\n');
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
            if let LogUpdate::Lines { lines, .. } = update {
                assert!(lines.len() <= MAX_BATCH_LINES);
                seen.extend(lines);
            }
        }
        assert_eq!(seen.len(), total);
        assert_eq!(seen[total - 1], format!("l{}", total - 1));
    }

    fn lines_and_cut(update: LogUpdate) -> (Vec<String>, Vec<u32>) {
        match update {
            LogUpdate::Lines { lines, cut } => (lines, cut),
            other => panic!("expected lines, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_endless_line_without_newline_is_sent_in_pieces_within_the_caps() {
        const TOTAL: u64 = 50 * 1024 * 1024;
        let reader = futures::io::BufReader::new(futures::io::repeat(b'x').take(TOTAL));
        let mut updates = Box::pin(batch_lines(reader, Duration::from_secs(60)));
        let (mut bytes, mut pieces, mut batches) = (0usize, 0usize, 0usize);
        while let Some(update) = updates.next().await {
            let LogUpdate::Lines { lines, cut } = update else {
                assert_eq!(update, LogUpdate::Ended);
                continue;
            };
            batches += 1;
            let batch_bytes: usize = lines.iter().map(String::len).sum();
            assert!(
                batch_bytes <= MAX_BATCH_BYTES + MAX_LINE_BYTES,
                "a batch of {batch_bytes} bytes"
            );
            for (i, line) in lines.iter().enumerate() {
                assert!(
                    line.len() <= MAX_LINE_BYTES,
                    "a line of {} bytes",
                    line.len()
                );
                let last_piece = bytes + line.len() == TOTAL as usize;
                assert_eq!(cut.contains(&(i as u32)), !last_piece, "piece {pieces}");
                bytes += line.len();
                pieces += 1;
            }
        }
        assert_eq!(bytes, TOTAL as usize, "every byte arrives");
        assert_eq!(pieces, (TOTAL as usize).div_ceil(MAX_LINE_BYTES));
        assert!(batches >= 50, "{batches} batches");
    }

    #[tokio::test]
    async fn a_line_cut_at_the_cap_is_sent_without_waiting_for_its_newline() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(50)));
        let long = 100 * 1024;
        tx.unbounded_send(Ok(vec![b'x'; long])).unwrap();
        // The interval passes mid-line: the cut piece goes, the rest waits for its newline and stays below the cap.
        let (lines, cut) = lines_and_cut(updates.next().await.unwrap());
        assert_eq!(lines, ["x".repeat(MAX_LINE_BYTES)]);
        assert_eq!(cut, [0]);
        tx.unbounded_send(Ok(b"y\nnext\n".to_vec())).unwrap();
        let (lines, cut) = lines_and_cut(updates.next().await.unwrap());
        assert_eq!(
            lines,
            [
                format!("{}y", "x".repeat(long - MAX_LINE_BYTES)),
                "next".into()
            ]
        );
        assert!(cut.is_empty());
    }

    #[tokio::test]
    async fn a_newline_right_at_the_cap_keeps_the_line_whole() {
        let (tx, reader) = reader();
        let mut updates = Box::pin(batch_lines(reader, Duration::from_millis(50)));
        tx.unbounded_send(Ok(vec![b'x'; MAX_LINE_BYTES])).unwrap();
        tx.unbounded_send(Ok(b"\nshort\n".to_vec())).unwrap();
        drop(tx);
        let (lines, cut) = lines_and_cut(updates.next().await.unwrap());
        assert_eq!(lines, ["x".repeat(MAX_LINE_BYTES), "short".into()]);
        assert!(cut.is_empty(), "{cut:?}");
        assert_eq!(updates.next().await, Some(LogUpdate::Ended));
    }

    #[test]
    fn a_cut_never_splits_a_character() {
        assert_eq!(char_boundary_before(b"abc"), 3);
        assert_eq!(char_boundary_before("a\u{e9}".as_bytes()), 3);
        assert_eq!(char_boundary_before(&"a\u{e9}".as_bytes()[..2]), 1);
        assert_eq!(char_boundary_before(&"a\u{20ac}".as_bytes()[..3]), 1);
        assert_eq!(char_boundary_before(&"a\u{1f600}".as_bytes()[..4]), 1);
        assert_eq!(char_boundary_before("a\u{1f600}".as_bytes()), 5);
        // Not UTF-8: cut where the cap is.
        assert_eq!(char_boundary_before(b"a\x80\x80\x80\x80"), 5);
    }

    #[tokio::test]
    async fn a_followed_log_with_one_huge_line_arrives_in_pieces_of_whole_characters() {
        use crate::fake_api::{FakeApi, Reply, Request, connected_to};
        use crate::resources::KindRef;

        // One odd byte first, so the 64 KiB cap falls inside a two-byte character.
        let body = format!("x{}", "\u{e9}".repeat(1_500_000));
        let expected = body.clone();
        let api = FakeApi::start(move |req: &Request| match req.path.as_str() {
            "/api" => Reply::json(
                200,
                r#"{"kind":"APIVersions","versions":["v1"],"serverAddressByClientCIDRs":[]}"#,
            ),
            "/api/v1/namespaces/ns/pods/web/log" => Reply::json(200, body.clone()),
            _ => Reply::not_found(),
        })
        .await;
        let (_tmp, mgr, id) = connected_to(api.url()).await;
        let pod = ObjectRef {
            kind: KindRef {
                group: String::new(),
                version: "v1".into(),
                kind: "Pod".into(),
            },
            namespace: Some("ns".into()),
            name: "web".into(),
        };
        let opts = LogOptions {
            container: "app".into(),
            follow: true,
            previous: false,
            timestamps: false,
            tail_lines: None,
        };
        let updates = stream_logs(&mgr, &id, &pod, opts).await.unwrap();
        let mut updates = Box::pin(updates);
        let mut text = String::new();
        while let Some(update) = updates.next().await {
            let LogUpdate::Lines { lines, cut } = update else {
                assert_eq!(update, LogUpdate::Ended);
                continue;
            };
            for (i, line) in lines.iter().enumerate() {
                assert!(
                    line.len() <= MAX_LINE_BYTES,
                    "a line of {} bytes",
                    line.len()
                );
                assert!(!line.contains('\u{fffd}'), "a character was split");
                if cut.contains(&(i as u32)) {
                    assert!(line.len() > MAX_LINE_BYTES - 4, "{}", line.len());
                }
                text.push_str(line);
            }
        }
        assert_eq!(text, expected);
    }
}
