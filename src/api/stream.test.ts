import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "./mockBackend";
import { newStreamId, openStream, resetStreams, resetStreamsState } from "./stream";
import { currentTransport, setTransport, type StreamChannel } from "./transport";

/** A promise resolved from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A backend whose `start` answers when the test says so, on a transport whose channels log what happens to them; ids
 * in the log read as `<id>`. Payloads the backend sends go through the channel the stream created (`emit`).
 */
function fakeBackend() {
  const log: string[] = [];
  const started = deferred<void>();
  let id: string | null = null;
  let deliver: ((payload: number) => void) | null = null;
  const channels: StreamChannel<number>[] = [];
  const base = currentTransport();
  setTransport({
    ...base,
    channel: <T>(handler: (payload: T) => void): StreamChannel<T> => {
      log.push("channel");
      deliver = handler as (payload: number) => void;
      const channel = { close: () => log.push("close channel") };
      channels.push(channel);
      return channel;
    },
  });
  const name = (streamId: string) => (streamId === id ? "<id>" : streamId);
  const spec = {
    start: vi.fn((streamId: string, channel: StreamChannel<number>) => {
      id = streamId;
      log.push(`start ${name(streamId)}${channel === channels.at(-1) ? "" : " (another channel)"}`);
      return started.promise;
    }),
    stop: vi.fn(async (streamId: string) => {
      log.push(`stop ${name(streamId)}`);
    }),
    onEvent: vi.fn((payload: number) => log.push(`event ${payload}`)),
    onListening: vi.fn((streamId: string) => log.push(`listening ${name(streamId)}`)),
    onStartError: vi.fn((err: unknown) => log.push(`failed ${String(err)}`)),
  };
  return { log, spec, started, id: () => id, emit: (p: number) => deliver?.(p) };
}

let backend: MockBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
  setTransport(null);
  resetStreamsState();
});

describe("openStream", () => {
  it("creates the channel, then starts under a fresh id with it; closing closes the channel, then stops", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    await flush();
    expect(b.id()).toMatch(UUID);
    expect(b.log).toEqual(["channel", "start <id>"]);
    b.started.resolve();
    await flush();
    b.emit(7);
    close();
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "listening <id>", "event 7", "close channel", "stop <id>"]);
  });

  it("output sent right after the start, before the start answers, reaches the stream", async () => {
    const b = fakeBackend();
    openStream(b.spec);
    await flush();
    // The backend sends the first batch at once; its answer to the start comes later.
    b.emit(1);
    b.emit(2);
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "event 1", "event 2", "listening <id>"]);
  });

  it("every stream gets its own id", async () => {
    const ids = new Set(Array.from({ length: 50 }, () => newStreamId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID);
  });

  it("closed before it got going: creates no channel and never starts", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    close();
    await flush();
    expect(b.log).toEqual([]);
    expect(b.spec.start).not.toHaveBeenCalled();
    expect(b.spec.stop).not.toHaveBeenCalled();
  });

  it("closed while the start is in flight: stops the stream once it answers, reports nothing", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    await flush();
    close();
    b.emit(1);
    expect(b.spec.stop).not.toHaveBeenCalled();
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "close channel", "stop <id>"]);
  });

  it("drops events after close and stops only once", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.started.resolve();
    await flush();
    close();
    close();
    b.emit(3);
    await flush();
    expect(b.spec.onEvent).not.toHaveBeenCalled();
    expect(b.spec.stop).toHaveBeenCalledTimes(1);
  });

  it("a failed start closes the channel and is reported unless already closed; nothing is stopped", async () => {
    const b = fakeBackend();
    openStream(b.spec);
    await flush();
    b.started.reject("forbidden");
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "close channel", "failed forbidden"]);
    setTransport(null);

    const c = fakeBackend();
    const close = openStream(c.spec);
    await flush();
    close();
    c.started.reject("forbidden");
    await flush();
    expect(c.log).toEqual(["channel", "start <id>", "close channel"]);
    expect(c.spec.stop).not.toHaveBeenCalled();
  });
});

describe("resetStreams", () => {
  it("runs streams_reset once per page; streams wait for it before they create a channel or start", async () => {
    const reset = deferred<void>();
    backend = mockBackend({ streams_reset: () => reset.promise });
    void resetStreams();
    void resetStreams();
    const b = fakeBackend();
    openStream(b.spec);
    b.started.resolve();
    await flush();
    expect(b.log).toEqual([]);

    reset.resolve();
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "listening <id>"]);
    expect(backend.calls.filter((c) => c.cmd === "streams_reset")).toHaveLength(1);
  });

  it("a failed reset does not keep streams from opening", async () => {
    backend = mockBackend();
    await resetStreams();
    const b = fakeBackend();
    openStream(b.spec);
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["channel", "start <id>", "listening <id>"]);
  });
});
