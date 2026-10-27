import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defaultAppSettings, mockBackend, type MockBackend, type WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { EventsPage } from "../events/EventsPage";
import { resetNamespaceRestore } from "../namespaces";
import { getTableFilters, resetTableFiltersState } from "./state";

let backend: MockBackend | undefined;
afterEach(() => { backend?.restore(); resetAppStore(); resetNamespaceRestore(); resetTableFiltersState(); });

it("filters a custom column in the primary Events list through its existing object watch", async () => {
  resetAppStore(); resetNamespaceRestore(); resetTableFiltersState();
  useAppStore.getState().setNamespaces("c1", ["demo"]);
  let eventStream = "";
  let eventWatches = 0;
  backend = mockBackend({
    watch_start: ({ spec, streamId }) => {
      if ((spec as WatchSpec).kind.kind === "Event") { eventStream = streamId as string; eventWatches++; }
    }, watch_stop: () => undefined,
  }, { settings: { ...defaultAppSettings(), customColumns: [{ cluster: "c1", group: "", kind: "Event", source: "field", path: ".reason", title: "Custom reason" }] } });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("rt__scroll") ? 660 : 0; });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("rt__scroll") ? 1400 : 0; });
  render(<EventsPage clusterId="c1" />);
  await waitFor(() => expect(eventStream).not.toBe(""));
  act(() => backend!.emit(`watch:${eventStream}`, { type: "snapshot", items: [
    { metadata: { name: "scheduled", uid: "e1", namespace: "demo" }, reason: "Scheduled", message: "Scheduled synthetic pod" },
    { metadata: { name: "backoff", uid: "e2", namespace: "demo" }, reason: "BackOff", message: "Synthetic restart backoff" },
  ] }));
  await waitFor(() => expect(screen.getByRole("columnheader", { name: "Custom reason" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Filter Custom reason" }));
  const editor = screen.getByRole("dialog", { name: "Filter Custom reason" });
  fireEvent.click(within(editor).getByRole("button", { name: "Everything except selected" }));
  fireEvent.click(within(editor).getByRole("checkbox", { name: "BackOff" }));
  expect(screen.getByTestId("rt-count")).toHaveTextContent("1 of 2");
  expect(getTableFilters("c1", "kind:/Event").columns["custom:field:.reason"]?.values?.values).toEqual(["BackOff"]);
  expect(eventWatches).toBe(1);
});
