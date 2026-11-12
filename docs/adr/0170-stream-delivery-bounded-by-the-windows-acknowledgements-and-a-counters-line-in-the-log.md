# ADR-0170: Stream delivery bounded by the window's acknowledgements

## Status

Accepted (Sextant 0.30.1)

## Context

Discussion #342: on Windows (the portable build, 0.24 to 0.29, a Teleport cluster through the `tsh` exec plugin, the
window minimized and nobody using it) `sextant.exe` grows linearly — about 78 MB a minute of working set and 151 MB a
minute of commit — with handles and threads constant and the WebView2 renderer flat at about 129 MB, until it dies
with `0xe0000008` in KERNELBASE (an allocation failure) after 1.8 to 3.5 hours. ADR-0151's log showed no panic: the
run just has no "Sextant exited".

It could not be reproduced on Linux. With about 6 MB/s of watch updates and the page's JavaScript frozen for minutes,
neither Sextant's process nor WebKit's grew.

One mechanism fits Windows and not Linux. Tauri 2.12's `Channel` (`tauri/src/ipc/channel.rs`) evaluates a small
payload inline, but puts every payload of 8 KB and more (1 KB raw) into `ChannelDataIpcQueue` inside Sextant's process
and asks the page, by `eval`, to fetch it; an entry leaves that queue only when the page fetches it. A page that does
not run — a minimized or suspended WebView2 — fetches nothing, so the queue grows with every watch batch, and the
backend never learns that the window is not reading: `Channel::send` succeeds either way. Why the Linux experiment
did not grow as well is not known (how WebView2 suspends a minimized window's page differs from a page frozen by
hand); the mechanism is a suspect, not a finding.

The cause is not confirmed: nobody could watch the queue on the reporter's machine. So 0.30.1 ships a defence that
bounds what can pile up whatever the cause.

## Decision 1: every stream waits for the window's acknowledgements

- **A flow per stream** (`src-tauri/src/streams/mod.rs`, `AppState.flows`): by stream id, the messages sent, the count
  the window acknowledged, a closed flag and a `Notify`. A stream may be at most `MAX_UNACKED` = 32 messages ahead of
  the window; the first message (a watch's first snapshot) always goes. Waiting (`Flow::room`) registers for the wake
  before it checks, holds no lock and is cancel-safe. A flow ends when its stream's sending end is dropped (the stream
  ended or its task was aborted by `*_stop`, `streams_reset`, `close_cluster` or exit); `streams_reset` and
  `close_cluster` also close what is still registered, which wakes any waiter with "stop". A stream id already in use
  gets a flow of its own that acknowledgements never reach, so the running stream's flow is never replaced.
- **Why 32.** Watch batches go out at most every 250 ms and log batches every 100 ms; the window acknowledges at most
  every 250 ms and at once at 16. A window that runs never makes a stream wait; one that stops reading holds a log
  stream after about 3 s and a watch after about 8 s, with at most 32 payloads in Tauri's queue per stream.
- **The window acknowledges** (`openStream`, `src/api/stream.ts`): it counts the payloads it hands to `onEvent` per
  stream and sends the counts in all (not increments, so a late or repeated acknowledgement changes nothing; more than
  was sent counts as everything sent) through one window-only command, `streams_ack` (stream id → count, at most 4096
  ids per call), batched: at most every `ACK_INTERVAL_MS` = 250 ms while some stream has payloads not acknowledged,
  and at once when one stream reaches `ACK_AT_ONCE` = half of `MAX_UNACKED` — so throttled background timers never
  hold a stream that the page still receives. A closed stream is never acknowledged again. `MAX_UNACKED` is kept equal
  on both sides by a Rust test that reads `stream.ts`. Extension frames' watches go through the bridge's `openStream`,
  so their payloads are acknowledged by the same counting. `mockBackend` answers `streams_ack` and keeps the
  acknowledgements in `acks`, not `calls`.
- **What waiting means, per stream:**
  - *Resource watches* (`spawn_watch`), *logs* and *Loki reads* (`forward_logs`) wait before they take the next item
    from the core's stream, so that stream is simply not polled. Both are poll-driven (`futures::stream::unfold` over
    the kube watcher, the log body's reader and Loki's pager): nothing is read or buffered while they are not polled,
    so the HTTP connection's own window holds the rest. An API server that closes a stalled watch is handled by the
    core as today (the watcher resumes, or relists and sends a snapshot).
  - *Terminals* stop reading their shell's output while either the byte window of `term_ack` (unchanged) or the
    message flow is full; the shell blocks on its output as in any terminal, and no byte is dropped.
  - *Progress-only streams* — file transfers and an image file's download (`TransferEvent`), image opens and reads,
    GitOps installs — never stall their work. `Progress` sends at once while there is room; otherwise a payload waits
    by its `Delivery`: `Latest` (progress, readiness) keeps only the newest, `Each` (an install's applied or failed
    object, which the dialog lists) keeps every one in order — as many as the install's plan has — and `Last` (done,
    error, stopped, opened) is always delivered at once, after the `Each` payloads still waiting and even past the
    limit; nothing goes after it. A task sends what waits as acknowledgements come and ends when the flow closes.
  - *Extensions' watches* wait like watches, and the shared hub (`extensions/watch_hub.rs`) keeps at most `MAX_QUEUED`
    = 32 updates per frame: past that the frame is skipped (what waited for it is dropped) and, once it takes updates
    again, it gets the list as it stands as a snapshot (with the cap and the stream's state), as a frame that joins
    late does. One slow frame never blocks the hub or the other frames.
- **Every send site goes through it:** `watch_start` (and the module tests' `forward_watch`) — `Outlet<WatchUpdate>`;
  `logs_start`, `loki_logs_start` — `Outlet`; `exec_start`, `node_shell_start`, `debug_start`, `terminal_start` —
  `Outlet<InvokeResponseBody>` beside `OutputCredit`; `files_download_start`, `files_upload_start`,
  `image_files_download_start` — `Reporter` over `Progress<TransferEvent>`; `image_files_open_start`,
  `image_files_read_start` — `Progress`; `gitops_install_start` (the task and its `on_abort`) — `Progress`;
  `extension_call`'s `resources.watch` — `UpdateSink::window` over an `Outlet`. The command argument `onEvent` is a
  `StreamChannel<T>` (a raw `Channel` with the payload's type), so each message is serialized once, as Tauri would,
  and its size is known.

## Consequences

- If Tauri's queue was the cause, Sextant now holds at most 32 payloads per stream for a window that does not read
  and catches up when it reads again: a watch resumes (or relists), logs continue from where they stopped, a terminal
  continues, a transfer shows its newest progress, an extension frame gets a fresh snapshot.
- A page that receives payloads but never acknowledges them (a bug in `openStream`, a failing `streams_ack`) would
  stall every stream after 32 payloads; the module tests and `src/api/stream.test.ts` check both sides.
- Module tests that drive a stream past 32 payloads acknowledge them (`state.flows.ack`, the terminal tests'
  `receives_messages`).
