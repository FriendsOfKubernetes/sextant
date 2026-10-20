import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import "../logs";
import { resetProblemSources } from "../problems/store";
import cronJson from "./fixtures/cronworkflow.json";
import containerSetJson from "./fixtures/workflow-container-set.json";
import workflowJson from "./fixtures/workflow-dag-failed.json";
import "./index";
import {
  CLUSTER_WORKFLOW_TEMPLATE,
  CRON_WORKFLOW,
  failedNode,
  FAILED_SELECTOR,
  fnv32a,
  MAX_FAILED_WORKFLOWS,
  MAX_TREE_NODES,
  MAX_WORKFLOW_PROBLEMS,
  nodesOf,
  pathTo,
  podNameOf,
  progressOf,
  RECENT_FAILURE_MS,
  schedulesOf,
  treeRows,
  WORKFLOW,
  WORKFLOW_TEMPLATE,
} from "./model";
import { newFailedSeen, workflowProblems } from "./provider";

const workflow = workflowJson as unknown as KubeObject;
const cron = cronJson as unknown as KubeObject;
const NAME = "dag-diamond-x7k2p";
const C_ID = `${NAME}-2532386132`;

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const refTo = (obj: KubeObject): ObjectRef => ({ kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" });

describe("the Workflow model", () => {
  it("FNV-1a as Go's hash/fnv", () => {
    expect(fnv32a("")).toBe(2166136261);
    expect(fnv32a("a")).toBe(0xe40c292c);
    expect(`${NAME}-${fnv32a(`${NAME}.C`)}`).toBe(C_ID);
  });

  it("names pods as the controller does: v2 by template and hash, v1 by node id", () => {
    const nodes = nodesOf(workflow);
    const c = nodes.get(C_ID)!;
    expect(podNameOf(workflow, c)).toBe(`${NAME}-echo-2532386132`);
    expect(podNameOf(workflow, nodes.get(NAME)!)).toBeUndefined();
    const v1 = copy(workflow);
    v1.metadata!.annotations = { "workflows.argoproj.io/pod-name-format": "v1" };
    expect(podNameOf(v1, c)).toBe(C_ID);
    // Without the annotation the controller's default, v2.
    const none = copy(workflow);
    delete none.metadata!.annotations;
    expect(podNameOf(none, c)).toBe(`${NAME}-echo-2532386132`);
    // A node id that does not start with the workflow name: the hash of the node name.
    expect(podNameOf(workflow, { ...c, id: "other-1" })).toBe(`${NAME}-echo-${fnv32a(c.name)}`);
  });

  it("names a container-set container's pod after its boundary Pod node", () => {
    const wf = containerSetJson as unknown as KubeObject;
    const nodes = nodesOf(wf);
    const POD = "build-cs-q7v2n-build-set-601456081";
    const pod = nodes.get("build-cs-q7v2n-601456081")!;
    const test = nodes.get("build-cs-q7v2n-3423757485")!;
    const compile = nodes.get("build-cs-q7v2n-1513831638")!;
    expect(podNameOf(wf, pod, nodes)).toBe(POD);
    expect(podNameOf(wf, test, nodes)).toBe(POD);
    expect(podNameOf(wf, compile, nodes)).toBe(POD);
    expect(failedNode(wf, nodes)?.displayName).toBe("test");
    // The template and the name the hash falls back to are the boundary node's, not the container node's.
    const bare = { ...test, templateName: undefined, raw: {} };
    expect(podNameOf(wf, bare, nodes)).toBe(POD);
    const renamed = new Map(nodes);
    renamed.set("other-1", { ...pod, id: "other-1" });
    expect(podNameOf(wf, { ...test, boundaryID: "other-1" }, renamed)).toBe(`build-cs-q7v2n-build-set-${fnv32a(pod.name)}`);
    const v1 = copy(wf);
    v1.metadata!.annotations = { "workflows.argoproj.io/pod-name-format": "v1" };
    expect(podNameOf(v1, test, nodes)).toBe("build-cs-q7v2n-601456081");
  });

  it("finds the failed step, the progress and the tree, collapsed below the root and bounded", () => {
    const nodes = nodesOf(workflow);
    expect(failedNode(workflow, nodes)?.displayName).toBe("C");
    expect(progressOf(workflow)).toBe("2/3");
    expect(treeRows(workflow, nodes, new Set([NAME])).map((r) => r.node.displayName)).toEqual([NAME, "A"]);
    const path = pathTo(workflow, nodes, C_ID);
    expect(treeRows(workflow, nodes, new Set(path)).map((r) => [r.node.displayName, r.depth])).toEqual([
      [NAME, 0],
      ["A", 1],
      ["B", 2],
      ["C", 2],
    ]);
    const big = copy(workflow);
    const many: Record<string, unknown> = { [NAME]: { id: NAME, name: NAME, type: "Steps", children: [] as string[] } };
    for (let i = 0; i < MAX_TREE_NODES + 50; i++) {
      (many[NAME] as { children: string[] }).children.push(`n${i}`);
      many[`n${i}`] = { id: `n${i}`, name: `n${i}`, type: "Pod" };
    }
    (big.status as Record<string, unknown>).nodes = many;
    expect(treeRows(big, nodesOf(big), new Set([NAME]))).toHaveLength(MAX_TREE_NODES);
  });

  it("a CronWorkflow's schedules", () => {
    expect(schedulesOf(cron)).toEqual(["0 2 * * *"]);
    expect(schedulesOf({ spec: { schedule: "*/5 * * * *" } } as KubeObject)).toEqual(["*/5 * * * *"]);
  });

  it("problems: failed Workflows created within a day, until a day has passed", () => {
    const meta = (phase: string, created: string): KubeObject => ({
      metadata: { name: `w-${phase}`, namespace: "argo", uid: `u-${phase}-${created}`, creationTimestamp: created, labels: { "workflows.argoproj.io/phase": phase } },
    });
    const now = Date.parse("2026-10-20T12:00:00Z");
    const { problems: found, truncated } = workflowProblems(
      [meta("Failed", "2026-10-20T09:00:00Z"), meta("Error", "2026-10-20T10:00:00Z"), meta("Succeeded", "2026-10-20T10:00:00Z"), meta("Failed", "2026-10-18T10:00:00Z")],
      now,
      newFailedSeen(),
    );
    // The most recent failure first.
    expect(found.map((p) => [p.reason, p.category])).toEqual([
      ["Error", "workflows"],
      ["Failed", "workflows"],
    ]);
    expect(truncated).toBe(false);
    expect(found[1]?.until).toBe(Date.parse("2026-10-21T09:00:00Z"));
    expect(FAILED_SELECTOR).toBe("workflows.argoproj.io/phase in (Failed,Error)");
  });

  it("problems: a long-running Workflow failing while watched counts from its failure, not its creation", () => {
    const wf = (name: string, created: string, phase = "Failed"): KubeObject => ({
      metadata: { name, namespace: "argo", uid: name, creationTimestamp: created, labels: { "workflows.argoproj.io/phase": phase } },
    });
    const memory = newFailedSeen();
    const start = Date.parse("2026-10-20T12:00:00Z");
    // At the first look an old failure is not recent (its failure time is unknown: creation counts).
    expect(workflowProblems([wf("old", "2026-10-15T00:00:00Z")], start, memory).problems).toEqual([]);
    // Three days after it started, a long-running Workflow enters the failed list while the source watches.
    const later = start + 60_000;
    const { problems } = workflowProblems([wf("old", "2026-10-15T00:00:00Z"), wf("long", "2026-10-17T12:00:00Z")], later, memory);
    expect(problems.map((p) => p.object.name)).toEqual(["long"]);
    expect(problems[0]?.since).toBe(new Date(later).toISOString());
    expect(problems[0]?.until).toBe(later + RECENT_FAILURE_MS);
    expect(workflowProblems([wf("long", "2026-10-17T12:00:00Z")], later + RECENT_FAILURE_MS, memory).problems).toEqual([]);
  });

  it("problems: the newest failures are kept past the cap, wherever they are in the list", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    // Listed in name order: the oldest failures first, the newest last.
    const items: KubeObject[] = Array.from({ length: MAX_WORKFLOW_PROBLEMS + 10 }, (_, i) => ({
      metadata: {
        name: `w-${String(i).padStart(4, "0")}`,
        namespace: "argo",
        uid: `u${i}`,
        creationTimestamp: new Date(now - (MAX_WORKFLOW_PROBLEMS + 10 - i) * 60_000).toISOString(),
        labels: { "workflows.argoproj.io/phase": "Failed" },
      },
    }));
    const { problems, truncated } = workflowProblems(items, now, newFailedSeen());
    expect(truncated).toBe(true);
    expect(problems).toHaveLength(MAX_WORKFLOW_PROBLEMS);
    expect(problems[0]?.object.name).toBe(`w-${String(MAX_WORKFLOW_PROBLEMS + 9).padStart(4, "0")}`);
    expect(problems.some((p) => p.object.name === "w-0000")).toBe(false);
    expect(MAX_FAILED_WORKFLOWS).toBeGreaterThanOrEqual(5000);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const BUILT_IN: KindRef[] = [{ group: "", version: "v1", kind: "Pod" }];
const WORKFLOWS: KindRef[] = [WORKFLOW, CRON_WORKFLOW, WORKFLOW_TEMPLATE, CLUSTER_WORKFLOW_TEMPLATE];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  discovery = [...BUILT_IN, ...WORKFLOWS];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "ClusterWorkflowTemplate")));
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sectionNames = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Argo Workflows section", () => {
  it("lists the kinds the cluster serves", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionNames()).toContain("Argo Workflows"));
    fireEvent.click(screen.getByRole("button", { name: /Argo Workflows/ }));
    const section = within(screen.getByRole("button", { name: /Argo Workflows/ }).closest("li")!);
    for (const label of ["Workflows", "Cron Workflows", "Workflow Templates", "Cluster Workflow Templates"]) {
      expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("counts recent failed workflows from one metadata-only watch of failed ones", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sectionNames()).toContain("Argo Workflows"));
    const id = await watchOf(wb, "Workflow", (s) => s.labelSelector === FAILED_SELECTOR);
    expect(wb.specs.get(id)).toMatchObject({ namespaces: null, metadataOnly: true });
    const recent = copy(workflow);
    recent.metadata!.creationTimestamp = new Date(Date.now() - 3600_000).toISOString();
    emitSnapshot(wb, id, [{ apiVersion: recent.apiVersion, kind: recent.kind, metadata: recent.metadata }]);
    await waitFor(() => expect(screen.getByTitle("1 workflow failed recently")).toHaveTextContent("1"));
  });

  it("the Workflows table shows phase, progress, duration and the failed step", () => {
    const def = getResourceDef(WORKFLOW);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "phase", "progress", "duration", "failedStep", "age"]);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(col("phase").value(workflow)).toBe("Failed");
    expect(col("progress").value(workflow)).toBe("2/3");
    expect(col("duration").value(workflow)).toBe(41_000);
    expect(col("failedStep").value(workflow)).toBe("C: Error (exit code 1)");
  });
});

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

describe("details", () => {
  it("of a failed Workflow: the failed step, the tree collapsed, then down to the failed pod and its logs", async () => {
    const pod = { apiVersion: "v1", kind: "Pod", metadata: { name: `${NAME}-echo-2532386132`, namespace: "argo", uid: "p1" }, spec: { containers: [{ name: "main" }, { name: "wait" }] } };
    wb.backend.on("resource_get", () => pod);
    await openDetails(workflow);
    const view = within(section("argoWorkflows"));
    expect(view.getAllByText("Error (exit code 1)").length).toBeGreaterThan(0);
    expect(view.getByRole("button", { name: "Open CronWorkflow nightly-diamond" })).toBeInTheDocument();
    const tree = () => within(section("argoWorkflows").querySelector<HTMLElement>(".aw-tree")!);
    expect(tree().queryByText("C")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show the failed step" }));
    expect(tree().getByText("C")).toBeInTheDocument();
    expect(view.getByRole("button", { name: `Open Pod ${NAME}-echo-2532386132` })).toBeInTheDocument();
    expect(await axeViolations(section("argoWorkflows"))).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: `Logs of ${NAME}-echo-2532386132` }));
    await waitFor(() => expect(useAppStore.getState().dock.tabs.some((t) => t.type === "logs" && t.title === `${NAME}-echo-2532386132`)).toBe(true));
    fireEvent.click(view.getByRole("button", { name: "Collapse all" }));
    expect(tree().queryByText("C")).toBeNull();
  });

  it("of a CronWorkflow: schedule, time zone, last run and the active workflows", async () => {
    await openDetails(cron);
    const view = within(section("argoWorkflows"));
    expect(view.getByText("0 2 * * *")).toBeInTheDocument();
    expect(view.getByText("Europe/Berlin")).toBeInTheDocument();
    expect(view.getByRole("button", { name: "Open Workflow nightly-diamond-1760925600" })).toBeInTheDocument();
    expect(await axeViolations(section("argoWorkflows"))).toEqual([]);
  });
});
