// An extension's computed columns clean cluster text wherever it shows: a URI's credentials, query
// and fragment never reach a cell, a list or a hover, as they never reach a case's text.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ColumnContribution, KubeObject } from "../api";
import { computedColumn } from "./columns";

const KIND = { group: "serving.kserve.io", kind: "InferenceService" };
const column = (rest: Partial<ColumnContribution>): ColumnContribution =>
  ({ kind: KIND, id: "c", title: "C", paths: [".status.url"], ...rest }) as ColumnContribution;
const obj = {
  metadata: { name: "a" },
  status: {
    url: "https://user:secret@model.example.com/v1?token=x",
    urls: ["https://u:p@a.example.com/", "plain"],
    message: "pulling s3://key:hidden@bucket/model failed",
  },
} as unknown as KubeObject;
const ctx = { now: Date.now(), t: (key: string) => key } as never;

describe("an extension's computed column", () => {
  it("cleans a text cell, a list cell and a hover", () => {
    const text = computedColumn("x", column({}));
    expect(text.searchText!(obj, ctx)).toBe("https://model.example.com/v1");
    const list = computedColumn("x", column({ paths: [".status.urls"], format: "list" }));
    expect(list.searchText!(obj, ctx)).not.toContain("u:p@");
    const hover = computedColumn("x", column({ tooltipPaths: [".status.message"] }));
    const { container } = render(<>{hover.render!(obj, ctx)}</>);
    const title = container.querySelector("span[title]")!.getAttribute("title")!;
    expect(title).not.toContain("hidden");
    expect(title).toContain("failed");
  });

  it("takes the width it asks for (#403)", () => {
    expect(computedColumn("x", column({ width: "minmax(140px, 1.5fr)" })).width).toBe("minmax(140px, 1.5fr)");
    expect(computedColumn("x", column({})).width).toBeUndefined();
  });
});
