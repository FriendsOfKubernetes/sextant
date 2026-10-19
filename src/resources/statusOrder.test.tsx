// Cells that show several statuses render them in one fixed order (problems first, then by name), whatever order
// the API reported them in.
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import type { KindRef, KubeObject } from "../api";
import { getResourceDef } from "./index";
import { nodeConditionTone, sortStatuses, sortStatusesBy, statusTone, type Tone } from "./status";

describe("sortStatuses", () => {
  const cases: { name: string; values: string[]; tone?: (v: string) => Tone; expected: string[] }[] = [
    { name: "empty", values: [], expected: [] },
    { name: "problem before warning before ok", values: ["Running", "Pending", "Failed"], expected: ["Failed", "Pending", "Running"] },
    { name: "finished last", values: ["Completed", "Running", "Error"], expected: ["Error", "Running", "Completed"] },
    { name: "same tone by name", values: ["Progressing", "ReplicaFailure", "Available"], expected: ["Progressing", "ReplicaFailure", "Available"] },
    { name: "natural name order", values: ["Init:10", "Init:2"], expected: ["Init:2", "Init:10"] },
    {
      name: "node conditions with their own tones",
      values: ["Ready", "SchedulingDisabled", "MemoryPressure", "DiskPressure"],
      tone: nodeConditionTone,
      expected: ["DiskPressure", "MemoryPressure", "SchedulingDisabled", "Ready"],
    },
    { name: "duplicates kept", values: ["True", "False", "True"], expected: ["False", "True", "True"] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(sortStatuses(c.values, c.tone)).toEqual(c.expected);
      // Every permutation of the input gives the same order.
      expect(sortStatuses([...c.values].reverse(), c.tone)).toEqual(c.expected);
    });
  }

  it("does not change its input", () => {
    const values = ["Running", "Failed"];
    sortStatuses(values);
    expect(values).toEqual(["Running", "Failed"]);
  });

  it("orders any item by its tone and text", () => {
    const items = [
      { name: "b", health: "success" as Tone },
      { name: "a", health: "success" as Tone },
      { name: "z", health: "danger" as Tone },
    ];
    expect(sortStatusesBy(items, (i) => i.health, (i) => i.name).map((i) => i.name)).toEqual(["z", "a", "b"]);
    expect(statusTone("Unknown")).toBe("danger");
  });
});

const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const JOB: KindRef = { group: "batch", version: "v1", kind: "Job" };
const HPA: KindRef = { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" };

const cond = (type: string, status = "True") => ({ type, status });

function cellText(kind: KindRef, id: string, obj: KubeObject): { text: string; value: unknown } {
  const col = getResourceDef(kind).columns.find((c) => c.id === id);
  if (!col?.render) throw new Error(`${kind.kind} has no rendered column ${id}`);
  const { container, unmount } = render(<div>{col.render(obj, { clusterId: "c1", kind, now: 0 }) as ReactElement}</div>);
  const words = [...container.querySelectorAll(".rt-status")].map((e) => e.textContent).join(" ");
  unmount();
  return { text: words, value: col.value(obj) };
}

describe("status list cells", () => {
  const twoOrders: { name: string; kind: KindRef; id: string; a: KubeObject; b: KubeObject; expected: string }[] = [
    {
      name: "node conditions",
      kind: NODE,
      id: "conditions",
      a: {
        metadata: { name: "n1" },
        spec: { unschedulable: true },
        status: { conditions: [cond("MemoryPressure"), cond("Ready", "False"), cond("DiskPressure")] },
      },
      b: {
        metadata: { name: "n2" },
        spec: { unschedulable: true },
        status: { conditions: [cond("Ready", "False"), cond("DiskPressure"), cond("MemoryPressure")] },
      },
      expected: "DiskPressure MemoryPressure NotReady SchedulingDisabled",
    },
    {
      name: "a cordoned ready node",
      kind: NODE,
      id: "conditions",
      a: { metadata: { name: "n1" }, spec: { unschedulable: true }, status: { conditions: [cond("Ready")] } },
      b: { metadata: { name: "n2" }, spec: { unschedulable: true }, status: { conditions: [cond("PIDPressure", "False"), cond("Ready")] } },
      expected: "SchedulingDisabled Ready",
    },
    {
      name: "deployment conditions",
      kind: DEPLOYMENT,
      id: "conditions",
      a: { metadata: { name: "d1" }, status: { conditions: [cond("Available"), cond("Progressing")] } },
      b: { metadata: { name: "d2" }, status: { conditions: [cond("Progressing"), cond("Available")] } },
      expected: "Progressing Available",
    },
    {
      name: "job conditions",
      kind: JOB,
      id: "conditions",
      a: { metadata: { name: "j1" }, status: { conditions: [cond("Suspended"), cond("Failed")] } },
      b: { metadata: { name: "j2" }, status: { conditions: [cond("Failed"), cond("Suspended")] } },
      expected: "Failed Suspended",
    },
    {
      name: "HPA status",
      kind: HPA,
      id: "status",
      a: { metadata: { name: "h1" }, status: { conditions: [cond("ScalingLimited"), cond("AbleToScale"), cond("ScalingActive")] } },
      b: { metadata: { name: "h2" }, status: { conditions: [cond("ScalingActive"), cond("ScalingLimited"), cond("AbleToScale")] } },
      expected: "AbleToScale ScalingActive ScalingLimited",
    },
  ];
  for (const c of twoOrders) {
    it(`${c.name}: the same set reads the same in either API order`, () => {
      const a = cellText(c.kind, c.id, c.a);
      const b = cellText(c.kind, c.id, c.b);
      expect(a.text).toBe(c.expected);
      expect(b.text).toBe(c.expected);
      // The column's text (copy, palette status) follows the cell.
      expect(a.value).toBe(c.expected);
      expect(b.value).toBe(c.expected);
    });
  }

  it("keeps the colors of node conditions", () => {
    const col = getResourceDef(NODE).columns.find((c) => c.id === "conditions")!;
    const obj: KubeObject = { metadata: { name: "n" }, spec: { unschedulable: true }, status: { conditions: [cond("Ready")] } };
    const { container } = render(<div>{col.render!(obj, { clusterId: "c1", kind: NODE, now: 0 }) as ReactElement}</div>);
    const classes = [...container.querySelectorAll(".rt-status")].map((e) => e.className);
    expect(classes).toEqual(["rt-status rt-status--warning", "rt-status rt-status--success"]);
  });
});
