// Settings -> Appearance: reduced motion, the interface text size and screen reader support in the terminal
// (ADR-0092, #186). Each is saved at once into `appearance`, the fonts kept.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { getPage } from "../../layout/pages";
import { axeViolations } from "../../test/axe";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { resetInstalledFonts } from "./FontSettings";
import { SETTINGS_PAGE_ID, resetSettingsUi } from "./index";

let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetHelmStatus();
  resetSettingsUi();
  resetInstalledFonts();
  backend = mockBackend({
    clusters_list: () => [],
    kubeconfig_sources: () => [],
    cluster_state: () => ({ state: "disconnected" }),
    helm_status: () => ({ available: false, version: null, path: null }),
    system_fonts: () => [],
  });
});
afterEach(() => backend.restore());

function renderPage() {
  const page = getPage(SETTINGS_PAGE_ID);
  if (!page) throw new Error("the settings page is not registered");
  return render(<page.Component clusterId="c1" />);
}

describe("Accessibility in Settings -> Appearance", () => {
  it("defaults to the system's motion, 100% text and no terminal screen reader mode", async () => {
    renderPage();
    const motion = screen.getByRole("radiogroup", { name: "Reduce motion" });
    await waitFor(() => expect(within(motion).getByRole("radio", { name: "System" })).toBeChecked());
    const size = screen.getByRole("radiogroup", { name: "Interface text size" });
    expect(within(size).getAllByRole("radio").map((r) => r.closest("label")?.textContent)).toEqual([
      "90%",
      "100%",
      "110%",
      "125%",
      "150%",
    ]);
    expect(within(size).getByRole("radio", { name: "100%" })).toBeChecked();
    const reader = screen.getByRole("checkbox", { name: "Screen reader support in the terminal" });
    expect(reader).not.toBeChecked();
    expect(reader).toHaveAccessibleDescription(/slows the terminal down/);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("saves each choice at once and keeps the fonts", async () => {
    backend.settings.appearance = { ...backend.settings.appearance, monoFont: { kind: "system" } };
    renderPage();
    const motion = screen.getByRole("radiogroup", { name: "Reduce motion" });
    await waitFor(() => expect(within(motion).getByRole("radio", { name: "On" })).toBeEnabled());

    fireEvent.click(within(motion).getByRole("radio", { name: "On" }));
    await waitFor(() => expect(backend.settings.appearance.reduceMotion).toBe("on"));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Interface text size" })).getByRole("radio", { name: "125%" }));
    await waitFor(() => expect(backend.settings.appearance.textSize).toBe(125));
    fireEvent.click(screen.getByRole("checkbox", { name: "Screen reader support in the terminal" }));
    await waitFor(() => expect(backend.settings.appearance.terminalScreenReader).toBe(true));

    expect(backend.settings.appearance).toEqual({
      uiFont: { kind: "builtin" },
      monoFont: { kind: "system" },
      reduceMotion: "on",
      textSize: 125,
      terminalScreenReader: true,
      sidebarIndent: false,
      sidebarGuides: false,
    });
    expect(within(motion).getByRole("radio", { name: "On" })).toBeChecked();
  });
});
