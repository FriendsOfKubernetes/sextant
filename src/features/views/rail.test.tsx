import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { ClusterRail } from "../../layout/ClusterRail";
import "../fleet/index";
import "./index";

let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  backend = mockBackend({}, {});
});

afterEach(() => backend.restore());

/** Everything in the rail called "All clusters": by its accessible name or by the text it shows. */
function allClustersControls(): HTMLElement[] {
  const named = screen.queryAllByRole("button", { name: "All clusters" });
  const shown = screen.queryAllByText("All clusters").map((el) => el.closest("button") ?? el);
  return [...new Set([...named, ...shown])];
}

describe("the cluster rail", () => {
  it.each([false, true])("has exactly one All clusters control (expanded: %s)", async (expanded) => {
    act(() => useAppStore.getState().setRailExpanded(expanded));
    render(<ClusterRail />);
    // The workspace switcher reads the settings before it settles.
    await waitFor(() => expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(allClustersControls()).toHaveLength(1);
    expect(allClustersControls()[0]).toHaveAttribute("aria-pressed");
  });
});
