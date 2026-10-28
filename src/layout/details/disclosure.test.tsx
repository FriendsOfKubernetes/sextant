import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultAppSettings, loadSettings, mockBackend, updateSettings, type AppSettings, type ObjectRef } from "../../api";
import { getSettingsSnapshot, resetSettingsCache } from "../../api/settings";
import { axeViolations } from "../../test/axe";
import { Block } from "../../features/details/ui";
import { defaultClusterSettings } from "../../features/clusters/clusterSettings";
import { DetailsPanel } from "./DetailsPanel";
import { registerDetailsSection, unregisterDetailsSection } from "./registry";
import { DetailsDisclosureProvider, DetailsSectionControls, DetailsSectionScope, useDetailsDisclosure } from "./disclosure";
import { resetDetailsDisclosureState } from "./disclosureState";

const POD: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "demo-a", name: "pod-a" };
let saved: AppSettings;
let backend: ReturnType<typeof mockBackend>;
beforeEach(async () => {
  resetSettingsCache();
  resetDetailsDisclosureState();
  saved = defaultAppSettings();
  backend = mockBackend({ settings_get: () => saved, settings_update: (args) => (saved = args.settings as AppSettings) });
  await loadSettings();
});
afterEach(() => { cleanup(); backend.restore(); resetSettingsCache(); resetDetailsDisclosureState(); });

function Card({ clusterId = "c1", objectRef = POD, action = () => {} }: { clusterId?: string; objectRef?: ObjectRef; action?: () => void }) {
  return <DetailsDisclosureProvider clusterId={clusterId} objectRef={objectRef}>
    <DetailsSectionControls />
    <DetailsSectionScope id="fields">
      <Block id="pod" title="Pod" actions={<button onClick={action}>Action</button>}>
        <span>Pod body</span>
        <Block id="network" title="Network"><span>Network body</span></Block>
      </Block>
    </DetailsSectionScope>
    <DetailsSectionScope id="yaml"><Block id="yaml" title="YAML" defaultOpen={false}>YAML body</Block></DetailsSectionScope>
  </DetailsDisclosureProvider>;
}
const toggle = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const flush = async () => act(async () => { await updateSettings((s) => s); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each(["none", "cluster", "global"] as const)("waits for %s settings before opening owned sources or accepting a choice", async (mode) => {
  resetSettingsCache();
  saved.appearance.detailsSectionMemory = mode;
  saved.appearance.detailsSections = { "/Pod": { "fields/pod": false } };
  saved.clusters.c1 = { ...defaultClusterSettings(), detailsSections: { "/Pod": { "fields/pod": false } } };
  const initial = structuredClone(saved);
  const load = deferred<AppSettings>();
  const reads = backend.calls.filter((c) => c.cmd === "settings_get").length;
  backend.on("settings_get", () => load.promise);
  const start = vi.fn();
  function Section() {
    const disclosure = useDetailsDisclosure("pod");
    useEffect(() => { if (disclosure?.open) start(); }, [disclosure?.open]);
    return <><button onClick={() => disclosure?.setOpen(false)}>Programmatic choice</button><Block id="pod" title="Pod">Owned body</Block></>;
  }
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={POD}>
    <DetailsSectionControls /><DetailsSectionScope id="fields"><Section /></DetailsSectionScope>
  </DetailsDisclosureProvider>);
  expect(screen.getByRole("button", { name: "Pod" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Expand all" })).toBeDisabled();
  expect(screen.queryByText("Owned body")).not.toBeInTheDocument();
  expect(start).not.toHaveBeenCalled();
  toggle("Pod"); toggle("Programmatic choice");
  await act(async () => { load.resolve(initial); });
  expect(screen.getByRole("button", { name: "Pod" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-expanded", String(mode === "none"));
  expect(start).toHaveBeenCalledTimes(mode === "none" ? 1 : 0);
  expect(backend.calls.filter((c) => c.cmd === "settings_get")).toHaveLength(reads + 1);
  expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
  expect(saved).toEqual(initial);
  expect(getSettingsSnapshot()).toEqual(initial);
  if (mode !== "none") {
    toggle("Pod"); await flush();
    const choices = mode === "global" ? saved.appearance.detailsSections : saved.clusters.c1?.detailsSections;
    expect(choices?.["/Pod"]).toEqual({ "fields/pod": true });
  }
});

it("keeps owned bodies idle after a failed initial load and opens them after an explicit retry", async () => {
  resetSettingsCache();
  const load = deferred<AppSettings>();
  backend.on("settings_get", () => load.promise);
  render(<Card />);
  await act(async () => { load.reject(new Error("settings unavailable")); });
  expect(screen.getByRole("button", { name: "Pod" })).toBeDisabled();
  expect(screen.queryByText("Pod body")).not.toBeInTheDocument();
  toggle("Pod");
  expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
  backend.on("settings_get", () => structuredClone(saved));
  await act(async () => { await loadSettings(); });
  expect(screen.getByText("Pod body")).toBeInTheDocument();
});

it("keeps standalone explicitly collapsible blocks usable before settings load", () => {
  resetSettingsCache();
  render(<Block id="standalone" title="Standalone" defaultOpen={false}>Standalone body</Block>);
  expect(screen.getByRole("button", { name: "Standalone" })).toBeEnabled();
  toggle("Standalone");
  expect(screen.getByText("Standalone body")).toBeInTheDocument();
});

it("keeps none-mode choices across real detail tabs and resets them only for a new or reopened card", async () => {
  await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "none" } }));
  backend.on("resource_get", () => ({ kind: "Pod", metadata: { name: POD.name } }));
  function Fields() {
    return <><Block id="pod" title="Pod"><span>Pod body</span><Block id="network" title="Network">Network body</Block></Block>
      <Block id="yaml" title="YAML" defaultOpen={false}>YAML body</Block></>;
  }
  registerDetailsSection({ id: "test-disclosure-fields", order: 0, appliesTo: () => true, Component: Fields });
  registerDetailsSection({ id: "test-disclosure-tab", order: 1, appliesTo: () => true, placement: "tab", label: "Other tab", Component: () => <span>Other tab body</span> });
  try {
    const view = render(<DetailsPanel clusterId="c1" objectRef={POD} />);
    const heading = screen.getByRole("heading", { name: POD.name });
    const before = backend.calls.filter((c) => c.cmd === "settings_update").length;
    toggle("Network"); toggle("YAML"); toggle("Pod");
    fireEvent.click(screen.getByRole("tab", { name: "Other tab" }));
    expect(screen.queryByRole("button", { name: "Collapse all" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(screen.getByRole("heading", { name: POD.name })).toBe(heading);
    expect(screen.getByRole("button", { name: "Pod" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("YAML body")).toBeInTheDocument();
    toggle("Pod");
    expect(screen.getByRole("button", { name: "Network" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Collapse all" }).closest(".details__body")).toBeNull();
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(before);
    view.rerender(<DetailsPanel clusterId="c1" objectRef={{ ...POD, name: "another-pod" }} />);
    expect(screen.getByText("Network body")).toBeInTheDocument();
    expect(screen.queryByText("YAML body")).not.toBeInTheDocument();
    toggle("Pod"); view.unmount(); render(<DetailsPanel clusterId="c1" objectRef={POD} />);
    expect(screen.getByText("Network body")).toBeInTheDocument();
  } finally {
    unregisterDetailsSection("test-disclosure-fields"); unregisterDetailsSection("test-disclosure-tab");
  }
});

it("starts expanded except YAML, unmounts nested content and restores its own collapsed preference", async () => {
  render(<Card />);
  expect(screen.queryByText("YAML body")).not.toBeInTheDocument();
  toggle("Network");
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  toggle("Pod");
  expect(screen.queryByRole("button", { name: "Network" })).not.toBeInTheDocument();
  toggle("Pod");
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  await flush();
  expect(saved.appearance.detailsSections["/Pod"]).toMatchObject({ "fields/pod/network": false, "fields/pod": true });
});

it("shares global preferences by group and kind, independent of namespace, object and API version", async () => {
  const view = render(<Card />);
  toggle("Network"); await flush();
  view.rerender(<Card clusterId="c2" objectRef={{ ...POD, name: "pod-b", namespace: "demo-b", kind: { ...POD.kind, version: "v9" } }} />);
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  view.rerender(<Card objectRef={{ ...POD, kind: { ...POD.kind, kind: "Node" } }} />);
  expect(screen.getByText("Network body")).toBeInTheDocument();
  view.rerender(<Card objectRef={{ ...POD, kind: { ...POD.kind, group: "other.example" } }} />);
  expect(screen.getByText("Network body")).toBeInTheDocument();
});

it("keeps per-cluster and global banks independent when switching modes", async () => {
  const view = render(<Card />); toggle("Network"); await flush();
  await act(async () => { await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "cluster" } })); });
  expect(screen.getByText("Network body")).toBeInTheDocument();
  toggle("Pod"); await flush();
  view.rerender(<Card clusterId="c2" />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  view.rerender(<Card />);
  expect(screen.queryByText("Pod body")).not.toBeInTheDocument();
  await act(async () => { await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "global" } })); });
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
});

it("does not save in none mode and resets for a different or reopened object", async () => {
  await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "none" } }));
  const view = render(<Card />); toggle("Pod");
  view.rerender(<Card objectRef={{ ...POD, name: "pod-b" }} />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  toggle("Pod"); view.unmount(); render(<Card objectRef={{ ...POD, name: "pod-b" }} />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  expect(saved.appearance.detailsSections).toEqual({});
});

it("retains YAML opening after a fresh settings load", async () => {
  const view = render(<Card />); toggle("YAML"); await flush(); view.unmount();
  resetSettingsCache(); resetDetailsDisclosureState(); await loadSettings(); render(<Card />);
  expect(screen.getByText("YAML body")).toBeInTheDocument();
});

it("keeps action buttons separate and has accessible native keyboard disclosures", async () => {
  const action = vi.fn(); const user = userEvent.setup(); const { container } = render(<Card action={action} />);
  fireEvent.click(screen.getByRole("button", { name: "Action" }));
  expect(action).toHaveBeenCalledOnce(); expect(screen.getByText("Pod body")).toBeInTheDocument();
  const button = screen.getByRole("button", { name: "Pod" }); button.focus(); await user.keyboard(" ");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(document.getElementById(button.getAttribute("aria-controls")!)).toHaveAttribute("hidden");
  await user.keyboard("{Enter}"); expect(button).toHaveAttribute("aria-expanded", "true");
  expect(await axeViolations(container)).toEqual([]);
});

it("stops owned effects while collapsed and starts them only on expansion", () => {
  const start = vi.fn(); const stop = vi.fn();
  function Expensive() { useEffect(() => { start(); return stop; }, []); return <span>Live body</span>; }
  render(<DetailsDisclosureProvider clusterId="c1" objectRef={POD}><DetailsSectionScope id="metrics">
    <Block id="metrics" title="Metrics" defaultOpen={false}><Expensive /></Block>
  </DetailsSectionScope></DetailsDisclosureProvider>);
  expect(start).not.toHaveBeenCalled(); toggle("Metrics"); expect(start).toHaveBeenCalledOnce();
  toggle("Metrics"); expect(stop).toHaveBeenCalledOnce();
});

it("preserves simultaneous edits and unrelated settings through the existing queue", async () => {
  render(<Card />); toggle("Network"); toggle("Pod"); toggle("YAML");
  await act(async () => { await updateSettings((s) => ({ ...s, language: "ru" })); });
  expect(saved.language).toBe("ru");
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "fields/pod/network": false, "fields/pod": false, "yaml/yaml": true });
});

it("keeps failed edits for the session, reports the error and retries on the next change", async () => {
  let fail = true;
  backend.on("settings_update", (args) => { if (fail) throw new Error("disk full"); return saved = args.settings as AppSettings; });
  render(<Card />); toggle("Network");
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  fail = false; toggle("YAML"); await flush();
  expect(saved.appearance.detailsSections["/Pod"]).toMatchObject({ "fields/pod/network": false, "yaml/yaml": true });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("leaves shared blocks outside a details scope unchanged", () => {
  render(<Block id="plain" title="Plain">Body</Block>);
  expect(screen.getByRole("heading", { name: "Plain" })).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("updates another open card of the same kind immediately", async () => {
  render(<><Card /><Card clusterId="c2" objectRef={{ ...POD, name: "pod-b" }} /></>);
  fireEvent.click(screen.getAllByRole("button", { name: "Network" })[0]!);
  expect(screen.queryAllByText("Network body")).toHaveLength(0);
  await flush();
  expect(saved.appearance.detailsSections["/Pod"]?.["fields/pod/network"]).toBe(false);
});

it("reports a capacity failure without sending a write the native reader would truncate", async () => {
  saved.appearance.detailsSections = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`example/Kind${i}`, { "fields/content": false }]));
  render(<Card />); toggle("Pod");
  await screen.findByRole("alert");
  expect(screen.queryByText("Pod body")).not.toBeInTheDocument();
  expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(0);
});

it("collapses unmounted descendants, and expansion replaces earlier overrides with one write", async () => {
  render(<Card />); toggle("Network"); await flush();
  const before = backend.calls.filter((c) => c.cmd === "settings_update").length;
  toggle("Collapse all");
  expect(screen.queryByText("Pod body")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Network" })).not.toBeInTheDocument();
  toggle("Pod");
  expect(screen.getByRole("button", { name: "Network" })).toHaveAttribute("aria-expanded", "false");
  toggle("Expand all");
  expect(screen.getByText("Network body")).toBeInTheDocument();
  expect(screen.getByText("YAML body")).toBeInTheDocument();
  await flush();
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "*": true });
  // Collapse, the explicit parent exception, expand, and the test's queue barrier: no per-block writes.
  expect(backend.calls.filter((c) => c.cmd === "settings_update").length - before).toBe(4);
});

it("retains a bulk default and a rapid individual exception through reload", async () => {
  const view = render(<Card />);
  toggle("Collapse all"); toggle("Pod"); await flush();
  view.unmount(); resetSettingsCache(); resetDetailsDisclosureState(); await loadSettings(); render(<Card />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  expect(screen.queryByText("YAML body")).not.toBeInTheDocument();
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "*": false, "fields/pod": true });
});

it("keeps bulk actions local in none mode and independent across cluster banks", async () => {
  await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "none" } }));
  const view = render(<Card />); toggle("Collapse all");
  expect(screen.queryByText("Pod body")).not.toBeInTheDocument();
  expect(saved.appearance.detailsSections).toEqual({});
  view.rerender(<Card objectRef={{ ...POD, name: "pod-b" }} />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  await act(async () => { await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "cluster" } })); });
  toggle("Collapse all"); await flush();
  view.rerender(<Card clusterId="c2" />);
  expect(screen.getByText("Pod body")).toBeInTheDocument();
  expect(saved.clusters.c1?.detailsSections?.["/Pod"]).toEqual({ "*": false });
});

it("retries a failed bulk replacement without reviving old section overrides", async () => {
  const view = render(<Card />); toggle("YAML"); await flush();
  let fail = true;
  backend.on("settings_update", (args) => { if (fail) throw new Error("disk full"); return saved = args.settings as AppSettings; });
  toggle("Collapse all"); await screen.findByRole("alert");
  expect(screen.queryByText("YAML body")).not.toBeInTheDocument();
  fail = false; toggle("Pod"); await flush();
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "*": false, "fields/pod": true });
  view.unmount(); resetSettingsCache(); resetDetailsDisclosureState(); await loadSettings(); render(<Card />);
  expect(screen.queryByText("YAML body")).not.toBeInTheDocument();
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
});

it("queues a mode change behind delayed bulk edits from shared cards and retries a failed replacement", async () => {
  const first = deferred<void>(); const second = deferred<void>();
  let writes = 0;
  backend.on("settings_update", (args) => {
    const next = structuredClone(args.settings as AppSettings);
    const acknowledgment = ++writes === 1 ? first.promise : writes === 2 ? second.promise : Promise.resolve();
    return acknowledgment.then(() => saved = next);
  });
  render(<><Card /><Card clusterId="c2" objectRef={{ ...POD, name: "pod-b" }} /></>);
  fireEvent.click(screen.getAllByRole("button", { name: "Collapse all" })[0]!);
  await waitFor(() => expect(writes).toBe(1));
  expect(screen.queryAllByText("Pod body")).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Pod" })[1]!);
  const changedMode = updateSettings((s) => ({ ...s, language: "ru", appearance: { ...s.appearance, detailsSectionMemory: "cluster" } }));
  expect(screen.getAllByText("Pod body")).toHaveLength(2);
  expect(screen.queryAllByText("Network body")).toHaveLength(0);
  expect(writes).toBe(1);
  await act(async () => { first.reject(new Error("disk full")); });
  await waitFor(() => expect(writes).toBe(2));
  expect(saved.appearance.detailsSections).toEqual({});
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await act(async () => { second.resolve(); await changedMode; });
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "*": false, "fields/pod": true });
  expect(saved.appearance.detailsSectionMemory).toBe("cluster");
  expect(saved.language).toBe("ru");
  expect(writes).toBe(3);
  expect(screen.getAllByText("Network body")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Network" })[0]!);
  await flush();
  expect(saved.clusters.c1?.detailsSections?.["/Pod"]).toEqual({ "fields/pod/network": false });
  expect(saved.clusters.c2).toBeUndefined();
  expect(screen.getAllByText("Network body")).toHaveLength(1);
});

it("retains a newer failed edit after an older acknowledgment and returns to it after a mode change", async () => {
  const first = deferred<void>(); const second = deferred<void>();
  let writes = 0;
  backend.on("settings_update", (args) => {
    const next = structuredClone(args.settings as AppSettings);
    const acknowledgment = ++writes === 1 ? first.promise : writes === 2 ? second.promise : Promise.resolve();
    return acknowledgment.then(() => saved = next);
  });
  render(<Card />); toggle("Network"); toggle("YAML");
  await waitFor(() => expect(writes).toBe(1));
  await act(async () => { first.resolve(); });
  await waitFor(() => expect(writes).toBe(2));
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "fields/pod/network": false });
  expect(screen.getByText("YAML body")).toBeInTheDocument();
  await act(async () => { second.reject(new Error("disk full")); });
  await screen.findByRole("alert");
  await act(async () => { await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "cluster" } })); });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByText("Network body")).toBeInTheDocument();
  await act(async () => { await updateSettings((s) => ({ ...s, appearance: { ...s.appearance, detailsSectionMemory: "global" } })); });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.queryByText("Network body")).not.toBeInTheDocument();
  expect(screen.getByText("YAML body")).toBeInTheDocument();
  toggle("Pod"); await flush();
  expect(saved.appearance.detailsSections["/Pod"]).toEqual({ "fields/pod/network": false, "yaml/yaml": true, "fields/pod": false });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["global", "cluster"] as const)("accepts the 256th %s section, refuses the 257th and recovers with a bulk replacement", async (mode) => {
  const sections = Object.fromEntries(Array.from({ length: 255 }, (_, i) => [`old/section${i}`, false]));
  const globalSections: AppSettings["appearance"]["detailsSections"] = mode === "global" ? { "/Pod": sections } : {};
  const clusters: AppSettings["clusters"] = mode === "cluster" ? { c1: { ...defaultClusterSettings(), detailsSections: { "/Pod": sections } } } : {};
  await updateSettings((s) => ({ ...s,
    appearance: { ...s.appearance, detailsSectionMemory: mode, detailsSections: globalSections }, clusters,
  }));
  render(<Card />); toggle("Pod"); await flush();
  const choices = () => (mode === "global" ? saved.appearance.detailsSections : saved.clusters.c1?.detailsSections)?.["/Pod"];
  expect(Object.keys(choices()!)).toHaveLength(256);
  expect(choices()?.["fields/pod"]).toBe(false);
  const before = backend.calls.filter((c) => c.cmd === "settings_update").length;
  toggle("YAML"); await screen.findByRole("alert");
  expect(screen.getByText("YAML body")).toBeInTheDocument();
  expect(choices()?.["yaml/yaml"]).toBeUndefined();
  expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(before);
  toggle("Collapse all"); await flush();
  expect(choices()).toEqual({ "*": false });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
