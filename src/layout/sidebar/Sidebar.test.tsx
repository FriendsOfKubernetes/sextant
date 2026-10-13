import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ResourceKind } from "../../api";
import { resetAppStore } from "../../app/store";
import { featureModules } from "../../app/features";
import { isIconName } from "../../components";
import {
  getResourceDefs,
  registerResource,
  resetClusterKinds,
  unregisterResource,
  type ResourceDef,
} from "../../resources";
import { DEFAULT_ENTRY_ICON, SECTION_ICONS, SIDEBAR_SECTIONS } from "../../resources/registry";
import { CRD_REFRESH_DELAY } from "../../resources/useKinds";
import { getPages } from "../pages";
import { Sidebar } from "./Sidebar";

const served = (group: string, version: string, kind: string): ResourceKind => ({
  kindRef: { group, version, kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});

// Kinds a GitOps feature registers under its section (labels without translations render as their key).
const GITOPS: ResourceDef[] = [
  ["flux", "source.toolkit.fluxcd.io", "GitRepository", "GitRepositories"],
  ["flux", "source.toolkit.fluxcd.io", "Bucket", "Buckets"],
  ["flux", "kustomize.toolkit.fluxcd.io", "Kustomization", "Kustomizations"],
  ["argocd", "argoproj.io", "Application", "Applications"],
].map(([section, group, kind, label], order) => ({
  kind: { group: group!, version: "v1", kind: kind! },
  sidebar: { section: section as "flux" | "argocd", order, labelKey: label! },
  columns: [],
  actions: [],
}));

// The registrations as the features made them, before the tests below register stand-ins for GitOps kinds.
const REGISTERED = getResourceDefs();

let backend: MockBackend;
let kinds: ResourceKind[] | null;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  for (const def of GITOPS) registerResource(def);
  kinds = [
    served("", "v1", "Pod"),
    served("source.toolkit.fluxcd.io", "v1", "GitRepository"),
    served("kustomize.toolkit.fluxcd.io", "v1", "Kustomization"),
    served("demo.sextant.dev", "v1", "Widget"),
  ];
  backend = mockBackend({
    cluster_kinds: () => (kinds ? kinds : new Promise(() => undefined)),
    cluster_kinds_refresh: () => undefined,
    watch_start: () => "crds",
    watch_stop: () => undefined,
  });
});

afterEach(() => {
  backend.restore();
  for (const def of GITOPS) unregisterResource(def.kind);
  resetClusterKinds();
  vi.useRealTimers();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

const crd = (uid: string): KubeObject => ({ metadata: { name: uid, uid, generation: 1 } });

describe("Flux and Argo CD sections", () => {
  it("show only the kinds the cluster serves, before Custom Resources; a section without kinds is not drawn", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Flux"));
    expect(sections()).not.toContain("Argo CD");
    expect(sections().indexOf("Flux")).toBe(sections().indexOf("Custom Resources") - 1);

    fireEvent.click(screen.getByRole("button", { name: /Flux/ }));
    const flux = screen.getByRole("button", { name: /Flux/ }).closest("li")!;
    expect(within(flux).getByRole("button", { name: "GitRepositories" })).toBeInTheDocument();
    expect(within(flux).getByRole("button", { name: "Kustomizations" })).toBeInTheDocument();
    expect(within(flux).queryByRole("button", { name: "Buckets" })).toBeNull();
  });

  it("are not drawn while the discovery is still coming", async () => {
    kinds = null;
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    // Built-in kinds are shown before discovery; the GitOps sections are not, under any title.
    const titles = sections().map((s) => s?.toLowerCase());
    expect(titles).toContain("workloads");
    expect(titles).not.toContain("flux");
    expect(titles).not.toContain("argocd");
  });

  it("a section appears when its CRD is created while connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Flux"));
    await waitFor(() => expect(backend.listenerCount("watch:crds")).toBe(1));
    act(() => backend.emit("watch:crds", { type: "snapshot", items: [crd("gitrepositories")] }));

    kinds = [...kinds!, served("argoproj.io", "v1alpha1", "Application")];
    act(() => backend.emit("watch:crds", { type: "delta", upserted: [crd("applications")], deleted: [] }));
    await act(async () => void vi.advanceTimersByTime(CRD_REFRESH_DELAY));

    await waitFor(() => expect(sections()).toContain("Argo CD"));
    expect(sections().indexOf("Argo CD")).toBe(sections().indexOf("Flux") + 1);
    expect(backend.calls.filter((c) => c.cmd === "cluster_kinds_refresh")).toHaveLength(1);
  });
});

describe("icons", () => {
  const iconOf = (el: HTMLElement) => el.querySelector("svg.sidebar__icon");

  it("every section header, entry, custom resource group and custom resource has a hidden icon, and the names are unchanged", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Custom Resources"));
    for (const name of [/Workloads/, /Flux/, /Custom Resources/]) fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.click(await screen.findByRole("button", { name: /demo\.sextant\.dev/ }));

    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(8);
    for (const button of buttons) {
      const icon = iconOf(button);
      expect(icon, button.textContent ?? "").not.toBeNull();
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon!.querySelector("title")).toBeNull();
    }
    // The icon adds no text: the accessible name of an entry is its label (e2e clicks `button=<label>`).
    expect(screen.getByRole("button", { name: "Widget" })).toHaveTextContent(/^Widget$/);
    expect(screen.getByRole("button", { name: "GitRepositories" })).toHaveTextContent(/^GitRepositories$/);
    expect(screen.getByRole("button", { name: "Pods" })).toHaveTextContent(/^Pods$/);
    // A section and a group of custom resources keep a chevron next to the icon: an SVG of the set that adds no
    // text either, so their whole text is the label (e2e clicks `button[aria-expanded]=<label>`).
    for (const name of ["Flux", "demo.sextant.dev"]) {
      const group = screen.getByRole("button", { name });
      expect(group, name).toHaveTextContent(new RegExp(`^${name.replace(/\./g, "\\.")}$`));
      const chevron = group.querySelector(".sidebar__chevron");
      expect(chevron?.tagName.toLowerCase(), name).toBe("svg");
      expect(chevron).toHaveAttribute("aria-hidden", "true");
      expect(group.querySelectorAll("svg").length, name).toBe(2);
    }
    // A section shown as one link has an icon too.
    expect(iconOf(screen.getByRole("button", { name: "Cluster" }))).not.toBeNull();
  });

  it("are set in the registrations: every section, kind and page of the sidebar names an icon of the set", () => {
    expect(Object.keys(featureModules).length).toBeGreaterThan(0);
    for (const section of [...SIDEBAR_SECTIONS, "settings"] as const) {
      expect(isIconName(SECTION_ICONS[section]), section).toBe(true);
    }
    expect(isIconName(DEFAULT_ENTRY_ICON)).toBe(true);

    const withSidebar = REGISTERED.filter((d) => d.sidebar);
    expect(withSidebar.length).toBeGreaterThan(30);
    for (const def of withSidebar) {
      expect(def.sidebar!.icon && isIconName(def.sidebar!.icon), def.kind.kind).toBe(true);
    }
    const pages = getPages();
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const page of pages) expect(page.icon && isIconName(page.icon), page.id).toBe(true);
  });
});

// Read from disk: the test run does not process CSS (`css: false`).
const sidebarCss = readFileSync(join(process.cwd(), "src/layout/sidebar/sidebar.css"), "utf8");
const layoutCss = readFileSync(join(process.cwd(), "src/layout/layout.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const block = blocks.find(([, sel]) => sel!.split(",").map((s) => s.trim()).join(",") === selector);
  if (!block) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    block[2]!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

describe("long labels", () => {
  it("a custom resource group, a section and an entry keep the full name in a tooltip", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Custom Resources"));
    for (const name of [/Flux/, /Custom Resources/]) fireEvent.click(screen.getByRole("button", { name }));
    expect(await screen.findByRole("button", { name: "demo.sextant.dev" })).toHaveAttribute("title", "demo.sextant.dev");
    expect(screen.getByRole("button", { name: "Flux" })).toHaveAttribute("title", "Flux");
    expect(screen.getByRole("button", { name: "GitRepositories" })).toHaveAttribute("title", "GitRepositories");
  });

  it("the label is one line cut with an ellipsis, never broken inside a word; icon and chevron do not shrink", () => {
    const label = rule(sidebarCss, ".sidebar__label");
    expect(label["white-space"]).toBe("nowrap");
    expect(label["text-overflow"]).toBe("ellipsis");
    expect(label["overflow"]).toBe("hidden");
    expect(label["min-width"]).toBe("0");
    expect(label["overflow-wrap"]).toBeUndefined();
    expect(sidebarCss + layoutCss).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(sidebarCss, ".sidebar__icon")["flex"]).toBe("none");
    expect(rule(sidebarCss, ".sidebar__chevron")["flex"]).toBe("none");
  });
});
