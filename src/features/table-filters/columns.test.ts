import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { ageColumn, getResourceDef, printerColumns, statusListColumn, type CellContext } from "../../resources";
import { columnDefOf, type ShownColumn } from "../custom-columns/model";
import { nodeColumns, podColumns } from "../metrics/columns";
import { compileTableFilters, readFilterValue } from "./model";
import { EVENT_COLUMNS } from "../events/EventsPage";

const ctx: CellContext = { clusterId: "test", kind: { group: "", version: "v1", kind: "Pod" }, now: Date.parse("2026-10-27T12:00:00Z") };

describe("resource column filter semantics", () => {
  it("filters Pod owners by the visible kind while leaving name-based sorting intact", () => {
    const column = getResourceDef(ctx.kind).columns.find((c) => c.id === "controlledBy")!;
    const pod: KubeObject = { metadata: { ownerReferences: [{ kind: "Job", apiVersion: "batch/v1", name: "private-job-name", controller: true }] } };
    expect(column.value(pod)).toBe("Job/private-job-name");
    expect(readFilterValue(column, pod, ctx)).toBe("Job");
    expect(compileTableFilters({ columns: { controlledBy: { values: { mode: "exclude", values: ["Job"] }, condition: null } }, advanced: null }, [column]).matches(pod, ctx)).toBe(false);
  });
  it("filters age as a duration, missing timestamps as empty", () => {
    expect(readFilterValue(ageColumn, { metadata: { creationTimestamp: "2026-10-27T11:00:00Z" } }, ctx)).toBe(3_600_000);
    expect(readFilterValue(ageColumn, {}, ctx)).toBeUndefined();
  });
  it("uses boolean CronJob suspension and duration since scheduling, including missing and invalid timestamps", () => {
    const cron = getResourceDef({ group: "batch", version: "v1", kind: "CronJob" });
    const suspend = cron.columns.find((column) => column.id === "suspend")!;
    const last = cron.columns.find((column) => column.id === "lastSchedule")!;
    expect([{}, { spec: { suspend: false } }, { spec: { suspend: true } }].map((obj) => readFilterValue(suspend, obj, ctx))).toEqual([false, false, true]);
    expect(readFilterValue(last, { status: { lastScheduleTime: "2026-10-27T11:59:00Z" } }, ctx)).toBe(60_000);
    expect(readFilterValue(last, {}, ctx)).toBeUndefined();
    expect(readFilterValue(last, { status: { lastScheduleTime: "invalid" } }, ctx)).toBeUndefined();
    expect(readFilterValue(last, { status: { lastScheduleTime: "2026-10-27T12:01:00Z" } }, ctx)).toBe(0);
  });
  it("compares Event last seen as elapsed time instead of the negated sorting timestamp", () => {
    const last = EVENT_COLUMNS.find((column) => column.id === "lastSeen")!;
    const event = { lastTimestamp: "2026-10-27T11:58:00Z" };
    expect(last.value(event)).toBe(-Date.parse(event.lastTimestamp));
    expect(readFilterValue(last, event, ctx)).toBe(120_000);
    expect(readFilterValue(last, {}, ctx)).toBeUndefined();
    expect(readFilterValue(last, { lastTimestamp: "invalid" }, ctx)).toBeUndefined();
  });
  it("gives CRD printer columns explicit numeric, boolean and duration values", () => {
    const defs = printerColumns([
      { name: "Ready", type: "boolean", jsonPath: ".status.ready", priority: 0 },
      { name: "Count", type: "integer", jsonPath: ".status.count", priority: 0 },
      { name: "Since", type: "date", jsonPath: ".status.since", priority: 0 },
    ]);
    const object = { status: { ready: false, count: 0, since: "2026-10-27T11:00:00Z" } };
    expect(defs.map((c) => readFilterValue(c, object, ctx))).toEqual([[false], [0], [3_600_000]]);
    expect(defs.map((c) => c.filter?.type)).toEqual(["boolean", "number", "age"]);
  });
  it("keeps individual status and custom-column array values without parsing cell text", () => {
    const status = statusListColumn("conditions", () => ["Ready", "Progressing"]);
    expect(readFilterValue(status, {}, ctx)).toEqual(["Ready", "Progressing"]);
    const def = columnDefOf({ id: "custom:field:.spec.values", scope: "view", spec: { source: "field", path: ".spec.values", title: "Values" } } as ShownColumn, "、");
    expect(readFilterValue(def, { spec: { values: [0, false, "Job"] } }, ctx)).toEqual([0, false, "Job"]);
  });
  it("shares a single existing metrics observer for CPU and memory, with explicit cluster getters", () => {
    for (const defs of [podColumns, nodeColumns]) {
      expect(defs[0]!.filter?.observer).toBe(defs[1]!.filter?.observer);
      expect(defs.map((c) => c.filter?.unit)).toEqual(["cpu", "bytes"]);
      expect(defs.every((c) => !!c.filter?.value)).toBe(true);
    }
  });
});
