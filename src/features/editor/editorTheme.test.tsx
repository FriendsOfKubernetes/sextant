import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import { resetAppStore } from "../../app/store";
import { YamlViewer } from "../details";
import { resetClustersStore } from "../clusters/clustersStore";
import { getPage } from "../../layout/pages";
import { SETTINGS_PAGE_ID } from "../settings";
import { YamlEditor } from "./YamlEditor";
import { parseEditorTheme } from "./editorTheme";

// CodeMirror measures text through Range rects, which jsdom does not implement.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
});

const YAML = "name: web\nreplicas: 2\n";
let backend: MockBackend;

function setup(editorTheme?: string) {
  backend = mockBackend({ clusters_list: () => [], kubeconfig_sources: () => [] }, { settings: editorTheme ? { editorTheme } : {} });
}

function setAppTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
});
afterEach(() => {
  backend.restore();
  delete document.documentElement.dataset.theme;
});

function Editors() {
  return (
    <>
      <YamlEditor value={YAML} onChange={() => undefined} label="Editor" />
      <YamlViewer text={YAML} label="Viewer" />
    </>
  );
}

type Rgb = [number, number, number];

function rgb(css: string): Rgb {
  const match = /rgba?\((\d+), (\d+), (\d+)/.exec(css);
  if (!match) throw new Error(`not a colour: "${css}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio. */
function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function colors(host: HTMLElement) {
  const editor = host.querySelector<HTMLElement>(".cm-editor");
  const gutters = host.querySelector<HTMLElement>(".cm-gutters");
  const key = [...host.querySelectorAll<HTMLElement>(".cm-line span")].find((s) => s.textContent === "name");
  if (!editor || !gutters || !key) throw new Error("the editor did not render");
  return {
    background: rgb(getComputedStyle(editor).backgroundColor),
    text: rgb(getComputedStyle(editor).color),
    key: rgb(getComputedStyle(key).color),
    gutter: rgb(getComputedStyle(gutters).backgroundColor),
  };
}

function hosts(): [HTMLElement, HTMLElement] {
  const editor = document.querySelector<HTMLElement>(".yaml-editor");
  const viewer = document.querySelector<HTMLElement>(".dt-yaml");
  if (!editor || !viewer) throw new Error("the editors are not mounted");
  return [editor, viewer];
}

describe("editor colour scheme", () => {
  it.each([
    ["dark", [40, 44, 52]],
    ["light", [255, 255, 255]],
  ] as const)("Auto in the %s app theme gives One Dark / GitHub Light, with a gutter of the same family", (appTheme, background) => {
    setup();
    setAppTheme(appTheme);
    render(<Editors />);
    for (const host of hosts()) {
      const c = colors(host);
      expect(c.background).toEqual(background);
      expect(luminance(c.gutter) < 0.5).toBe(appTheme === "dark");
    }
  });

  it.each(["dark", "light"] as const)("text and YAML keys of the default scheme have contrast >= 4.5 in the %s theme", (appTheme) => {
    setup();
    setAppTheme(appTheme);
    render(<Editors />);
    for (const host of hosts()) {
      const c = colors(host);
      expect(contrast(c.text, c.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c.key, c.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("follows the app theme while it is Auto", async () => {
    setup();
    setAppTheme("dark");
    render(<Editors />);
    expect(colors(hosts()[0]).background).toEqual([40, 44, 52]);
    setAppTheme("light");
    await waitFor(() => expect(colors(hosts()[0]).background).toEqual([255, 255, 255]));
    expect(colors(hosts()[1]).background).toEqual([255, 255, 255]);
  });

  it("changing the scheme in Settings restyles every open editor and is saved with settings_update", async () => {
    setup();
    setAppTheme("dark");
    const page = getPage(SETTINGS_PAGE_ID);
    if (!page) throw new Error("the settings page is not registered");
    render(
      <>
        <Editors />
        <page.Component clusterId="c1" />
      </>,
    );
    const section = screen.getByRole("region", { name: "Editor" });
    const select = within(section).getByRole("combobox", { name: "Color scheme" });
    await waitFor(() => expect(select).toHaveValue("auto"));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Auto",
      "One Dark",
      "GitHub Dark",
      "GitHub Light",
      "Dracula",
      "Nord",
      "Solarized Dark",
      "Solarized Light",
    ]);

    fireEvent.change(select, { target: { value: "solarizedLight" } });
    await waitFor(() => expect(backend.settings.editorTheme).toBe("solarizedLight"));
    expect(backend.calls.filter((c) => c.cmd === "settings_update")).toHaveLength(1);
    // Solarized Light paints #fdf6e3 under both the editor and the viewer, whatever the app theme is.
    await waitFor(() => expect(colors(hosts()[0]).background).toEqual([253, 246, 227]));
    expect(colors(hosts()[1]).background).toEqual([253, 246, 227]);
    expect(select).toHaveValue("solarizedLight");
  });

  it("treats an unknown saved scheme as Auto, without an error", async () => {
    setup("from-a-newer-version");
    setAppTheme("dark");
    const page = getPage(SETTINGS_PAGE_ID);
    if (!page) throw new Error("the settings page is not registered");
    render(
      <>
        <Editors />
        <page.Component clusterId="c1" />
      </>,
    );
    const select = screen.getByRole("combobox", { name: "Color scheme" });
    await waitFor(() => expect(select).toHaveValue("auto"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(colors(hosts()[0]).background).toEqual([40, 44, 52]);
    expect(parseEditorTheme("from-a-newer-version")).toBe("auto");
  });
});
