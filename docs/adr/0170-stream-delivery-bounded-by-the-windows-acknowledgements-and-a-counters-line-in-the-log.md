# ADR-0170: Stream delivery bounded by the window's acknowledgements, and a counters line in the log

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
bounds what can pile up whatever the cause, and counts in the log that tell next time where the memory went.

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

## Decision 2: a counters line in Sextant's log

- Every `EVERY` = 10 minutes, the first `FIRST` = 1 minute after the start, one `applog!` line
  (`src-tauri/src/streams/counters.rs`, started in `setup`, its task in `AppState.counters`, stopped first by
  `close_all`):

  ```
  counters (10 min): memory workingSet=312.4MiB private=280.1MiB; streams open=12 (watch=9 logs=1 terminal=1 extensionWatch=1) waiting=0; to the window messages=1204 bytes=18.4MiB acknowledged=1198; API requests=512; clusters connected=1; window=minimized
  ```

- The process's memory (`sextant_core::process_memory`): Windows `GetProcessMemoryInfo` — the working set and the
  private bytes (commit), through the `windows-sys` the core already has (feature `Win32_System_ProcessStatus`); Linux
  `VmRSS` and `VmData` of `/proc/self/status`; macOS nothing (`memory unknown`), as there is no cheap reading without
  a new dependency.
- The open streams by kind and how many wait for the window; the messages and bytes sent to the window and the
  messages it acknowledged since the last line (from the flows' totals).
- The Kubernetes API requests since the last line: counted in `RetryPolicy::clone_request` of the one client stack
  (`sextant_core::cluster::api_requests`), which runs once before every attempt, each repeat counted again. Clients
  built elsewhere (none for normal reads) are not counted.
- Exec auth plugin runs are **not** counted: kube-rs runs them inside its auth layer and offers no hook, and wrapping
  the plugin would change how it runs (ADR-0136).
- The connected clusters, and whether the main window is visible, minimized, hidden (tray) or gone.
- Counts only: never a name, a namespace, a URL, a cluster's content or a credential (ADR-0151).

## Consequences

- If Tauri's queue was the cause, Sextant now holds at most 32 payloads per stream for a window that does not read
  and catches up when it reads again: a watch resumes (or relists), logs continue from where they stopped, a terminal
  continues, a transfer shows its newest progress, an extension frame gets a fresh snapshot.
- If it was not, the counters line of the next report says whether memory grew with bytes sent to the window, with
  API requests (an exec plugin's token refresh would show as requests, not runs), or with nothing Sextant counts.
- A page that receives payloads but never acknowledges them (a bug in `openStream`, a failing `streams_ack`) would
  stall every stream after 32 payloads; the module tests and `src/api/stream.test.ts` check both sides.
- Module tests that drive a stream past 32 payloads acknowledge them (`state.flows.ack`, the terminal tests'
  `receives_messages`).

## Amendment: a watch that breaks is resumed, not listed again (0.30.4)

The reporter of #342 sent the counters of 0.30.3 from two machines with the same Sextant, Teleport `tsh` and
extensions:
- **Memory.** On the one that leaks, `private` grew about 174 MB a minute from the first minute.
- **Delivery to the window was bounded,** as this ADR wants (`waiting=0`).
- **Both machines sent the window about 1 MB a second, in about one message a second, and made about two API requests
  a second.** With 20–37 quiet watches that is not changes but full snapshots, one after another.

The cause is in `resources/watch.rs`. Once data was shown, every watch error but 410 was a lost connection:
- every source of the watch was dropped;
- everything was listed again a second later;
- a full `Snapshot` went to the window;
- the retry pause was reset by that relist.

A proxy that ends long requests (Teleport's, between the user and the API server) thus made a full list and snapshot
of a kind every time it cut one of its watches.

The leaking machine kept about twice what went to the window: plausibly a copy of each payload in the webview's
UTF-16. That is not proven; a dump would tell. With the snapshots gone, it has almost nothing left to keep.

Decision:
- **Every watcher stream gets kube's default backoff:** 800 ms doubling to 30 s, reset after 120 s without an error.
  So a watch that keeps failing is never retried in a tight loop.
- **Once data was shown, a stream that worked and broke is left to the watcher.** That is a transport error of a
  running watch, `WatchFailed` with anything but an API status. The watcher resumes it from its last
  `resourceVersion` with no list and no snapshot. The API server replays what changed meanwhile, or answers 410, and
  then that source alone is listed again, as before.
- **Errors that say the API server cannot be reached or refuses are left to the watcher too, up to a point.** These
  are a watch that cannot start, a failed list, and an error status. Only after `TRANSIENT_LIMIT` (4) of them in a row
  for one source, over at least `TRANSIENT_WINDOW` (15 s), is the connection lost: `Reconnecting` and a full list, as
  before. Any event of the source ends the run, and an error 60 s after the previous one starts a new one.
- **The counters line also tells, per interval:**
  - the messages and bytes sent by kind of stream;
  - what the watches did (`watch_stats`): relists after their first snapshot, lost connections, 410s, and errors
    resumed by kind (`broken`, `start`, `event`, `list`, `other`);
  - Windows' private bytes, which is the process's commit charge.
- **A line also says at once when the memory the process holds passes 4 GiB, and each time it doubles.** That is
  `private` on Windows and the resident set on Linux, never Linux's reserved `data`. A process that runs out of memory
  can end without a word (the reporter's 0.30.3 left no Windows error report).

Measured on the kind test cluster, with every connection of the app cut 5 s after it opened by a TCP proxy, and the
Pods, Deployments and Events tables open (39 watches, three minutes):
| First minute | 0.30.3's reading | Resumed watches |
|---|---|---|
| Messages to the window | 760 | 53 |
| Bytes to the window | 29.0 MiB | 4.0 MiB, almost all of it the first snapshots |
| API requests | 868 | 300 |
| Relists | 351 | 0 |
| Lost connections | 378 | 0 |
| Broken streams resumed | — | 198 |

Over the three minutes, 25.7 MiB came from the API server with 0.30.3's reading, and 0.5 MiB with the new one.

Tests: `resources/watch_resume_tests.rs`.
- A refused watch is retried without a list.
- A broken stream resumes from its `resourceVersion`.
- Refusals that go on become a lost connection after all.

## Amendment (0.30.6): lists that are not watches, relists as changes, and why a connection was lost

0.30.5's log from the reporter of #342 still showed about 36 relists a minute on both machines, as many lost
connections, and not one resumed error: 0.30.4's resume never ran there. That shape (relists = reconnects,
`resumed=0`) is what a watch refused with 403 right after its list gives. A user who may list a kind but not watch it
had every refused watch counted as a lost connection, since 403 is an error about the request: `Reconnecting`, the
kind listed again after a second, a full snapshot, and the same again. A fake API server that lists Pods and refuses
their watch reproduced it: a full snapshot every second. Their full dump held 635 copies of one 10.65 MB snapshot of
254 CRDs: the window's metadata-only CRD list (`watchCrdChanges`). Metadata-only lists kept the
`kubectl.kubernetes.io/last-applied-configuration` annotation, the whole object as `kubectl apply` sent it, which for
a CRD includes its OpenAPI schema.

- **A source whose watch is refused after its list is listed instead of watched.** A refusal is 403, or 405 where
  watching is not served, as the watch's start, a broken stream's error or an error event (`watch_refused`). The
  source's watcher stops, and the source is listed every `POLL_INTERVAL` (30 s) by `SourceApi::poll` in pages of 500.
  Each list is told like a relist of the watcher. A failed list is an `InitialListFailed` that takes the usual path,
  and the next list follows after the same pause. A lost connection tries watching it again.
  - A namespace the user may not list is still left out, and its access check is now a one-item list only
    (`may_list`): once it may be listed, it comes back and is listed or watched as its rights allow.
  - Before, a namespace that could be listed but not watched was left out with "no access" while other namespaces
    remained, or, when it was the only one, caused reconnects every second.
- **A relist with the connection up sends what it changed, as a `Delta`.** That covers an expired `resourceVersion`,
  each of those lists, and a namespace leaving or coming back. Objects that are new, or whose text is not the stored
  one, are upserted; objects gone, or now left out for the cap, are deleted (`Batcher::note_changes`). Only a lost
  connection still ends in a full `Snapshot`, which ends `Reconnecting`. Every consumer understands a delta: the
  window, the problems store, the timeline (whose relist changes now count as changes) and extension frames.
- **Metadata-only lists leave out `last-applied-configuration`** (`metadata_object`). No metadata-only consumer
  reads it, and the window's CRD list shrinks from megabytes to its names and versions. Whole-object watches keep it.
- **The counters line says why connections were lost** (`ended`, `refused`, `repeated`), and how many sources were
  `listed instead` of watched, with those `lists`.

The memory itself is still unexplained. Both machines sent the window about the same; only the VDI kept it. Large
channel messages go to the window through the IPC fetch, which on Windows copies each body into an `IStream`
(`SHCreateMemStream`) that WebView2 holds. The dump's copies look like such bodies, so the WebView2 runtime of each
machine was asked for. Sending far less removes most of what could be kept.

Tests:
- In `resources/watch_resume_tests.rs`: a kind that can be listed but not watched is listed again and sends only
  changes, and a relist with the connection up sends only what changed.
- In `resources/watch.rs`:
  - a metadata-only watch leaves out the last-applied configuration;
  - a namespace that can be listed but not watched is listed again instead and keeps the others streaming;
  - a metadata watch refused with an indented status is read as refused;
  - a namespace refused both ways stays out.
