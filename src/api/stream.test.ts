import { describe, expect, it, vi } from "vitest";
import { openStream } from "./stream";

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

function fakeBackend() {
  const log: string[] = [];
  const started = deferred<string>();
  const listening = deferred<void>();
  let emit: ((payload: number) => void) | null = null;
  const spec = {
    start: vi.fn(() => {
      log.push("start");
      return started.promise;
    }),
    listen: vi.fn(async (id: string, handler: (payload: number) => void) => {
      log.push(`listen ${id}`);
      emit = handler;
      await listening.promise;
      return () => log.push(`unlisten ${id}`);
    }),
    stop: vi.fn(async (id: string) => {
      log.push(`stop ${id}`);
    }),
    onEvent: vi.fn((payload: number) => log.push(`event ${payload}`)),
    onListening: vi.fn((id: string) => log.push(`listening ${id}`)),
    onStartError: vi.fn((err: unknown) => log.push(`failed ${String(err)}`)),
  };
  return { log, spec, started, listening, emit: (p: number) => emit?.(p) };
}

describe("openStream", () => {
  it("starts, listens, then reports it listens; closing unlistens before it stops", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.started.resolve("s1");
    await flush();
    b.listening.resolve();
    await flush();
    b.emit(7);
    close();
    await flush();
    expect(b.log).toEqual(["start", "listen s1", "listening s1", "event 7", "unlisten s1", "stop s1"]);
  });

  it("closed before the start answers: stops the new stream and never listens", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    close();
    b.started.resolve("s1");
    await flush();
    expect(b.log).toEqual(["start", "stop s1"]);
  });

  it("closed while subscribing: stops the stream at once, drops the listener when it arrives, reports nothing", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.started.resolve("s1");
    await flush();
    close();
    b.emit(1);
    b.listening.resolve();
    await flush();
    expect(b.log).toEqual(["start", "listen s1", "stop s1", "unlisten s1"]);
  });

  it("drops events after close and stops only once", async () => {
    const b = fakeBackend();
    const close = openStream(b.spec);
    b.started.resolve("s1");
    b.listening.resolve();
    await flush();
    close();
    close();
    b.emit(3);
    await flush();
    expect(b.spec.onEvent).not.toHaveBeenCalled();
    expect(b.spec.stop).toHaveBeenCalledTimes(1);
  });

  it("a failed start is reported unless already closed", async () => {
    const b = fakeBackend();
    openStream(b.spec);
    b.started.reject("forbidden");
    await flush();
    expect(b.log).toEqual(["start", "failed forbidden"]);

    const c = fakeBackend();
    const close = openStream(c.spec);
    close();
    c.started.reject("forbidden");
    await flush();
    expect(c.log).toEqual(["start"]);
  });
});
