# ADR-0078: Backend streams reach the window through Tauri channels, not events

## Context

Every live stream the window opens (watches, log streams, terminal sessions, extension watches, Flux / Argo CD installs, file transfers) was delivered as Tauri events named `<prefix>:<streamId>` (ADR-0013). Tauri 2 delivers an event by `webview.eval` of a script with the whole JSON payload inlined (`tauri::event::emit_js_script`), so a multi-megabyte watch batch — the first snapshot of a few hundred pods — is parsed by WebKit as a JavaScript object literal inside a script, and WebKit keeps that peak memory afterwards. Measured with 500 pods: the WebView process grew by about 40 MB while the live JavaScript objects grew by only about 4.5 MB (issue #170).

A `tauri::ipc::Channel` sends a payload under 8 KB by the same `eval`, and a larger one through the IPC fetch path (`plugin:__TAURI_CHANNEL__|fetch`), whose body is parsed as JSON, not compiled as a script. A channel also keeps the order of its messages (each carries an index) and unregisters its JavaScript callback when the Rust side drops it.

## Decision

- **Streams are channels.** Each start command — `watch_start`, `logs_start`, `exec_start`, `terminal_start`, `node_shell_start`, `debug_start`, `gitops_install_start`, `files_download_start`, `files_upload_start` — takes a last argument `on_event: Channel<Payload>` (`onEvent` on the wire) and sends the stream's payloads (`WatchUpdate`, `LogUpdate`, `TermPayload`, `InstallEvent`, `TransferEvent`) with `channel.send` where it used to emit. A failed send ends the stream as a failed emit did. `extension_call` takes an optional `onEvent` (a `JavaScriptChannelId`, resolved on the calling webview, since `Option<Channel>` is not a command argument) that only `resources.watch` uses; that method without both `streamId` and `onEvent` is `invalid`. The event-name helpers (`watch_event`, `logs_event`, `term_event`, `gitops_install_event`, `ext_watch_event`, the files event) are gone.
- **Everything else about streams stays.** The window still chooses the stream id (`check_stream_id`), the stream is registered in `AppState` before the core works, `streams_reset` / `undo_if_reset` work as before, streams are stopped by id (`watch_stop`, `logs_stop`, `term_stop`, `extension_watch_stop`, `gitops_install_stop`, `files_transfer_stop`), and terminal flow control (`term_ack`) and the extension guard are unchanged.
- **`openStream` owns the channel.** `src/api/stream.ts` waits for `resetStreams`, creates the channel through the transport (`streamChannel`, a `Channel` from `@tauri-apps/api/core` in `transport.ts`, the only place that imports `@tauri-apps/*`), then calls `start(id, channel)`; the channel exists before the start, so a payload sent right after it is not lost, as the listener did before. Closing closes the channel (it stops delivering at once; the backend drops its end when the stream stops) and stops a stream whose start is still in flight once it answers. `StreamChannel<T>` carries its payload type, so a channel of logs cannot be passed to a watch.
- **The test double keeps the old names.** `mockBackend` registers the `onEvent` channel of a start command under `<prefix>:<streamId>` (`STREAM_PREFIXES`), so tests still drive streams with `backend.emit("watch:<id>", …)` and `listenerCount`.
- **Other events stay events**: `cluster-state`, `portforwards`, `mcp-*`, `extensions-changed`, `extension-files-changed`, `open-about`, `ext-audit` — small payloads without a stream id.

## Why

- Keeping events and shrinking the payloads (smaller batches, metadata-only watches) was rejected: the per-batch size is set by the cluster, and every batch still went through a script compile.
- Raw payloads (`InvokeResponseBody::Raw`, an `ArrayBuffer` decoded in JavaScript) were rejected for now: JSON through the fetch path already avoids the script parse, and raw bodies would need a decoder per payload type on the frontend.
- Moving only watches to channels was rejected: one rule for every stream keeps `openStream`, the mock and the docs simple, and logs and transfers have the same large-payload shape.

## Consequences

- Measured on the same step (43 → 543 pods and 150 CRDs, per process, no swap): the WebView process now grows by ~21 MB instead of ~34–40 MB. Together with capping glibc's malloc arenas (`src-tauri/src/malloc.rs`, which takes the Rust process from +35 to +20 MB), Sextant grows by ~41 MB instead of ~57 MB.
- Payloads of 8 KB and more cost one extra IPC round trip each (the fetch); watch batches come at most every 250 ms and logs every 100 ms, so this is negligible.
- The extension wire protocol between frames and the host is unchanged; only the host ↔ backend call carries the channel.
- Tests: the module tests in `src-tauri/src/commands/{resources,logs,terminal,files}.rs` receive through a test channel (`events::test_channel`), `src-tauri/tests/commands.rs` checks the argument name `onEvent` of every start command and of `extension_call`, `src/api/stream.test.ts` checks the order channel → start → close → stop.

## Amendment (0.27.0, #321): a terminal's output is raw bytes

The rejection of raw payloads above is lifted for one stream. A terminal session's channel is `TermChannel` (`Channel<InvokeResponseBody>`, `src-tauri/src/events.rs`): its output goes as `InvokeResponseBody::Raw` (an `ArrayBuffer` in the window, written to xterm as it is) and only its end as a JSON `TermPayload` (`exit`, `error`); the window tells them apart by the payload's `type` field, never `instanceof` (a buffer of another realm fails it). Base64 in JSON cost the window a JSON text, a string, a decoded string and a copy per message — several times the output in garbage — for the one stream whose volume the user controls (`yes`, `cat` of a large file). Measured on the production bundle over a 30-second flood of 101-byte lines: the terminal takes 32–35 MiB/s instead of ~20, and the WebView keeps ~310 MB instead of ~340 MB afterwards for more than twice the output. Flow control (`term_ack`, `OUTPUT_WINDOW`) and the coalescing are unchanged; module tests still see output as `{"type": "data", "data": <base64>}` (`events::test_channel` turns raw bodies into it), the window's tests emit `ArrayBuffer`s. Other streams keep JSON: their payloads are structured and bounded by the cluster.
