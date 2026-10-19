import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend, type SystemFont } from "../../api";
import { resetAppStore } from "../../app/store";
import { axeViolations } from "../../test/axe";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { PREVIEW_MARGIN, resetInstalledFonts } from "./FontSettings";
import { getPage } from "../../layout/pages";
import { SETTINGS_PAGE_ID, resetSettingsUi } from "./index";

const FONTS: SystemFont[] = [
  { family: "DejaVu Sans", monospace: false },
  { family: "DejaVu Sans Mono", monospace: true },
  { family: "Inter", monospace: false },
  { family: "JetBrains Mono", monospace: true },
];

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
    system_fonts: () => FONTS,
  });
});
afterEach(() => backend.restore());

function renderPage() {
  const page = getPage(SETTINGS_PAGE_ID);
  if (!page) throw new Error("the settings page is not registered");
  return render(<page.Component clusterId="c1" />);
}

describe("Fonts in Settings -> Appearance", () => {
  it("are the built-in ones by default, and System default is saved at once", async () => {
    renderPage();
    const ui = screen.getByRole("radiogroup", { name: "Interface font" });
    await waitFor(() => expect(within(ui).getByRole("radio", { name: "Built-in (Fira Sans)" })).toBeChecked());
    const mono = screen.getByRole("radiogroup", { name: "Monospace font" });
    expect(within(mono).getByRole("radio", { name: "Built-in (Fira Mono)" })).toBeChecked();

    fireEvent.click(within(mono).getByRole("radio", { name: "System default" }));
    await waitFor(() => expect(backend.settings.appearance.monoFont).toEqual({ kind: "system" }));
    expect(backend.settings.appearance.uiFont).toEqual({ kind: "builtin" });
    expect(backend.calls.some((c) => c.cmd === "system_fonts")).toBe(false);
  });

  it("lists the installed fonts only for Other, monospace ones first for code, searchable, each in its own font", async () => {
    renderPage();
    const mono = screen.getByRole("radiogroup", { name: "Monospace font" });
    await waitFor(() => expect(within(mono).getByRole("radio", { name: "Other installed font…" })).toBeEnabled());
    fireEvent.click(within(mono).getByRole("radio", { name: "Other installed font…" }));
    // Nothing is saved until a family is picked.
    expect(backend.settings.appearance.monoFont).toEqual({ kind: "builtin" });

    const list = await screen.findByRole("listbox", { name: "Monospace font: installed fonts" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["DejaVu Sans Mono", "JetBrains Mono"]);
    expect(within(list).getByRole("option", { name: "JetBrains Mono" })).toHaveStyle({
      fontFamily: '"JetBrains Mono", monospace',
    });

    fireEvent.click(screen.getByRole("checkbox", { name: "Show all fonts, not only monospace" }));
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search: Monospace font" }), { target: { value: "jet" } });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["JetBrains Mono"]);

    fireEvent.change(list, { target: { value: "JetBrains Mono" } });
    await waitFor(() =>
      expect(backend.settings.appearance.monoFont).toEqual({ kind: "custom", family: "JetBrains Mono" }),
    );
    expect(await screen.findByText("Chosen: JetBrains Mono")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("draws only the rows in view (and the chosen one) in their own fonts, however many fonts there are", async () => {
    const many: SystemFont[] = Array.from({ length: 600 }, (_, i) => ({
      family: `Family ${String(i).padStart(4, "0")}`,
      monospace: false,
    }));
    backend.on("system_fonts", () => many);
    backend.settings.appearance = { uiFont: { kind: "custom", family: "Family 0500" }, monoFont: { kind: "builtin" } };
    renderPage();
    const list = await screen.findByRole("listbox", { name: "Interface font: installed fonts" });
    const previewed = () =>
      Array.from(list.querySelectorAll("option"))
        .filter((o) => o.style.fontFamily !== "")
        .map((o) => o.textContent);
    expect(previewed().length).toBeLessThanOrEqual(2 * PREVIEW_MARGIN + 2);
    expect(previewed()).toContain("Family 0000");
    expect(previewed()).toContain("Family 0500");

    // Scrolled halfway down: the rows there get their previews.
    Object.defineProperty(list, "scrollHeight", { value: 600 * 20, configurable: true });
    list.scrollTop = 300 * 20;
    fireEvent.scroll(list);
    await waitFor(() => expect(previewed()).toContain("Family 0300"));
    expect(previewed()).not.toContain("Family 0000");
    expect(previewed().length).toBeLessThanOrEqual(2 * PREVIEW_MARGIN + 2);
  });

  it("warns that a proportional font breaks the terminal grid when one can be chosen for code", async () => {
    renderPage();
    const mono = screen.getByRole("radiogroup", { name: "Monospace font" });
    await waitFor(() => expect(within(mono).getByRole("radio", { name: "Other installed font…" })).toBeEnabled());
    fireEvent.click(within(mono).getByRole("radio", { name: "Other installed font…" }));
    await screen.findByRole("listbox", { name: "Monospace font: installed fonts" });
    const hint = /Proportional fonts break the terminal's column grid/;
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show all fonts, not only monospace" }));
    expect(screen.getByText(hint)).toBeInTheDocument();
  });

  it("says when the chosen family is not installed here (the built-in font is used)", async () => {
    backend.settings.appearance = { uiFont: { kind: "custom", family: "Gone Sans" }, monoFont: { kind: "builtin" } };
    renderPage();
    expect(
      await screen.findByText("Gone Sans is not installed on this computer; the built-in font is used."),
    ).toBeInTheDocument();
    const ui = screen.getByRole("radiogroup", { name: "Interface font" });
    expect(within(ui).getByRole("radio", { name: "Other installed font…" })).toBeChecked();
  });

  it("tells when the installed fonts cannot be read", async () => {
    backend.on("system_fonts", () => {
      throw { code: "internal", message: "boom" };
    });
    renderPage();
    const ui = screen.getByRole("radiogroup", { name: "Interface font" });
    await waitFor(() => expect(within(ui).getByRole("radio", { name: "Other installed font…" })).toBeEnabled());
    fireEvent.click(within(ui).getByRole("radio", { name: "Other installed font…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The installed fonts could not be read.");
  });
});
