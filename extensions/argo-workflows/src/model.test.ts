// The model, the patches and the manifest's declarative parts. The manifest's problem rules, action conditions and
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at
// run time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view, ported unchanged.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import cronJson from "../fixtures/cronworkflow.json";
import containerSetJson from "../fixtures/workflow-container-set.json";
import failedJson from "../fixtures/workflow-dag-failed.json";
import suspendedJson from "../fixtures/workflow-suspended.json";
import {
  activeWorkflows,
  failedAt,
  failedNode,
  failedStepText,
  FAILED_SELECTOR,
  fnv32a,
  isFailedPhase,
  lastScheduled,
  MAX_TREE_NODES,
  nodesOf,
  pathTo,
  podNameOf,
  progressOf,
  RECENT_FAILURE_MS,
  schedulesOf,
  templateSummary,
  treeRows,
  workflowDuration,
  workflowPhase,
} from "./model";
import { ACTION_IDS, APPLIES, nowStamp, patchToSend, planFor, type WorkflowAction } from "./patches";

const workflow = failedJson as unknown as KubeObject;
const containerSet = containerSetJson as unknown as KubeObject;
const suspended = suspendedJson as unknown as KubeObject;
const cron = cronJson as unknown as KubeObject;
const NAME = "dag-diamond-x7k2p";
const C_ID = `${NAME}-2532386132`;
const W = "suspend-template-kxt9w";
const APPROVE = `${W}-1879311160`;
const ACTOR_NULLS = { "workflows.argoproj.io/actor": null, "workflows.argoproj.io/action": null };

const copy = <T>(value: T): T => structuredClone(value);
const st = (obj: KubeObject) => obj.status as Record<string, unknown>;
const spec = (obj: KubeObject) => obj.spec as Record<string, unknown>;
const nodeOf = (obj: KubeObject, id: string) => (st(obj).nodes as Record<string, Record<string, unknown>>)[id]!;

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  activeFrom?: number;
  until?: number;
  notify: boolean;
  notifyAs?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject, ctx?: { enteredAt?: number }): Verdict;
  detectRule(rule: unknown, obj: KubeObject, ctx?: { enteredAt?: number }): Detected[];
}
/** The window's computed column (src/extensions/columns.tsx). */
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const holdsNow = (condition: unknown, obj: KubeObject, now = Date.now()) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.argo-workflows:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
/** A cell's text, as the window searches and copies it; durations and ages as `common:age.<unit>:<count>`. */
const cell = (id: string, obj: KubeObject, now = Date.now()) => windowColumn(id).searchText(obj, { now, t: T }) ?? undefined;
/** A cell's hover: the `title` the window wraps it in. */
function hover(id: string, obj: KubeObject, now = Date.now()): string | undefined {
  const drawn = windowColumn(id).render(obj, { now }) as { props?: { title?: string } } | null;
  return drawn?.props?.title;
}

const ACTIONS = Object.keys(ACTION_IDS) as WorkflowAction[];
const actionOf = (action: WorkflowAction) => manifest.contributes.actions.find((a) => a.id === ACTION_IDS[action])!;

// ---------- The model ----------

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
    v1.metadata.annotations = { "workflows.argoproj.io/pod-name-format": "v1" };
    expect(podNameOf(v1, c)).toBe(C_ID);
    // Without the annotation the controller's default, v2.
    const none = copy(workflow);
    delete none.metadata.annotations;
    expect(podNameOf(none, c)).toBe(`${NAME}-echo-2532386132`);
    // A node id that does not start with the workflow name: the hash of the node name.
    expect(podNameOf(workflow, { ...c, id: "other-1" })).toBe(`${NAME}-echo-${fnv32a(c.name)}`);
  });

  it("cuts a long v2 pod name to 253 characters, keeping the hash", () => {
    const long = copy(workflow);
    long.metadata.name = "w".repeat(200);
    const node = { ...nodesOf(workflow).get(C_ID)!, id: `${"w".repeat(200)}-2532386132`, templateName: "t".repeat(100) };
    const pod = podNameOf(long, node)!;
    expect(pod).toHaveLength(253);
    expect(pod.endsWith("-2532386132")).toBe(true);
  });

  it("names a container-set container's pod after its boundary Pod node", () => {
    const nodes = nodesOf(containerSet);
    const POD = "build-cs-q7v2n-build-set-601456081";
    const pod = nodes.get("build-cs-q7v2n-601456081")!;
    const test = nodes.get("build-cs-q7v2n-3423757485")!;
    const compile = nodes.get("build-cs-q7v2n-1513831638")!;
    expect(podNameOf(containerSet, pod, nodes)).toBe(POD);
    expect(podNameOf(containerSet, test, nodes)).toBe(POD);
    expect(podNameOf(containerSet, compile, nodes)).toBe(POD);
    expect(failedNode(containerSet, nodes)?.displayName).toBe("test");
    // The template and the name the hash falls back to are the boundary node's, not the container node's.
    const bare = { ...test, templateName: undefined, raw: {} };
    expect(podNameOf(containerSet, bare, nodes)).toBe(POD);
    const renamed = new Map(nodes);
    renamed.set("other-1", { ...pod, id: "other-1" });
    expect(podNameOf(containerSet, { ...test, boundaryID: "other-1" }, renamed)).toBe(`build-cs-q7v2n-build-set-${fnv32a(pod.name)}`);
    const v1 = copy(containerSet);
    v1.metadata.annotations = { "workflows.argoproj.io/pod-name-format": "v1" };
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
    st(big).nodes = many;
    expect(treeRows(big, nodesOf(big), new Set([NAME]))).toHaveLength(MAX_TREE_NODES);
  });

  it("a CronWorkflow's schedules, active runs and templates", () => {
    expect(schedulesOf(cron)).toEqual(["0 2 * * *"]);
    expect(schedulesOf({ metadata: { name: "x" }, spec: { schedule: "*/5 * * * *" } })).toEqual(["*/5 * * * *"]);
    expect(activeWorkflows(cron)).toEqual([{ name: "nightly-diamond-1760925600", namespace: "argo" }]);
    expect(templateSummary(cron)).toEqual({ entrypoint: "diamond", templates: ["diamond", "echo"] });
  });
});

// ---------- The patches ----------

/** The fixture without `spec.suspend`: waiting only at its `approve` suspend step. */
function atApproval(): KubeObject {
  const wf = copy(suspended);
  delete spec(wf).suspend;
  return wf;
}

describe("the patches, as util.go builds them", () => {
  it("suspend: spec.suspend with the actor labels removed (no claims), versioned; refused once completed", () => {
    const plan = planFor("suspend", atApproval());
    expect(plan).toEqual({ versioned: true, stamped: [], patch: { metadata: { labels: ACTOR_NULLS }, spec: { suspend: true } } });
    expect(patchToSend(plan, "48211", "2026-10-21T10:00:00Z")).toEqual({
      metadata: { resourceVersion: "48211", labels: ACTOR_NULLS },
      spec: { suspend: true },
    });
    expect(planFor("suspend", suspended).patch).toBeUndefined();
    expect(planFor("suspend", workflow).refusal).toEqual({ reason: "completed" });
  });

  it("resume: lifts spec.suspend and marks the running suspend node Succeeded at the time of sending", () => {
    const plan = planFor("resume", suspended);
    expect(plan.stamped).toEqual([APPROVE]);
    expect(patchToSend(plan, "48211", "2026-10-21T10:00:00Z")).toEqual({
      metadata: { resourceVersion: "48211", labels: ACTOR_NULLS },
      spec: { suspend: null },
      status: { nodes: { [APPROVE]: { phase: "Succeeded", finishedAt: "2026-10-21T10:00:00Z" } } },
    });
    const wf = atApproval();
    nodeOf(wf, APPROVE).message = "waiting for approval";
    expect(planFor("resume", wf).patch).toEqual({
      metadata: { labels: ACTOR_NULLS },
      status: { nodes: { [APPROVE]: { phase: "Succeeded", message: "waiting for approval; " } } },
    });
    expect(nowStamp(new Date("2026-10-21T10:00:00.123Z"))).toBe("2026-10-21T10:00:00Z");
  });

  it("resume: a supplied output takes valueFrom.default and is exported to the global outputs; no default refuses", () => {
    const wf = atApproval();
    nodeOf(wf, APPROVE).outputs = {
      parameters: [{ name: "message", globalName: "approval", valueFrom: { supplied: {}, default: "approved" } }],
    };
    st(wf).outputs = { parameters: [{ name: "other", value: "x" }] };
    expect(planFor("resume", wf).patch).toEqual({
      metadata: { labels: ACTOR_NULLS },
      status: {
        nodes: {
          [APPROVE]: {
            phase: "Succeeded",
            outputs: { parameters: [{ name: "message", globalName: "approval", valueFrom: { supplied: {}, default: "approved" }, value: "approved" }] },
          },
        },
        outputs: { parameters: [{ name: "other", value: "x" }, { name: "approval", value: "approved" }] },
      },
    });
    const params = (nodeOf(wf, APPROVE).outputs as { parameters: Record<string, unknown>[] }).parameters;
    params[0] = { name: "message", default: "approved", globalName: "approval", valueFrom: { supplied: {} } };
    expect(planFor("resume", wf)).toMatchObject({ refusal: { reason: "noDefault", step: "approve", parameter: "message" } });
  });

  it("resume: refused when the nodes are compressed or offloaded; nothing when nothing waits", () => {
    const compressed = copy(suspended);
    st(compressed).compressedNodes = "H4sIAAAAAAAA/6quBQQAAP//";
    expect(planFor("resume", compressed).refusal).toEqual({ reason: "nodesElsewhere" });
    expect(planFor("resume", workflow)).toEqual({ versioned: true, stamped: [] });
  });

  it("stop and terminate: spec.shutdown, unversioned and without labels; refused once finished", () => {
    expect(planFor("stop", suspended)).toEqual({ versioned: false, stamped: [], patch: { spec: { shutdown: "Stop" } } });
    expect(planFor("terminate", suspended).patch).toEqual({ spec: { shutdown: "Terminate" } });
    const stopping = copy(suspended);
    spec(stopping).shutdown = "Stop";
    expect(planFor("stop", stopping).patch).toBeUndefined();
    expect(planFor("terminate", stopping).patch).toEqual({ spec: { shutdown: "Terminate" } });
    expect(planFor("stop", workflow).refusal).toEqual({ reason: "finished" });
  });
});

// ---------- The manifest, as Sextant judges it ----------

/** Workflows in every state the actions tell apart. */
function states(): Record<string, KubeObject> {
  const running = atApproval();
  st(running).nodes = {};
  const waiting = atApproval();
  const stopping = copy(suspended);
  spec(stopping).shutdown = "Stop";
  const terminating = atApproval();
  spec(terminating).shutdown = "Terminate";
  const succeeded = copy(running);
  st(succeeded).phase = "Succeeded";
  const errored = copy(workflow);
  st(errored).phase = "Error";
  // Completed by the label while the phase still says Running (the controller sets both; Suspend reads the label).
  const labelled = copy(running);
  labelled.metadata.labels = { ...labelled.metadata.labels, "workflows.argoproj.io/completed": "true" };
  const pending = copy(running);
  delete st(pending).phase;
  return { suspended, failed: workflow, containerSet, running, waiting, stopping, terminating, succeeded, errored, labelled, pending };
}

describe("the manifest's action conditions", () => {
  it("offer each action exactly where the built-in view offered it", () => {
    for (const [name, wf] of Object.entries(states())) {
      for (const action of ACTIONS) expect(holdsNow(actionOf(action).when, wf), `${action} on ${name}`).toBe(APPLIES[action](wf));
    }
  });

  it("offer what the built-in view offered on the fixtures", () => {
    const offered = (wf: KubeObject) => ACTIONS.filter((a) => holdsNow(actionOf(a).when, wf));
    expect(offered(suspended)).toEqual(["resume", "stop", "terminate"]);
    expect(offered(states().running!)).toEqual(["suspend", "stop", "terminate"]);
    expect(offered(workflow)).toEqual([]);
  });

  it("are placed as the built-in buttons were: Terminate in Actions; Stop and Terminate dangerous; on Workflows only", () => {
    const placement = Object.fromEntries(manifest.contributes.actions.map((a) => [a.id, a.placement]));
    expect(placement).toEqual({ suspend: "primary", resume: "primary", stop: "primary", terminate: "more" });
    expect(manifest.contributes.actions.filter((a) => (a as { danger?: boolean }).danger).map((a) => a.id)).toEqual(["stop", "terminate"]);
    expect(manifest.contributes.actions.every((a) => a.kinds.length === 1 && a.kinds[0]!.kind === "Workflow")).toBe(true);
    expect(manifest.contributes.actions.map((a) => a.icon)).toEqual(["suspend", "resume", "terminate", "rolloutAbort"]);
  });

  it("change Workflows without a second question, as the built-in window was the only one", () => {
    const modify = manifest.permissions.rules.find((r) => r.actions.includes("modify"))!;
    expect(modify).toMatchObject({ kinds: { type: "only", kinds: [{ group: "argoproj.io", kind: "Workflow" }] }, confirm: false });
  });
});

/** A failed Workflow as the problems source lists it: metadata only. */
const listed = (phase: string, created: number, labels: Record<string, string> = {}): KubeObject => ({
  apiVersion: "argoproj.io/v1alpha1",
  kind: "Workflow",
  metadata: {
    name: "wf",
    namespace: "argo",
    uid: "u1",
    creationTimestamp: new Date(created).toISOString(),
    labels: { "workflows.argoproj.io/phase": phase, ...labels },
  },
});

const rules = manifest.contributes.problems;
/** The problems the manifest's rules find, as Sextant judges them. */
const detected = (obj: KubeObject, enteredAt?: number) =>
  rules.flatMap((rule) =>
    engine.detectRule({ notify: true, toldThroughOwner: false, graceMinutes: 0, ...rule }, obj, enteredAt === undefined ? {} : { enteredAt }),
  );
const activeAt = (d: Detected, now: number) => (d.activeFrom === undefined || d.activeFrom <= now) && (d.until === undefined || d.until > now);

describe("the manifest's problem rules", () => {
  it("watch only the failed and errored Workflows, metadata only, as the built-in source did", () => {
    for (const rule of rules) {
      expect(rule.kind).toEqual({ group: "argoproj.io", kind: "Workflow" });
      expect(rule.source).toEqual({ labelSelector: FAILED_SELECTOR, metadataOnly: true });
    }
  });

  it("count a failure for a day from when Sextant saw it fail, else from the Workflow's creation", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const hours = (n: number) => now - n * 3600_000;
    let counted = 0;
    for (const phase of ["Failed", "Error", "Succeeded", "Running"]) {
      for (const created of [hours(1), hours(23), hours(25), hours(72)]) {
        for (const entered of [undefined, hours(0.1), hours(23), hours(25)]) {
          if (entered !== undefined && entered < created) continue;
          const wf = listed(phase, created);
          const builtIn = failedAt(wf, entered);
          const found = detected(wf, entered).filter((d) => activeAt(d, now));
          const name = `${phase}, created ${new Date(created).toISOString()}, entered ${entered === undefined ? "-" : new Date(entered).toISOString()}`;
          if (!builtIn || builtIn.until <= now) {
            expect(found, name).toEqual([]);
            continue;
          }
          expect(found, name).toHaveLength(1);
          expect(found[0], name).toMatchObject({ reason: phase, group: "failed", until: builtIn.until, notify: true });
          expect(Date.parse(found[0]!.since!), name).toBe(builtIn.since);
          counted++;
        }
      }
    }
    // Failed and Error alike: created an hour or 23 hours ago (whenever seen failing), or older and seen failing lately.
    expect(counted).toBe(2 * (2 + 3 + 2 + 2));
    expect(RECENT_FAILURE_MS).toBe(1440 * 60_000);
  });

  it("notify the runs of one CronWorkflow as one, and a Workflow of its own as itself", () => {
    const now = Date.now();
    const run = listed("Failed", now - 60_000, { "workflows.argoproj.io/cron-workflow": "nightly-diamond" });
    expect(detected(run).map((d) => d.notifyAs)).toEqual(["argoproj.io/Workflow/argo/nightly-diamond"]);
    expect(detected(listed("Failed", now - 60_000)).map((d) => d.notifyAs)).toEqual([undefined]);
    expect(detected(run)[0]?.message).toBe("The workflow ended Failed: its failed step and message are in its details.");
  });

  it("are counted on the section, and the table's Only problems shows every failed or errored Workflow", () => {
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "argoWorkflows" }]);
    const kind = manifest.contributes.kinds.find((k) => k.kind === "Workflow")!;
    for (const [name, wf] of Object.entries(states())) {
      expect(holdsNow(kind.problemWhen, wf), name).toBe(isFailedPhase(workflowPhase(wf)));
    }
  });
});

describe("the manifest's section and kinds", () => {
  it("are the built-in section's: its title, icon and kinds in order, after Velero, without the CRDs' printer columns", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "argoWorkflows", title: "Argo Workflows", icon: "argoWorkflows", after: "velero" }]);
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.title, k.icon, k.order])).toEqual([
      ["Workflow", "Workflows", "argoWorkflow", 10],
      ["CronWorkflow", "Cron Workflows", "argoCronWorkflow", 20],
      ["WorkflowTemplate", "Workflow Templates", "argoWorkflowTemplate", 30],
      ["ClusterWorkflowTemplate", "Cluster Workflow Templates", "argoClusterWorkflowTemplate", 40],
    ]);
    expect(manifest.contributes.kinds.every((k) => k.section === "argoWorkflows" && k.printerColumns === false)).toBe(true);
  });
});

describe("the manifest's columns", () => {
  const joined = (wf: KubeObject) => failedStepText(wf, (step, message) => `${step}: ${message}`);

  it("of Workflows: phase, progress, duration and the failed step, after Name and Namespace", () => {
    const ids = manifest.contributes.columns.filter((c) => c.kind.kind === "Workflow").map((c) => [c.id, c.afterColumn]);
    expect(ids).toEqual([
      ["workflow-phase", "namespace"],
      ["workflow-progress", "workflow-phase"],
      ["workflow-duration", "workflow-progress"],
      ["workflow-failed-step", "workflow-duration"],
    ]);
    for (const wf of [workflow, containerSet, suspended]) {
      expect(cell("workflow-phase", wf)).toBe(workflowPhase(wf));
      expect(cell("workflow-progress", wf)).toBe(progressOf(wf));
      expect(cell("workflow-failed-step", wf)).toBe(joined(wf));
      expect(hover("workflow-failed-step", wf)).toBe(joined(wf));
    }
    expect(cell("workflow-failed-step", workflow)).toBe("C: Error (exit code 1)");
    expect(cell("workflow-failed-step", containerSet)).toBe("test: Error (exit code 1)");
    expect(cell("workflow-failed-step", suspended)).toBeUndefined();
    expect(windowColumn("workflow-duration").value(workflow)).toBe(41_000);
    expect(windowColumn("workflow-duration").value(workflow)).toBe(workflowDuration(workflow, Date.now()));
    // A running one counts to now.
    const now = Date.parse("2026-10-20T09:05:00Z");
    expect(cell("workflow-duration", suspended, now)).toBe("common:age.minutes:5");
    expect(workflowDuration(suspended, now)).toBe(300_000);
  });

  it("colour the phase as the built-in view did", () => {
    const tones = columnOf("workflow-phase").tones as Record<string, string>;
    expect(tones).toEqual({ Pending: "neutral", Running: "neutral", Succeeded: "ok", Failed: "error", Error: "error" });
  });

  it("find the failed step as the built-in view did, in every shape the controller writes", () => {
    const variants: Record<string, (wf: KubeObject) => void> = {
      // A one-pod Workflow: its root is its Pod node, which is not a step; the Workflow's message is shown.
      onePod: (wf) => {
        st(wf).nodes = { [wf.metadata.name]: { id: wf.metadata.name, name: wf.metadata.name, displayName: wf.metadata.name, type: "Pod", phase: "Failed", message: "Error (exit code 2)" } };
        st(wf).message = "Error (exit code 2)";
      },
      errored: (wf) => {
        st(wf).phase = "Error";
        nodeOf(wf, C_ID).phase = "Error";
        nodeOf(wf, C_ID).message = "pod deleted";
      },
      // A failed step without a message: the Workflow's message.
      noNodeMessage: (wf) => void delete nodeOf(wf, C_ID).message,
      // No nodes: the Workflow's message (a spec the controller refused).
      noNodes: (wf) => {
        delete st(wf).nodes;
        st(wf).message = "invalid spec: templates.diamond.tasks.A template reference echo2 not found";
      },
      // An HTTP template's step.
      http: (wf) => {
        nodeOf(wf, C_ID).type = "HTTP";
      },
      // Still running with a failed step (retries, continueOn): no failed step yet.
      running: (wf) => void (st(wf).phase = "Running"),
      noFailure: (wf) => {
        st(wf).phase = "Succeeded";
        nodeOf(wf, C_ID).phase = "Succeeded";
      },
    };
    for (const [name, change] of Object.entries(variants)) {
      const wf = copy(workflow);
      change(wf);
      expect(cell("workflow-failed-step", wf), name).toBe(joined(wf));
      expect(hover("workflow-failed-step", wf), name).toBe(joined(wf));
    }
  });

  it("differ where the README says: the first failed step by node id, and none without any message", () => {
    // Two failed pods: the built-in view named the one that finished first, the cases the first by node id.
    const two = copy(workflow);
    nodeOf(two, `${NAME}-2565941370`).phase = "Failed";
    nodeOf(two, `${NAME}-2565941370`).message = "OOMKilled (exit code 137)";
    expect(joined(two)).toBe("A: OOMKilled (exit code 137)");
    expect(cell("workflow-failed-step", two)).toBe("C: Error (exit code 1)");
    // A failed step with no message in a Workflow with none either: the built-in view named the step alone.
    const silent = copy(workflow);
    delete nodeOf(silent, C_ID).message;
    delete st(silent).message;
    expect(joined(silent)).toBe("C");
    expect(cell("workflow-failed-step", silent)).toBeUndefined();
  });

  it("write the failed step as each language does", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(translations.fr!["columns.workflow-failed-step.cases.0.text"]).toBe(
      '{{.status.nodes[type="Container",phase="Failed"].displayName}} : {{.status.nodes[type="Container",phase="Failed"].message}}',
    );
    expect(translations["zh-CN"]!["columns.workflow-failed-step.cases.0.text"]).toContain("}}：{{");
  });

  it("of CronWorkflows: schedule, suspension, active runs and the last run", () => {
    const now = Date.parse("2026-10-20T07:00:00Z");
    expect(cell("cron-schedule", cron)).toBe("0 2 * * *");
    const old = copy(cron);
    delete spec(old).schedules;
    spec(old).schedule = "*/5 * * * *";
    expect(cell("cron-schedule", old)).toBe(schedulesOf(old).join(", "));
    expect(cell("cron-suspended", cron)).toBeUndefined();
    const paused = copy(cron);
    spec(paused).suspend = true;
    expect(cell("cron-suspended", paused)).toBe("Yes");
    spec(paused).suspend = false;
    expect(cell("cron-suspended", paused)).toBeUndefined();
    expect(cell("cron-active", cron)).toBe(String(activeWorkflows(cron).length));
    const idle = copy(cron);
    delete st(idle).active;
    expect(cell("cron-active", idle)).toBe("0");
    expect(windowColumn("cron-active").value(idle)).toBe(0);
    expect(cell("cron-last-scheduled", cron, now)).toBe("common:age.hours:7");
    expect(Date.parse(lastScheduled(cron)!)).toBe(now - 7 * 3600_000);
  });

  it("of templates: the entrypoint and the number of templates", () => {
    const template = { apiVersion: "argoproj.io/v1alpha1", kind: "WorkflowTemplate", metadata: { name: "t", namespace: "argo" }, spec: { entrypoint: "main", templates: [{ name: "main" }, { name: "x" }] } };
    for (const prefix of ["template", "cluster-template"]) {
      expect(cell(`${prefix}-entrypoint`, template)).toBe(templateSummary(template).entrypoint);
      expect(cell(`${prefix}-templates`, template)).toBe("2");
      expect(cell(`${prefix}-templates`, { ...template, spec: {} })).toBe("0");
    }
    expect(columnOf("cluster-template-entrypoint").afterColumn).toBe("name");
  });
});
