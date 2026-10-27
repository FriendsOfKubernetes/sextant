import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type AccessQuery, type MockBackend, type ResourceKind, type WatchSpec } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { MainView } from "../../layout/main/MainView";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { defaultClusterSettings } from "../clusters/clusterSettings";
import { resetClustersStore, useClustersStore } from "../clusters/clustersStore";
import { getAccess } from "./accessStore";
import { resetNamespaceRestore } from "./namespaces";

const kind = (group: string, version: string, k: string, plural: string, namespaced: boolean): ResourceKind => ({
  kindRef: { group, version, kind: k },
  plural,
  namespaced,
  verbs: ["get", "list", "watch"],
  printerColumns: [],
});

const KINDS: ResourceKind[] = [
  kind("", "v1", "Pod", "pods", true),
  kind("apps", "v1", "Deployment", "deployments", true),
  kind("", "v1", "Node", "nodes", false),
];

let backend: MockBackend;
let watches: WatchSpec[];

beforeEach(() => {
  resetAppStore();
  resetNamespaceRestore();
  resetClusterKinds();
  resetClustersStore();
  watches = [];
  backend = mockBackend(
    {
      cluster_kinds: () => KINDS,
      rbac_can_i: (args) =>
        (args.queries as AccessQuery[]).map((q) => ({
          // Pods in team-a only; neither Namespaces, Nodes nor anything else.
          allowed: q.resource === "pods" && q.namespace === "team-a",
          denied: false,
          reason: "",
          evaluationError: "",
        })),
      rbac_whoami: () => null,
      rbac_rules_review: (args) => ({
        namespace: args.namespace,
        resourceRules: [{ verbs: ["get", "list", "watch"], apiGroups: [""], resources: ["pods", "pods/log"], resourceNames: [] }],
        nonResourceRules: [],
        incomplete: false,
        evaluationError: "",
      }),
      resource_count: () => ({ count: 0, exact: true }),
      watch_start: (args) => {
        watches.push(args.spec as WatchSpec);
        return `watch-${watches.length}`;
      },
      watch_stop: () => undefined,
    },
    { settings: { clusters: { c1: { ...defaultClusterSettings(), knownNamespaces: ["team-a"] } } } },
  );
  useClustersStore.setState({
    clusters: [{ id: "c1", context: "c1", clusterName: "c1", server: "https://x", user: "u", namespace: null, sourceId: "s" }],
  });
});

afterEach(() => {
  resetNamespaceRestore();
  resetClustersStore();
  backend.restore();
});

async function connected(view: string): Promise<void> {
  act(() => useAppStore.getState().setView("c1", view));
  render(
    <>
      <nav>
        <Sidebar clusterId="c1" />
      </nav>
      <main>
        <MainView clusterId="c1" />
      </main>
    </>,
  );
  act(() => useClustersStore.setState({ states: { c1: { state: "connected" } } }));
  await waitFor(() => expect(getAccess("c1").status).toBe("ready"));
}

describe("kinds the user may not list (#285)", () => {
  it("says “No access” once instead of a refused watch, and lists anyway on request", async () => {
    await connected("kind:apps/Deployment");
    const main = screen.getByRole("main");
    await within(main).findByText("No access to Deployments");
    expect(main.textContent).toContain("The API server says you may not list Deployments in team-a.");
    expect(watches.some((s) => s.kind.kind === "Deployment")).toBe(false);
    // The namespace filter stays, so other namespaces can be chosen.
    expect(within(main).getByRole("button", { name: "Namespaces: All accessible (1)" })).toBeTruthy();
    expect(await axeViolations(document)).toEqual([]);

    fireEvent.click(within(main).getByRole("button", { name: "List anyway" }));
    await waitFor(() => expect(watches.some((s) => s.kind.kind === "Deployment")).toBe(true));
    expect(watches.find((s) => s.kind.kind === "Deployment")?.namespaces).toEqual(["team-a"]);
  });

  it("lists a kind the user may read in the accessible namespaces, and marks the ones that cannot be read", async () => {
    await connected("kind:/Pod");
    await waitFor(() => expect(watches.some((s) => s.kind.kind === "Pod")).toBe(true));
    expect(watches.filter((s) => s.kind.kind === "Pod").at(-1)?.namespaces).toEqual(["team-a"]);
    // Nodes (cluster-scoped, refused) carry the mark in the sidebar; Pods do not.
    const nav = screen.getByRole("navigation");
    await waitFor(() => expect(within(nav).getAllByTitle("No access").length).toBeGreaterThan(0));
    const marked = within(nav)
      .getAllByTitle("No access")
      .map((el) => el.closest("button")?.getAttribute("title"));
    expect(marked).toContain("Nodes");
    expect(marked).not.toContain("Pods");
  });

  it("says when no namespace is known at all", async () => {
    backend.on("settings_get", () => ({ ...backend.settings, clusters: {} }));
    await connected("kind:/Pod");
    // No known namespace and no namespace from the context: nothing can be listed.
    const main = screen.getByRole("main");
    await within(main).findByText("No namespace to show");
    expect(watches.some((s) => s.kind.kind === "Pod")).toBe(false);
  });
});
