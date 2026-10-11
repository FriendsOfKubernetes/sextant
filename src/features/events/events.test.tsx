import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject, ObjectRef } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getPage } from "../../layout/pages";
import "../../resources";
import "../details";
import eventsJson from "../details/fixtures/events.json";
import podJson from "../details/fixtures/pod.json";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore, selectNamespaces } from "../namespaces";
import "./index";

const events = (eventsJson as { items: KubeObject[] }).items;
const pod = podJson as KubeObject;

/** A warning about the pod, newer than every fixture event. */
function backOff(): KubeObject {
  const e = copy(events[0]!);
  Object.assign(e, {
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container nginx",
    lastTimestamp: "2026-10-11T18:26:07Z",
    count: 4,
  });
  e.metadata = { ...e.metadata, name: "nginx-9f755754d-g85tv.backoff", uid: "uid-backoff" };
  return e;
}

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  wb = watchBackend();
  // jsdom has no layout: give the table a viewport of 660 px.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 660 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("rt__scroll") ? 1200 : 0;
  });
});

afterEach(() => wb.backend.restore());

function rows(): HTMLElement[] {
  return within(screen.getByRole("table"))
    .getAllByRole("row")
    .filter((r) => r.getAttribute("aria-rowindex") !== "1");
}

describe("Events page", () => {
  it("is a sidebar page of the Events section", () => {
    const page = getPage("events");
    expect(page?.section).toBe("events");
    expect(page?.labelKey).toBe("events:sidebar");
  });

  it("shows the events of the selected namespaces, newest first, warnings highlighted, with links", async () => {
    await selectNamespaces("c1", ["sextant-demo"]);
    const Page = getPage("events")!.Component;
    render(<Page clusterId="c1" />);
    const id = await watchOf(wb, "Event");
    expect(wb.specs.get(id)?.namespaces).toEqual(["sextant-demo"]);
    emitSnapshot(wb, id, [...events, backOff()]);

    expect(rows().map((r) => r.getAttribute("data-uid"))[0]).toBe("uid-backoff");
    const texts = rows().map((r) => r.textContent ?? "");
    expect(texts.findIndex((t) => t.includes("Pulled"))).toBeLessThan(texts.findIndex((t) => t.includes("Pulling")));

    const warning = rows()[0]!;
    expect(within(warning).getByText("Back-off restarting failed container nginx")).toBeInTheDocument();
    expect(warning.querySelector(".events-warning")).not.toBeNull();
    expect(rows()[1]!.querySelector(".events-warning")).toBeNull();
  });

  it("opens the involved object from a row", async () => {
    await selectNamespaces("c1", ["sextant-demo"]);
    const Page = getPage("events")!.Component;
    render(<Page clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "Event"), [events[3]!]);
    fireEvent.click(screen.getByRole("button", { name: "Open Deployment nginx" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "apps", version: "v1", kind: "Deployment" },
      namespace: "sextant-demo",
      name: "nginx",
    });
  });
});

describe("events in the details panel", () => {
  const POD_REF: ObjectRef = {
    kind: { group: "", version: "v1", kind: "Pod" },
    namespace: "sextant-demo",
    name: "nginx-9f755754d-g85tv",
  };

  it("lists the events of the pod, found by its uid", async () => {
    render(<DetailsPanel clusterId="c1" objectRef={POD_REF} />);
    emitSnapshot(wb, await watchOf(wb, "Pod"), [pod]);
    const id = await watchOf(wb, "Event");
    expect(wb.specs.get(id)).toMatchObject({
      namespaces: ["sextant-demo"],
      fieldSelector: `involvedObject.uid=${pod.metadata!.uid}`,
    });
    emitSnapshot(wb, id, [...events.slice(0, 3), backOff()]);

    const section = document.querySelector<HTMLElement>("[data-section='events']")!;
    const items = within(section).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("BackOff");
    expect(items[0]).toHaveClass("events-warning");
    expect(items[1]).toHaveTextContent("Pulled");
    expect(within(section).getByText('Pulling image "nginx:stable-alpine"')).toBeInTheDocument();
  });
});
