import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Icon, isIconName, renderIcon, type IconName } from "./icons";

// Names the other tasks of this release rely on (interfaces.md §1, spec «Иконки разделов»): actions and glyphs of
// story 7, the eye toggle, the cluster rail (expand, picture, reset) and every sidebar section and entry.
const REQUIRED: IconName[] = [
  // actions and glyphs
  "logs", "shell", "portForward", "edit", "delete", "scale", "restart", "cordon", "drain", "trigger", "suspend",
  "resume", "reconcile", "reconcileWithSource", "sync", "refresh", "hardRefresh", "terminate", "external", "diff",
  "more", "close", "chevronDown", "chevronUp", "chevronRight", "settings", "menu", "add", "warning",
  "eye", "eyeOff", "download", "rollback", "sortAsc", "sortDesc",
  // cluster rail
  "expandRail", "collapseRail", "image", "reset",
  // sidebar sections
  "cluster", "nodes", "workloads", "config", "network", "storage", "namespaces", "events", "helm", "accessControl",
  "flux", "argocd", "customResources",
  // sidebar entries
  "pod", "deployment", "daemonSet", "statefulSet", "replicaSet", "job", "cronJob", "configMap", "secret",
  "resourceQuota", "limitRange", "horizontalPodAutoscaler", "podDisruptionBudget", "priorityClass", "service",
  "endpoints", "ingress", "ingressClass", "networkPolicy", "persistentVolumeClaim", "persistentVolume",
  "storageClass", "serviceAccount", "clusterRole", "role", "clusterRoleBinding", "roleBinding", "node", "namespace",
  "portForwarding", "helmChart", "helmRelease", "overview", "customResource", "customResourceDefinition",
  "gitRepository", "ociRepository", "helmRepository", "fluxHelmChart", "bucket", "kustomization", "fluxHelmRelease",
  "imageRepository", "imagePolicy", "imageUpdateAutomation", "alert", "provider", "receiver", "argoApplication",
  "argoApplicationSet", "argoAppProject",
];

/** Names of the set, read from the `ICONS` table of icons.tsx. */
function namesOfTheSet(): string[] {
  const source = import.meta.glob<string>("./icons.tsx", { query: "?raw", import: "default", eager: true })["./icons.tsx"]!;
  const table = /const ICONS = \{([\s\S]*?)\n\} satisfies/.exec(source)![1]!;
  return [...table.matchAll(/^\s+(\w+): \w+,/gm)].map((m) => m[1]!);
}

describe("Icon", () => {
  it("has every icon the release needs, each one an SVG drawn in the text color", () => {
    for (const name of REQUIRED) {
      expect(isIconName(name), name).toBe(true);
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg!.getAttribute("stroke"), name).toBe("currentColor");
      unmount();
    }
  });

  it("is hidden from assistive technology and adds no text to the button it is in", () => {
    const { container } = render(
      <button type="button">
        <Icon name="logs" />
        Logs
      </button>,
    );
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg.querySelector("title")).toBeNull();
    expect(svg.textContent).toBe("");
    expect(container.querySelector("button")).toHaveAccessibleName("Logs");
  });

  it("is 16 px through the shared token unless a size is given", () => {
    const { container } = render(
      <>
        <Icon name="add" />
        <Icon name="add" size={20} className="extra" />
      </>,
    );
    const [plain, sized] = [...container.querySelectorAll("svg")];
    expect(plain!.style.width).toBe("var(--icon-size)");
    expect(plain!.style.height).toBe("var(--icon-size)");
    expect(sized!.style.width).toBe("20px");
    expect(sized).toHaveClass("extra");
  });
});

describe("the set", () => {
  it("has no unused names: every name is used by the app outside icons.tsx", () => {
    const names = namesOfTheSet();
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) expect(isIconName(name), name).toBe(true);
    const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/components/icons.tsx"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const text = Object.values(sources).join("\n");
    const unused = names.filter((name) => !new RegExp(`["'\`]${name}["'\`]`).test(text));
    expect(unused).toEqual([]);
    // "default" is a common word in the sources, so the search above cannot tell; the set has no such name.
    expect(isIconName("default")).toBe(false);
  });
});

describe("isIconName", () => {
  it("tells names of the set from glyphs and from inherited object keys", () => {
    expect(isIconName("eye")).toBe(true);
    expect(isIconName("≡")).toBe(false);
    expect(isIconName("x")).toBe(false);
    expect(isIconName("constructor")).toBe(false);
    expect(isIconName("toString")).toBe(false);
  });
});

describe("renderIcon", () => {
  it("draws a name of the set as an SVG and any other string as a hidden glyph; nothing for undefined", () => {
    const { container } = render(
      <>
        <span data-testid="name">{renderIcon("delete")}</span>
        <span data-testid="glyph">{renderIcon("⋯")}</span>
        <span data-testid="none">{renderIcon(undefined)}</span>
      </>,
    );
    const [name, glyph, none] = ["name", "glyph", "none"].map((id) => container.querySelector(`[data-testid=${id}]`)!);
    expect(name!.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(glyph!.querySelector("svg")).toBeNull();
    expect(glyph!.textContent).toBe("⋯");
    expect(glyph!.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(none!.childNodes).toHaveLength(0);
  });
});
