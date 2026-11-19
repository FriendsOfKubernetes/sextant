// What a computed column of extension API 6 says (ADR-0172): an item's own sort text, an age sorted by its time, a
// blank case, and a judge's fact as a cell's text.
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnContribution, KubeObject } from "../api";

const answers = new Map<string, Record<string, string>>();
vi.mock("./problemJudges", () => ({
  judgedFactAnywhere: (_ext: string, judge: string, fact: string, uid: string) => answers.get(`${judge}|${fact}|${uid}`) ?? null,
}));
vi.mock("./rowProblems", () => ({ useRowProblemState: () => () => undefined, rowProblemStateNow: () => undefined }));

const { computedColumn } = await import("./columns");

const KIND = { group: "serving.knative.dev", kind: "Route" };
const column = (rest: Partial<ColumnContribution>): ColumnContribution => ({ kind: KIND, id: "c", title: "C", paths: [".status.traffic"], ...rest }) as ColumnContribution;
const ctx = { now: Date.parse("2026-11-19T12:00:00Z"), t: (key: string) => key } as never;
const cellCtx = { now: Date.parse("2026-11-19T12:00:00Z"), clusterId: "c", kind: { ...KIND, version: "v1" } } as never;

describe("a computed column of API 6", () => {
  it("sorts, filters and searches a list by its items' values, showing their texts", () => {
    const traffic = column({
      format: "list",
      filterBy: "value",
      searchBy: "value",
      items: {
        cases: [
          { when: { type: "equals", path: ".latestRevision", value: true }, text: "latest {{.percent}}%", value: " {{.percent}}%" },
          { when: { type: "exists", path: ".revisionName" }, text: "{{.revisionName}} {{.percent}}%" },
        ],
        separator: " · ",
      },
    });
    const o = { metadata: { name: "r", uid: "u" }, status: { traffic: [{ latestRevision: true, percent: 90 }, { revisionName: "r-1", percent: 10 }] } } as unknown as KubeObject;
    const col = computedColumn("x", traffic);
    expect(col.value(o)).toBe(" 90% · r-1 10%");
    expect(col.searchText!(o, ctx)).toBe(" 90% · r-1 10%");
    expect(col.filter!.value!(o, cellCtx)).toBe(" 90% · r-1 10%");
    const { container } = render(<>{col.render!(o, cellCtx)}</>);
    expect(container.textContent).toBe("latest 90% · r-1 10%");
  });

  it("sorts an age by its time with sortAs, and keeps its age for the filter", () => {
    const old = { metadata: { name: "a", uid: "a" }, status: { refreshTime: "2026-11-19T10:00:00Z" } } as unknown as KubeObject;
    const recent = { metadata: { name: "b", uid: "b" }, status: { refreshTime: "2026-11-19T11:00:00Z" } } as unknown as KubeObject;
    const byAge = computedColumn("x", column({ paths: [".status.refreshTime"], format: "age" }));
    const byTime = computedColumn("x", column({ paths: [".status.refreshTime"], format: "age", sortAs: "time" }));
    // By age the newest sorts first; by time the oldest.
    expect((byAge.value(old) as number) > (byAge.value(recent) as number)).toBe(true);
    expect((byTime.value(old) as number) < (byTime.value(recent) as number)).toBe(true);
    expect(byTime.filter!.value!(old, cellCtx)).toBe(2 * 3600_000);
    expect(byAge.filter!.value!(old, cellCtx)).toBe(2 * 3600_000);
  });

  it("leaves a cell with no value while a blank case holds", () => {
    const canary = computedColumn(
      "x",
      column({
        paths: ['.status.traffic[latestRevision="true",*].percent'],
        format: "sum",
        cases: [{ when: { type: "absent", path: ".status.traffic[1]" }, text: "", blank: true }],
      }),
    );
    const one = { metadata: { name: "a", uid: "a" }, status: { traffic: [{ latestRevision: true, percent: 100 }] } } as unknown as KubeObject;
    const split = { metadata: { name: "b", uid: "b" }, status: { traffic: [{ latestRevision: true, percent: 20 }, { percent: 80 }] } } as unknown as KubeObject;
    expect(canary.value(one)).toBeUndefined();
    expect(canary.filter!.value!(one, cellCtx)).toBeUndefined();
    expect(canary.value(split)).toBe(20);
    expect(canary.filter).toMatchObject({ type: "number" });
  });

  it("shows a judge's fact, put in last, and the next case while the judge gives none", () => {
    const filter = computedColumn(
      "x",
      column({
        kind: { group: "eventing.knative.dev", kind: "Trigger" },
        paths: [".spec.filter"],
        cases: [
          { when: { type: "judged", judge: "filters", fact: "filter" }, text: "{{fact:text}}", tooltip: "{{fact:text}}" },
          { when: { type: "exists", path: ".metadata.name" }, text: "…" },
        ],
      }),
      undefined,
      "sextant.knative",
    );
    const t = { metadata: { name: "t", uid: "t-1" } } as unknown as KubeObject;
    expect(filter.value(t)).toBe("…");
    answers.set("filters|filter|t-1", { text: "type={{.spec.x}}, (a=1 | b=2)" });
    expect(filter.value(t)).toBe("type={{.spec.x}}, (a=1 | b=2)");
    expect(filter.searchText!(t, ctx)).toBe("type={{.spec.x}}, (a=1 | b=2)");
    const { container } = render(<>{filter.render!(t, cellCtx)}</>);
    expect(container.textContent).toBe("type={{.spec.x}}, (a=1 | b=2)");
    expect(filter.filter!.observer).toBeDefined();
  });
});
