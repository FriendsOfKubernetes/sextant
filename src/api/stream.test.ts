import { afterEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type MockBackend } from "./mockBackend";
import { newStreamId, openStream, resetStreams, resetStreamsState } from "./stream";

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

/** A backend whose `listen` and `start` answer when the test says so; ids in the log read as `<id>`. */
function fakeBackend() {
  const log: string[] = [];
  const started = deferred<void>();
  const listening = deferred<void>();
  let id: string | null = null;
  let emit: ((payload: number) => void) | null = null;
  const name = (streamId: string) => (streamId === id ? "<id>" : streamId);
  const spec = {
    start: vi.fn((streamId: string) => {
      log.push(`start ${name(streamId)}`);
      return started.promise;
    }),
    listen: vi.fn(async (streamId: string, handler: (payload: number) => void) => {
      id = streamId;
      log.push(`listen ${name(streamId)}`);
      emit = handler;
      await listening.promise;
      return () => log.push(`unlisten ${name(streamId)}`);
    }),
    stop: vi.fn(async (streamId: string) => {
      log.push(`stop ${name(streamId)}`);
    }),
    onEvent: vi.fn((payload: number) => log.push(`event ${payload}`)),
    onListening: vi.fn((streamId: string) => log.push(`listening ${name(streamId)}`)),
    onStartError: vi.fn((err: unknown) => log.push(`failed ${String(err)}`)),
  };
  return { log, spec, started, listening, id: () => id, emit: (p: number) => emit?.(p) };
}

let backend: MockBackend | null = null;
afterEach(() => {
  backend?.restore();
  backend = null;
  resetStreamsState();
});

describe("openStream", () => {
  it("listens under a fresh id first, then starts with that id; closing unlistens before it stops", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    await flush();
    expect(b.id()).toMatch(UUID);
    expect(b.log).toEqual(["listen <id>"]);
    b.listening.resolve();
    await flush();
    b.started.resolve();
    await flush();
    b.emit(7);
    close();
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "listening <id>", "event 7", "unlisten <id>", "stop <id>"]);
  });

  it("output sent right after the start, before the start answers, reaches the stream", async () => {
    const b = fakeBackend();
    openStream(b.spec);
    b.listening.resolve();
    await flush();
    // The backend emits the first batch at once; its answer to the start comes later.
    b.emit(1);
    b.emit(2);
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "event 1", "event 2", "listening <id>"]);
  });

  it("every stream gets its own id", async () => {
    const ids = new Set(Array.from({ length: 50 }, () => newStreamId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID);
  });

  it("closed while subscribing: never starts and drops the listener when it arrives", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    await flush();
    close();
    b.listening.resolve();
    await flush();
    expect(b.log).toEqual(["listen <id>", "unlisten <id>"]);
    expect(b.spec.start).not.toHaveBeenCalled();
    expect(b.spec.stop).not.toHaveBeenCalled();
  });

  it("closed while the start is in flight: stops the stream once it answers, reports nothing", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.listening.resolve();
    await flush();
    close();
    b.emit(1);
    expect(b.spec.stop).not.toHaveBeenCalled();
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "unlisten <id>", "stop <id>"]);
  });

  it("drops events after close and stops only once", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.listening.resolve();
    b.started.resolve();
    await flush();
    close();
    close();
    b.emit(3);
    await flush();
    expect(b.spec.onEvent).not.toHaveBeenCalled();
    expect(b.spec.stop).toHaveBeenCalledTimes(1);
  });

  it("a failed start unlistens and is reported unless already closed; nothing is stopped", async () => {
    const b = fakeBackend();
    openStream(b.spec);
    b.listening.resolve();
    await flush();
    b.started.reject("forbidden");
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "unlisten <id>", "failed forbidden"]);

    const c = fakeBackend();
    const close = openStream(c.spec);
    c.listening.resolve();
    await flush();
    close();
    c.started.reject("forbidden");
    await flush();
    expect(c.log).toEqual(["listen <id>", "start <id>", "unlisten <id>"]);
  });
});

describe("resetStreams", () => {
  it("runs streams_reset once per page; streams wait for it before they listen or start", async () => {
    const reset = deferred<void>();
    backend = mockBackend({ streams_reset: () => reset.promise });
    void resetStreams();
    void resetStreams();
    const b = fakeBackend();
    openStream(b.spec);
    b.listening.resolve();
    b.started.resolve();
    await flush();
    expect(b.log).toEqual([]);

    reset.resolve();
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "listening <id>"]);
    expect(backend.calls.filter((c) => c.cmd === "streams_reset")).toHaveLength(1);
  });

  it("a failed reset does not keep streams from opening", async () => {
    backend = mockBackend();
    await resetStreams();
    const b = fakeBackend();
    openStream(b.spec);
    b.listening.resolve();
    b.started.resolve();
    await flush();
    expect(b.log).toEqual(["listen <id>", "start <id>", "listening <id>"]);
  });
});
