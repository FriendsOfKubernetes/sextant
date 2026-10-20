import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resolve } from "../problems/model";
import { resetProblemSources } from "../problems/store";
import revisionsJson from "./fixtures/revisions.json";
import serviceJson from "./fixtures/service.json";
import "./index";
import { CONFIGURATION, DOMAIN_MAPPING, explain, failingCondition, healthOf, KSERVICE, REVISION, ROUTE, trafficSplit } from "./model";
import { knativeProblems } from "./problemRules";

const service = serviceJson as KubeObject;
const [oldRevision, failedRevision] = revisionsJson as KubeObject[];

describe("the model", () => {
  it("reads the state, the failing condition and the traffic split", () => {
    expect(healthOf(service)).toBe("failed");
    expect(failingCondition(service)?.type).toBe("ConfigurationsReady");
    expect(explain(KSERVICE, service)).toEqual({
      key: "revisionFailedTrafficStays",
      params: { revision: "hello-00003", ready: "hello-00002", reason: "RevisionFailed" },
    });
    const { targets, asked } = trafficSplit(service);
    expect(asked).toBe(false);
    expect(targets.map((t) => [t.revisionName, t.percent, t.tag, t.latestRevision])).toEqual([
      ["hello-00001", 20, "v1", false],
      ["hello-00002", 80, undefined, true],
    ]);
  });

  it("a revision scaled to zero is ready; a failing container is said so", () => {
    expect(explain(REVISION, oldRevision!)).toEqual({ key: "revisionScaledToZero" });
    // `Active` False (no traffic) is never the failure.
    expect(failingCondition(oldRevision!)).toBeUndefined();
    expect(explain(REVISION, failedRevision!)).toEqual({ key: "revisionContainerUnhealthy", params: { reason: "ExitCode1" } });
  });
});

describe("problems", () => {
  it("a Service that is not ready is one, with Knative's message naming the failed revision", () => {
    const [p] = knativeProblems(KSERVICE, service);
    expect(p).toMatchObject({ reason: "RevisionFailed", notify: true, graceMs: 2 * 60_000 });
    expect(p!.message).toMatch(/hello-00003/);
    const [resolved] = resolve(KSERVICE, service, Date.parse("2026-10-20T00:00:00Z"));
    expect(resolved?.category).toBe("knative");
  });

  it("revisions are not watched; a Configuration a Service made is told through the Service; progress is no problem", () => {
    expect(knativeProblems(REVISION, failedRevision!)).toEqual([]);
    const owned = copy(service);
    owned.kind = "Configuration";
    owned.metadata!.ownerReferences = [{ apiVersion: "serving.knative.dev/v1", kind: "Service", name: "hello", uid: "x" }];
    expect(knativeProblems(CONFIGURATION, owned)).toEqual([]);
    delete owned.metadata!.ownerReferences;
    expect(knativeProblems(CONFIGURATION, owned)).toHaveLength(1);
    const rolling = copy(service);
    for (const c of (rolling.status as { conditions: { status: string }[] }).conditions) c.status = "Unknown";
    expect(knativeProblems(KSERVICE, rolling)).toEqual([]);
  });

  it("the tables offer the problem filter", () => {
    expect(getResourceDef(KSERVICE).problem?.(service)).toBe(true);
    expect(getResourceDef(REVISION).problem?.(oldRevision!)).toBe(false);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const BUILT_IN: KindRef[] = [{ group: "", version: "v1", kind: "Pod" }];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [...BUILT_IN, KSERVICE, CONFIGURATION, REVISION, ROUTE];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Knative section", () => {
  it("lists the kinds the cluster serves and counts the Services that need attention", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Knative"));
    fireEvent.click(screen.getByRole("button", { name: /Knative/ }));
    const section = within(screen.getByRole("button", { name: /Knative/ }).closest("li")!);
    for (const label of ["Services", "Configurations", "Revisions", "Routes"]) expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Domain Mappings" })).toBeNull();
    expect(discovery.some((k) => k.kind === DOMAIN_MAPPING.kind)).toBe(false);
    emitSnapshot(wb, await watchOf(wb, "Service", (spec) => spec.kind.group === "serving.knative.dev"), [service]);
    emitSnapshot(wb, await watchOf(wb, "Configuration"), []);
    await waitFor(() => expect(screen.getByTitle("1 Knative object needs attention")).toHaveTextContent("1"));
  });

  it("is not there without Knative", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Knative");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return { kind: { group: group!, version: version!, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const section = (id: string) => within(document.querySelector<HTMLElement>(`[data-section='${id}']`)!);

describe("details", () => {
  it("of a Service: why it is not ready, the revisions and the traffic split with links", async () => {
    await openDetails(service);
    const kn = section("knative");
    await waitFor(() => expect(kn.getByText(/The latest revision hello-00003 failed \(RevisionFailed\)\. Traffic stays on hello-00002/)).toBeInTheDocument());
    expect(kn.getByText("http://hello.default.example.com")).toBeInTheDocument();
    expect(kn.getByRole("button", { name: "Open Revision hello-00003" })).toBeInTheDocument();
    expect(kn.getByRole("button", { name: "Open Revision hello-00001" })).toBeInTheDocument();
    expect(kn.getByText("20%")).toBeInTheDocument();
    expect(kn.getByText("v1")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of a Revision: the failing container, its Configuration and replicas", async () => {
    await openDetails(failedRevision!);
    const kn = section("knative");
    await waitFor(() => expect(kn.getByText(/The container does not start or fails its health checks \(ExitCode1\)/)).toBeInTheDocument());
    expect(kn.getByRole("button", { name: "Open Configuration hello" })).toBeInTheDocument();
    expect(kn.getByText("0 of 1")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
