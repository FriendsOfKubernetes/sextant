// Long annotation values (kubectl's last-applied-configuration above all) are folded behind "Show" on every kind, so
// they do not push the panel's content below the fold; they can still be copied.
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, ObjectRef } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import "../../resources";
import serviceJson from "./fixtures/service.json";
import "./index";
import { isLongAnnotation, LONG_ANNOTATION } from "./sections";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "./testing";

const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const REF: ObjectRef = { kind: { group: "", version: "v1", kind: "Service" }, namespace: "sextant-demo", name: "nginx" };

let wb: WatchBackend;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetAppStore();
  wb = watchBackend();
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  wb.backend.restore();
  Reflect.deleteProperty(navigator, "clipboard");
});

async function open(obj: KubeObject): Promise<HTMLElement> {
  useAppStore.getState().openDetails(REF);
  render(<DetailsPanel clusterId="c1" objectRef={REF} />);
  emitSnapshot(wb, await watchOf(wb, "Service", (s) => s.fieldSelector === `metadata.name=${REF.name}`), [obj]);
  const section = await waitFor(() => document.querySelector<HTMLElement>("[data-section='metadata']")!);
  return section;
}

describe("annotations in the details panel", () => {
  it("which values fold: longer than the limit, or a JSON document", () => {
    expect(isLongAnnotation("x".repeat(LONG_ANNOTATION + 1))).toBe(true);
    expect(isLongAnnotation('{"apiVersion":"v1","kind":"Service","metadata":{"name":"nginx"}}')).toBe(true);
    expect(isLongAnnotation("3")).toBe(false);
    expect(isLongAnnotation("{}")).toBe(false);
    expect(isLongAnnotation("{not json, but a long-ish sentence in braces}")).toBe(false);
  });

  it("last-applied-configuration is folded behind Show and copyable; a short one is shown as it is", async () => {
    const obj = copy(serviceJson as KubeObject);
    const annotations: Record<string, string> = { ...(obj.metadata!.annotations as Record<string, string>), "example.com/team": "shop" };
    obj.metadata!.annotations = annotations;
    const value = annotations[LAST_APPLIED]!;
    const metadata = await open(obj);
    const panel = within(metadata);
    await waitFor(() => expect(panel.getByText(LAST_APPLIED)).toBeInTheDocument());
    // The short one as it is; the long one folded, with its size.
    expect(panel.getByText("shop")).toBeInTheDocument();
    expect(metadata).not.toHaveTextContent('"kind":"Service"');
    expect(panel.getByText(`${value.length} characters`)).toBeInTheDocument();
    const show = panel.getByRole("button", { name: `Show value of ${LAST_APPLIED}` });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(show).toHaveTextContent("Show");

    fireEvent.click(panel.getByRole("button", { name: `Copy value of ${LAST_APPLIED}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(value));
    expect(await panel.findByText("Copied")).toBeInTheDocument();

    fireEvent.click(show);
    expect(metadata).toHaveTextContent('"kind":"Service"');
    const hide = panel.getByRole("button", { name: `Hide value of ${LAST_APPLIED}` });
    expect(hide).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(hide);
    expect(metadata).not.toHaveTextContent('"kind":"Service"');
  });
});
