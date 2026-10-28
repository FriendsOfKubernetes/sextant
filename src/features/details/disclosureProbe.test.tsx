import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError, loadSettings, mockBackend, updateSettings, type AppSettings, type ObjectRef, type WatchState } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { DetailsDisclosureProvider, DetailsSectionScope } from "../../layout/details/disclosure";
import { resetDetailsDisclosureState } from "../../layout/details/disclosureState";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { useDisclosureProbe, useDisclosureProbeResult, watchProbeResult, type DisclosureProbeResult } from "./disclosureProbe";

const empty = { items: new Map(), status: "ready" } satisfies WatchState;
const loading = { ...empty, status: "loading" } satisfies WatchState;
const failed = { ...empty, status: "error", error: new ApiError("forbidden", "cannot read required list") } satisfies WatchState;
const forbidden = { ...empty, forbidden: ["restricted"] } satisfies WatchState;
const capped = { ...empty, total: 1 } satisfies WatchState;

describe("watch applicability evidence", () => {
  const cases: Array<{ name: string; found: boolean; states: (WatchState | undefined)[]; want: DisclosureProbeResult | null }> = [
    { name: "positive evidence wins over a failed and pending list", found: true, states: [failed, loading], want: "present" },
    { name: "positive metadata needs no list", found: true, states: [], want: "present" },
    { name: "an unstarted required list stays pending", found: false, states: [undefined], want: null },
    { name: "an initially loading list stays pending", found: false, states: [loading], want: null },
    { name: "one complete list cannot settle another pending list", found: false, states: [empty, loading], want: null },
    { name: "no served lists proves absence", found: false, states: [], want: "absent" },
    { name: "complete empty lists prove absence", found: false, states: [empty, empty], want: "absent" },
    { name: "an empty forbidden set does not imply unreadable namespaces", found: false, states: [{ ...empty, forbidden: [] }], want: "absent" },
    { name: "a complete uncapped empty list proves absence", found: false, states: [{ ...empty, total: 0 }], want: "absent" },
    { name: "a partially forbidden list cannot prove absence", found: false, states: [forbidden], want: "unknown" },
    { name: "a capped list cannot prove absence", found: false, states: [capped], want: "unknown" },
    { name: "a reconnecting list cannot prove absence", found: false, states: [{ ...empty, status: "reconnecting" }], want: "unknown" },
    { name: "a failed list cannot prove absence", found: false, states: [failed], want: "unknown" },
    { name: "a failed list settles unknown before another list finishes", found: false, states: [failed, loading], want: "unknown" },
    { name: "a pending list does not conceal a later failed list", found: false, states: [loading, failed], want: "unknown" },
    { name: "an unstarted list does not conceal known failure", found: false, states: [undefined, failed], want: "unknown" },
    { name: "forbidden evidence settles unknown while a list loads", found: false, states: [{ ...loading, forbidden: ["restricted"] }], want: "unknown" },
    { name: "capped evidence settles unknown while a list loads", found: false, states: [{ ...loading, total: 1 }], want: "unknown" },
  ];
  it.each(cases)("$name", ({ found, states, want }) => {
    expect(watchProbeResult(found, states)).toBe(want);
  });
});

describe("retained disclosure applicability", () => {
  const pod: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "demo", name: "pod" };
  let objectRef: ObjectRef;
  let backend: ReturnType<typeof mockBackend>;
  beforeEach(async () => {
    objectRef = pod;
    resetDetailsDisclosureState();
    backend = mockBackend();
    backend.settings.appearance.detailsSections = { "/Pod": { "probe/conditional": false } };
    backend.settings.clusters.c1 = { ...defaultClusterSettings(), detailsSections: { "/Pod": { "probe/conditional": false } } };
    await loadSettings();
  });
  afterEach(() => { cleanup(); backend.restore(); resetDetailsDisclosureState(); });

  interface Input { answer: DisclosureProbeResult | null; active?: boolean }
  function useResult({ answer, active }: Input) {
    const probe = useDisclosureProbe("conditional", active);
    return { probe, view: useDisclosureProbeResult(probe, answer) };
  }
  function Wrapper({ children }: { children: ReactNode }) {
    return <DetailsDisclosureProvider clusterId="c1" objectRef={objectRef}>
      <DetailsSectionScope id="probe">{children}</DetailsSectionScope>
    </DetailsDisclosureProvider>;
  }
  const choose = (open: boolean) => updateSettings(s => ({ ...s,
    appearance: { ...s.appearance, detailsSections: { "/Pod": { "probe/conditional": open } } },
  }));

  it.each(["present", "unknown"] as const)("retains %s through disabled snapshots and reacquire loading, then accepts complete absence", async answer => {
    const { result, rerender } = renderHook(useResult, { wrapper: Wrapper, initialProps: { answer } as Input });
    await act(async () => {});
    expect(result.current.probe.enabled).toBe(false);
    expect(result.current.view).toEqual({ result: answer, visible: true });
    rerender({ answer: "absent" });
    expect(result.current.view).toEqual({ result: answer, visible: true });
    rerender({ answer: null });
    await act(async () => { await choose(true); });
    expect(result.current.probe.enabled).toBe(true);
    expect(result.current.view).toEqual({ result: answer, visible: true });
    rerender({ answer: "absent" });
    expect(result.current.view).toEqual({ result: "absent", visible: false });
    await act(async () => { await choose(false); });
    rerender({ answer: "present" });
    expect(result.current.probe.enabled).toBe(false);
    expect(result.current.view).toEqual({ result: "absent", visible: false });
  });

  it("does not settle a response before settings are ready or write applicability into preferences", async () => {
    const saved = structuredClone(backend.settings);
    resetSettingsCache();
    let resolve!: (settings: AppSettings) => void;
    backend.on("settings_get", () => new Promise<AppSettings>(yes => { resolve = yes; }));
    const { result, rerender } = renderHook(useResult, { wrapper: Wrapper, initialProps: { answer: "present" } as Input });
    expect(result.current.probe.enabled).toBe(false);
    rerender({ answer: null });
    await act(async () => { resolve(saved); });
    expect(result.current.probe.enabled).toBe(true);
    expect(result.current.view).toEqual({ result: null, visible: false });
    rerender({ answer: "absent" });
    expect(result.current.probe.enabled).toBe(false);
    expect(backend.calls.filter(call => call.cmd === "settings_update")).toHaveLength(0);
    expect(backend.settings).toEqual(saved);
  });

  it("uses the explicit active owner rather than the possible heading's open preference", async () => {
    await choose(true);
    const { result, rerender } = renderHook(useResult, { wrapper: Wrapper, initialProps: { answer: "absent", active: false } as Input });
    await act(async () => {});
    expect(result.current.probe.open).toBe(true);
    expect(result.current.probe.enabled).toBe(false);
    rerender({ answer: null, active: true });
    expect(result.current.probe.enabled).toBe(true);
    expect(result.current.view.visible).toBe(false);
    rerender({ answer: "present", active: true });
    expect(result.current.view.visible).toBe(true);
    rerender({ answer: null, active: false });
    expect(result.current.probe.enabled).toBe(false);
    expect(result.current.view).toEqual({ result: "present", visible: true });
  });

  it("reuses applicability across mode banks for one object and resets it for another object", async () => {
    const { result, rerender } = renderHook(useResult, { wrapper: Wrapper, initialProps: { answer: "present" } as Input });
    await act(async () => {});
    rerender({ answer: null });
    await act(async () => { await updateSettings(s => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "cluster" } })); });
    expect(result.current.probe.enabled).toBe(false);
    expect(result.current.view).toEqual({ result: "present", visible: true });
    objectRef = { ...pod, name: "another-pod" };
    rerender({ answer: null });
    expect(result.current.probe.enabled).toBe(true);
    expect(result.current.view).toEqual({ result: null, visible: false });
  });
});
