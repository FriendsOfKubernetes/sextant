// Test helpers for the details panel and the events page (Vitest only; never imported by application code).
import { act, waitFor } from "@testing-library/react";
import { expect } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type WatchSpec } from "../../api";

export interface WatchBackend {
  backend: MockBackend;
  /** Specs of the watches started so far, by subscription id. */
  specs: Map<string, WatchSpec>;
}

/** A mock backend whose `watch_start` hands out `watch-1`, `watch-2`, … and remembers each spec. */
export function watchBackend(): WatchBackend {
  const specs = new Map<string, WatchSpec>();
  let n = 0;
  const backend = mockBackend({
    watch_start: (args) => {
      const id = `watch-${++n}`;
      specs.set(id, args.spec as WatchSpec);
      return id;
    },
    watch_stop: () => undefined,
  });
  return { backend, specs };
}

/** Waits until a watch of `kind` (and, when given, matching `match`) listens, and returns its id. */
export async function watchOf(wb: WatchBackend, kind: string, match?: (spec: WatchSpec) => boolean): Promise<string> {
  let found: string | undefined;
  await waitFor(() => {
    found = [...wb.specs.entries()]
      .reverse()
      .find(([id, spec]) => spec.kind.kind === kind && (!match || match(spec)) && wb.backend.listenerCount(`watch:${id}`) > 0)?.[0];
    expect(found).toBeDefined();
  });
  return found!;
}

export function emitSnapshot(wb: WatchBackend, id: string, items: KubeObject[]): void {
  act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items }));
}

export function emitDelta(wb: WatchBackend, id: string, upserted: KubeObject[], deleted: string[] = []): void {
  act(() => wb.backend.emit(`watch:${id}`, { type: "delta", upserted, deleted }));
}

/** A deep copy of a fixture, so a test can change it freely. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}
