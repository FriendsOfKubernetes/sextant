// The model and the manifest's declarative parts. The kinds' "Only problems" and the columns are judged here by
// Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the type check
// stays inside the extension) and compared with the model they replace — the reading of Sextant's former built-in
// view (ADR-0080), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import {
  AKS_NODE_CLASS,
  causeOf,
  claimState,
  disruptionOf,
  disruptionSettings,
  durationMs,
  EC2_NODE_CLASS,
  eventRow,
  isDisruptionEvent,
  isProblem,
  launchProblem,
  limitRows,
  limitsText,
  NODE_CLAIM,
  NODE_POOL,
  nodePoolOf,
  readyOf,
  readyTone,
  type KindRef,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const byName = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map(copy);
type Cond = { type: string; status?: string; reason?: string };

describe("the model", () => {
  it("reads limits, disruption settings and a NodeClaim's launch as the built-in view did", () => {
    expect(limitRows(byName("NodePool", "default"))).toEqual([
      { resource: "cpu", used: "12", limit: "1000", reached: false },
      { resource: "memory", used: "45.9GiB", limit: "1000GiB", reached: false },
    ]);
    expect(limitsText(byName("NodePool", "gpu"))).toBe("cpu 64/64, nvidia.com/gpu 8/8");
    expect(limitRows(byName("NodePool", "gpu")).every((l) => l.reached)).toBe(true);
    expect(disruptionSettings(byName("NodePool", "default"))).toEqual({
      consolidationPolicy: "WhenEmptyOrUnderutilized",
      consolidateAfter: "1m",
      expireAfter: "720h",
      budgets: [
        { nodes: "10%", reasons: [] },
        { nodes: "0", reasons: ["Drifted", "Underutilized"], schedule: "0 9 * * mon-fri", duration: "8h" },
      ],
    });
    expect(durationMs("1h30m")).toBe(5_400_000);
    expect(durationMs("Never")).toBeUndefined();
    expect(launchProblem(byName("NodeClaim", "default-launching"))?.key).toBe("karpenter.launching");
    expect(launchProblem(byName("NodeClaim", "gpu-failed"))).toEqual({ key: "karpenter.notLaunched", params: { reason: "InsufficientCapacity" }, tone: "danger" });
    expect(launchProblem(byName("NodeClaim", "spot-joining"))).toEqual({ key: "karpenter.notRegistered", params: { reason: "AwaitingReconciliation" }, tone: "warning" });
    expect(launchProblem(byName("NodeClaim", "default-init"))?.key).toBe("karpenter.notInitialized");
    expect(launchProblem(byName("NodeClaim", "default-abc12"))).toBeUndefined();
    expect(nodePoolOf(byName("NodeClaim", "spot-joining"))).toBe("spot");
  });

  it("tells why Karpenter disrupts a NodeClaim, and which events are about disruption", () => {
    const claim = byName("NodeClaim", "default-abc12");
    expect(disruptionOf(claim, byName("NodePool", "default")).map((p) => [p.key, p.params])).toEqual([
      ["karpenter.consolidatable", { policy: "WhenEmptyOrUnderutilized" }],
      ["karpenter.drifted", { reason: "NodeClassDrift" }],
      ["karpenter.doNotDisrupt", { annotation: "karpenter.sh/do-not-disrupt" }],
      ["karpenter.expiresAt", { time: "2026-11-19T08:00:00.000Z" }],
    ]);
    expect(disruptionOf(byName("NodeClaim", "default-init"), byName("NodePool", "default")).map((p) => p.key)).toEqual(["karpenter.empty", "karpenter.expired"]);
    expect(disruptionOf(byName("NodeClaim", "spot-joining"), undefined).map((p) => p.key)).toEqual(["karpenter.terminating"]);
    const events = ofKind("Event").map(eventRow);
    expect(events.map(isDisruptionEvent)).toEqual([true, true, true, false]);
    expect(events.map((e) => causeOf(`${e.reason} ${e.message}`))).toEqual(["other", "drift", "consolidation", "other"]);
  });
});

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
}
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

const holdsNow = (condition: unknown, obj: KubeObject) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && v.activeFrom === undefined && v.until === undefined;
};
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.karpenter:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = Date.parse("2026-10-22T14:00:00Z");
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
function tone(id: string, obj: KubeObject): string | undefined {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  if (node?.props?.title !== undefined) node = node.props.children as typeof node;
  return node?.props?.tone;
}

/** NodePools with every set of the usual limits, under, at and over them, in the units the cluster writes. */
function pools(): KubeObject[] {
  const out = ofKind("NodePool");
  const keys = ["cpu", "memory", "nodes", "nvidia.com/gpu", "ephemeral-storage"];
  // A limit and amounts under, at and over it, as Kubernetes writes them.
  const amounts: Record<string, [string, string[]]> = {
    cpu: ["10", ["3500m", "10", "10500m"]],
    memory: ["1000Gi", ["48093964Ki", "1048576000Ki", "1Ti"]],
    nodes: ["10", ["3", "10", "11"]],
    "nvidia.com/gpu": ["8", ["2", "8", "9"]],
    "ephemeral-storage": ["500Gi", ["100Gi", "500Gi", "600Gi"]],
  };
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    for (const used of [undefined, 0, 1, 2]) {
      const limits: Record<string, string> = {};
      const resources: Record<string, string> = {};
      // In key order, as the API server writes a map (the built-in column followed the object's order).
      [...keys].sort().forEach((k) => {
        const i = keys.indexOf(k);
        if (!(mask & (1 << i))) return;
        limits[k] = amounts[k]![0];
        if (used !== undefined) resources[k] = amounts[k]![1][(used + i) % 3]!;
      });
      out.push({ apiVersion: "karpenter.sh/v1", kind: "NodePool", metadata: { name: `p-${mask}-${used}` }, spec: { limits }, status: { resources } } as KubeObject);
    }
  }
  return out;
}

describe("the columns, against the built-in ones", () => {
  it("are placed after the name, in the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id, c.width]);
    expect(ids("NodePool")).toEqual([
      ["name", "np-node-class", "minmax(110px, 1fr)"],
      ["np-node-class", "np-nodes", "70px"],
      ["np-nodes", "np-limits", "minmax(160px, 2fr)"],
      ["np-limits", "np-consolidation", "minmax(120px, 1fr)"],
      ["np-consolidation", "np-ready", "80px"],
    ]);
    expect(ids("NodeClaim")).toEqual([
      ["name", "nc-node-pool", "minmax(100px, 1fr)"],
      ["nc-node-pool", "nc-instance-type", "minmax(100px, 1fr)"],
      ["nc-instance-type", "nc-capacity-type", "90px"],
      ["nc-capacity-type", "nc-zone", "minmax(90px, 1fr)"],
      ["nc-zone", "nc-node", "minmax(140px, 1.5fr)"],
      ["nc-node", "nc-state", "minmax(100px, 1fr)"],
      ["nc-state", "nc-ready", "80px"],
    ]);
    for (const k of ["EC2NodeClass", "AKSNodeClass"]) expect(ids(k).map(([, , width]) => width)).toEqual(["minmax(140px, 2fr)", "80px"]);
  });

  it("show a NodePool's node class, nodes, consolidation and Ready", () => {
    for (const pool of ofKind("NodePool")) {
      const s = pool.spec as { template?: { spec?: { nodeClassRef?: { name?: string } } }; disruption?: { consolidationPolicy?: string } };
      expect(cell("np-node-class", pool)).toBe(s.template?.spec?.nodeClassRef?.name);
      expect(cell("np-nodes", pool)).toBe((pool.status as { resources?: { nodes?: string } }).resources?.nodes);
      expect(cell("np-consolidation", pool)).toBe(disruptionSettings(pool).consolidationPolicy);
      const ready = readyOf(pool);
      expect(cell("np-ready", pool), pool.metadata.name).toBe(ready);
      if (ready) expect(tone("np-ready", pool)).toBe(readyTone(ready));
    }
  });

  it("show the usage against every limit as the built-in did, red when one is reached", () => {
    for (const pool of pools()) {
      const keys = Object.keys((pool.spec as { limits?: object }).limits ?? {});
      const label = `${pool.metadata.name} ${keys.join(",")}`;
      if (keys.length === 0) {
        expect(cell("np-limits", pool), label).toBeUndefined();
        continue;
      }
      expect(cell("np-limits", pool), label).toBe(limitsText(pool));
      expect(tone("np-limits", pool), label).toBe(limitRows(pool).some((l) => l.reached) ? "danger" : undefined);
    }
    expect(cell("np-limits", byName("NodePool", "default"))).toBe("cpu 12/1000, memory 45.9GiB/1000GiB");
    expect(cell("np-limits", byName("NodePool", "many"))).toBe(limitsText(byName("NodePool", "many")));
    expect([cell("np-limits", byName("NodePool", "gpu")), tone("np-limits", byName("NodePool", "gpu"))]).toEqual(["cpu 64/64, nvidia.com/gpu 8/8", "danger"]);
    // A resource of no known unit as a number, a limit that is no quantity as written, nothing in use as 0.
    const odd = { apiVersion: "karpenter.sh/v1", kind: "NodePool", metadata: { name: "odd" }, spec: { limits: { "example.com/fpga": "1500m", nodes: "1k", pods: "lots" } }, status: { resources: { nodes: "1k" } } } as KubeObject;
    expect([cell("np-limits", odd), tone("np-limits", odd)]).toEqual([limitsText(odd), "danger"]);
    expect(limitsText(odd)).toBe("example.com/fpga 0/1.50, nodes 1000/1000, pods 0/lots");
  });

  it("show a NodeClaim's pool, instance, capacity, zone, node, launch state and Ready", () => {
    const claims = ofKind("NodeClaim");
    // Every launch step True, False, Unknown, without a status or missing, with and without a reason.
    const steps = ["Launched", "Registered", "Initialized"];
    const states: (Cond | undefined)[] = [undefined, { type: "", status: "True" }, { type: "", status: "False", reason: "Failed" }, { type: "", status: "Unknown" }, { type: "" }];
    for (const a of states)
      for (const b of states)
        for (const c of states) {
          const conditions = [a, b, c].flatMap((s, i) => (s ? [{ ...s, type: steps[i]! }] : []));
          claims.push({ apiVersion: "karpenter.sh/v1", kind: "NodeClaim", metadata: { name: "x" }, status: { conditions } } as KubeObject);
        }
    for (const claim of claims) {
      const labels = (claim.metadata.labels ?? {}) as Record<string, string>;
      const label = JSON.stringify(claim.status);
      expect(cell("nc-node-pool", claim), label).toBe(nodePoolOf(claim));
      expect(cell("nc-instance-type", claim)).toBe(labels["node.kubernetes.io/instance-type"]);
      expect(cell("nc-capacity-type", claim)).toBe(labels["karpenter.sh/capacity-type"]);
      expect(cell("nc-zone", claim)).toBe(labels["topology.kubernetes.io/zone"]);
      expect(cell("nc-node", claim)).toBe((claim.status as { nodeName?: string }).nodeName);
      // A blank cell: the built-in had no value, the window an empty text without a sort value (both sort last).
      expect(cell("nc-state", claim) || undefined, label).toBe(claimState(claim));
      expect(windowColumn("nc-state").value(claim), label).toBe(claimState(claim));
      expect(cell("nc-ready", claim), label).toBe(readyOf(claim));
    }
  });

  it("show a node class's role and Ready", () => {
    for (const nodeClass of [...ofKind("EC2NodeClass"), ...ofKind("AKSNodeClass")]) {
      const p = nodeClass.kind === "EC2NodeClass" ? "ec2" : "aks";
      const s = nodeClass.spec as { role?: string; instanceProfile?: string };
      expect(cell(`${p}-role`, nodeClass)).toBe(s.role ?? s.instanceProfile);
      expect(cell(`${p}-ready`, nodeClass)).toBe(readyOf(nodeClass));
    }
  });
});

describe("Only problems, against the built-in filter", () => {
  it("shows the same objects, limits compared as Kubernetes quantities", () => {
    const kinds: [KindRef, KubeObject[]][] = [
      [NODE_POOL, pools()],
      [NODE_CLAIM, ofKind("NodeClaim")],
      [EC2_NODE_CLASS, ofKind("EC2NodeClass")],
      [AKS_NODE_CLASS, ofKind("AKSNodeClass")],
    ];
    for (const [kind, list] of kinds) {
      const when = manifest.contributes.kinds.find((k) => sameKind(k, kind))!.problemWhen;
      for (const o of list) expect(holdsNow(when, o), `${kind.kind} ${o.metadata.name}`).toBe(isProblem(o));
    }
    const ready = (status: string) => ({ conditions: [{ type: "Ready", status }] });
    const pool = (limits: object, resources: object, status = "True") => ({ apiVersion: "karpenter.sh/v1", kind: "NodePool", metadata: { name: "p" }, spec: { limits }, status: { resources, ...ready(status) } }) as KubeObject;
    const when = manifest.contributes.kinds.find((k) => sameKind(k, NODE_POOL))!.problemWhen;
    expect(holdsNow(when, pool({ pods: "110" }, { pods: "110" }))).toBe(true);
    expect(holdsNow(when, pool({ cpu: "10" }, { cpu: "4" }, "False"))).toBe(true);
    expect(holdsNow(when, pool({ memory: "64Gi" }, { memory: "67108864Ki" }))).toBe(true);
    expect(holdsNow(when, pool({ memory: "64Gi" }, { memory: "67108863Ki" }))).toBe(false);
    // Every limited resource is compared, as the built-in filter did.
    const other = pool({ "example.com/fpga": "2" }, { "example.com/fpga": "2" });
    expect([isProblem(other), holdsNow(when, other)]).toEqual([true, true]);
    const unreadable = pool({ "example.com/fpga": "two" }, { "example.com/fpga": "2" });
    expect([isProblem(unreadable), holdsNow(when, unreadable)]).toEqual([false, false]);
  });
});
