import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockBackend, type ClusterInfo, type KubeconfigSource, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { AppShell } from "../../layout";
import { resetClusterKinds, useClusterKinds } from "../../resources";
import { connectCluster, resetClustersStore } from "./clustersStore";
import "./index";
import { registerClusterSettingsSection, unregisterClusterSettingsSection } from "./settingsRegistry";
import { VIEW_PERSIST_DELAY_MS } from "./viewPersistence";

const homeConfig: KubeconfigSource = { id: "src-home", path: "/home/me/.kube/config", kind: "default" };

function cluster(id: string, context: string, sourceId = "src-home"): ClusterInfo {
  return {
    id,
    context,
    clusterName: `${context}-cluster`,
    server: `https://${context}.example:6443`,
    user: "admin",
    namespace: null,
    sourceId,
  };
}

const alpha = cluster("aaaa", "kind-alpha");
const beta = cluster("bbbb", "kind-beta", "src-env2");

let backend: MockBackend;

/** A backend with `clusters` in the kubeconfig whose connect requests resolve or fail as `connect` says. */
function setup(
  clusters: ClusterInfo[],
  options: {
    sources?: KubeconfigSource[];
    connect?: (id: string) => unknown;
    backend?: Parameters<typeof mockBackend>[1];
  } = {},
) {
  let list = [...clusters];
  let sources = options.sources ?? [homeConfig];
  backend = mockBackend(
    {
      clusters_list: () => list,
      kubeconfig_sources: () => sources,
      cluster_state: () => ({ state: "disconnected" }),
      cluster_connect: (args) => options.connect?.(args.clusterId as string),
      cluster_disconnect: () => undefined,
    },
    options.backend ?? {},
  );
  return {
    setClusters(next: ClusterInfo[]) {
      list = next;
    },
    setSources(next: KubeconfigSource[]) {
      sources = next;
    },
  };
}

const rail = () => screen.getByRole("navigation", { name: "Clusters" });
const railButton = (name: string) => within(rail()).getByRole("button", { name });
const commands = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
});
afterEach(() => {
  resetClustersStore();
  backend.restore();
  vi.useRealTimers();
});

describe("cluster rail", () => {
  it("shows every context from every kubeconfig file", async () => {
    setup([alpha, beta], { sources: [{ id: "src-home", path: "/a.yaml", kind: "env" }, { id: "src-env2", path: "/b.yaml", kind: "env" }] });
    render(<AppShell />);
    expect(await within(rail()).findByRole("button", { name: "kind-alpha" })).toBeInTheDocument();
    expect(railButton("kind-beta")).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveTextContent("Select a cluster on the left to connect.");
  });

  it("clicking a cluster shows connecting, then opens it", async () => {
    let finish: () => void = () => {};
    setup([alpha], { connect: () => new Promise<void>((resolve) => (finish = resolve)) });
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));

    expect(await screen.findByText("Connecting to kind-alpha…")).toBeInTheDocument();
    expect(railButton("kind-alpha")).toHaveAttribute("data-state", "connecting");
    expect(commands("cluster_connect")[0]?.args).toEqual({ clusterId: "aaaa" });

    await act(async () => finish());
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
    expect(railButton("kind-alpha")).toHaveAttribute("data-state", "connected");
    expect(railButton("kind-alpha")).toHaveAttribute("aria-current", "true");
  });

  it("an unreachable cluster shows the error in words and Reconnect connects it", async () => {
    let fail = true;
    setup([alpha], {
      connect: () => {
        if (fail) throw { code: "unreachable", message: "client error (Connect): Connection refused (os error 111)" };
      },
    });
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-code", "unreachable");
    expect(alert).toHaveTextContent("Cannot connect to kind-alpha");
    expect(alert).toHaveTextContent("The cluster cannot be reached.");
    expect(alert).toHaveTextContent("Connection refused");
    expect(railButton("kind-alpha")).toHaveAttribute("data-state", "error");
    expect(useAppStore.getState().activeClusterId).toBeNull();

    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));
    expect(commands("cluster_connect")).toHaveLength(2);
  });

  it.each([
    ["unauthorized", "Unauthorized", "The cluster did not accept the credentials (401)."],
    ["authPlugin", "exec: executable aws not found", "The authentication plugin from the kubeconfig is missing or failed."],
    ["kubeconfig", "failed to load client certificate", "The kubeconfig cannot be read or is not valid."],
    ["unreachable", "invalid peer certificate: UnknownIssuer", "The server certificate was not accepted."],
  ])("connection error %s reads as words", async (code, message, text) => {
    setup([alpha], {
      connect: () => {
        throw { code, message };
      },
    });
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("keeps two clusters connected; switching A→B→A returns to A's section and namespaces", async () => {
    setup([alpha, beta]);
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));
    act(() => {
      useAppStore.getState().setView("aaaa", "pods");
      useAppStore.getState().setNamespaces("aaaa", ["team-a"]);
    });

    fireEvent.click(railButton("kind-beta"));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("bbbb"));
    act(() => useAppStore.getState().setView("bbbb", "nodes"));

    fireEvent.click(railButton("kind-alpha"));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));
    expect(useAppStore.getState().clusterViews.aaaa).toMatchObject({ view: "pods", namespaces: ["team-a"] });
    expect(useAppStore.getState().clusterViews.bbbb?.view).toBe("nodes");
    // Both stay connected: going back to A did not connect again.
    expect(commands("cluster_connect").map((c) => c.args.clusterId)).toEqual(["aaaa", "bbbb"]);
    expect(railButton("kind-beta")).toHaveAttribute("data-state", "connected");
  });

  it("follows cluster-state events from the backend", async () => {
    setup([alpha]);
    render(<AppShell />);
    await within(rail()).findByRole("button", { name: "kind-alpha" });
    act(() => backend.emit("cluster-state", { clusterId: "aaaa", state: { state: "connected" } }));
    expect(railButton("kind-alpha")).toHaveAttribute("data-state", "connected");
  });

  it("forgets the cluster's kinds when it connects again: a CRD created meanwhile shows after Reconnect", async () => {
    const pod = { kindRef: { group: "", version: "v1", kind: "Pod" }, plural: "pods", namespaced: true, verbs: [], printerColumns: [] };
    const widget = { ...pod, kindRef: { group: "demo.sextant.dev", version: "v1", kind: "Widget" }, plural: "widgets" };
    let served = [pod];
    setup([alpha], { connect: () => undefined });
    backend.on("cluster_kinds", () => served);
    function Probe() {
      const { kinds } = useClusterKinds("aaaa");
      return <p data-testid="kinds">{kinds?.map((k) => k.kindRef.kind).join(",")}</p>;
    }
    resetClusterKinds();
    try {
      await act(async () => connectCluster("aaaa"));
      render(<Probe />);
      await waitFor(() => expect(screen.getByTestId("kinds")).toHaveTextContent("Pod"));

      served = [pod, widget];
      await act(async () => connectCluster("aaaa"));
      await waitFor(() => expect(screen.getByTestId("kinds")).toHaveTextContent("Pod,Widget"));
    } finally {
      resetClusterKinds();
    }
  });

  it("disconnect from the context menu closes the cluster", async () => {
    setup([alpha]);
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));

    fireEvent.contextMenu(railButton("kind-alpha"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Disconnect" }));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBeNull());
    expect(commands("cluster_disconnect")[0]?.args).toEqual({ clusterId: "aaaa" });
    expect(railButton("kind-alpha")).toHaveAttribute("data-state", "disconnected");
  });

  it("Refresh re-reads the kubeconfig and picks up a new context", async () => {
    const backendCtl = setup([alpha]);
    render(<AppShell />);
    await within(rail()).findByRole("button", { name: "kind-alpha" });
    backendCtl.setClusters([alpha, cluster("cccc", "kind-gamma")]);
    fireEvent.click(within(rail()).getByRole("button", { name: "Refresh kubeconfig" }));
    expect(await within(rail()).findByRole("button", { name: "kind-gamma" })).toBeInTheDocument();
  });
});

describe("no clusters", () => {
  it("shows the checked paths and adds a kubeconfig file chosen in the dialog", async () => {
    const ctl = setup([], { backend: { openFile: () => "/home/me/team.yaml" } });
    render(<AppShell />);
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("heading", { name: "No clusters found" })).toBeInTheDocument();
    expect(within(main).getByRole("list", { name: "Checked paths" })).toHaveTextContent("/home/me/.kube/config");

    backend.on("kubeconfig_add_file", () => {
      ctl.setClusters([cluster("ffff", "team", "src-team")]);
      return { id: "src-team", path: "/home/me/team.yaml", kind: "addedFile" };
    });
    fireEvent.click(within(main).getByRole("button", { name: "Add kubeconfig file" }));
    expect(await within(rail()).findByRole("button", { name: "team" })).toBeInTheDocument();
    expect(commands("kubeconfig_add_file")[0]?.args).toEqual({ path: "/home/me/team.yaml" });
  });

  it("pasted kubeconfig is sent to the backend; an invalid one shows the error and keeps the text", async () => {
    const ctl = setup([]);
    render(<AppShell />);
    const main = screen.getByRole("main");
    fireEvent.click(await within(main).findByRole("button", { name: "Paste kubeconfig" }));
    const dialog = screen.getByRole("dialog", { name: "Paste kubeconfig" });
    const textarea = within(dialog).getByRole("textbox", { name: "Kubeconfig" });

    backend.on("kubeconfig_add_pasted", () => {
      throw { code: "kubeconfig", message: "the kubeconfig is not valid YAML (line 1, column 5)" };
    });
    fireEvent.change(textarea, { target: { value: "not: [yaml" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The kubeconfig cannot be read or is not valid.");
    expect(textarea).toHaveValue("not: [yaml");

    backend.on("kubeconfig_add_pasted", (args) => {
      ctl.setClusters([cluster("pppp", "pasted-ctx", "src-p")]);
      return { id: "src-p", path: "/data/kubeconfigs/pasted-1.yaml", kind: "pasted", text: args.text };
    });
    fireEvent.change(textarea, { target: { value: "apiVersion: v1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(rail()).findByRole("button", { name: "pasted-ctx" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(commands("kubeconfig_add_pasted").at(-1)?.args).toEqual({ text: "apiVersion: v1" });
  });

  it("an added source can be removed after confirmation; its clusters disappear", async () => {
    const added: KubeconfigSource = { id: "src-team", path: "/home/me/team.yaml", kind: "addedFile" };
    const ctl = setup([cluster("ffff", "team", "src-team")], { sources: [homeConfig, added] });
    backend.on("kubeconfig_remove", () => {
      ctl.setClusters([]);
      ctl.setSources([homeConfig]);
    });
    render(<AppShell />);
    await within(rail()).findByRole("button", { name: "team" });

    fireEvent.click(within(rail()).getByRole("button", { name: "Add cluster" }));
    const dialog = screen.getByRole("dialog", { name: "Add cluster" });
    const sources = within(dialog).getByRole("list", { name: "Kubeconfig sources" });
    expect(within(sources).getAllByRole("listitem")).toHaveLength(2);
    // The default location cannot be removed.
    expect(within(sources).getAllByRole("button", { name: /^Remove/ })).toHaveLength(1);
    fireEvent.click(within(sources).getByRole("button", { name: "Remove /home/me/team.yaml" }));
    expect(commands("kubeconfig_remove")).toHaveLength(0);

    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove kubeconfig source?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(within(rail()).queryByRole("button", { name: "team" })).not.toBeInTheDocument());
    expect(commands("kubeconfig_remove")[0]?.args).toEqual({ sourceId: "src-team" });
  });
});

describe("cluster settings", () => {
  it("display name and color are saved in the settings and shown in the rail", async () => {
    setup([alpha]);
    render(<AppShell />);
    fireEvent.contextMenu(await within(rail()).findByRole("button", { name: "kind-alpha" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    const dialog = screen.getByRole("dialog", { name: "Cluster settings — kind-alpha" });

    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    fireEvent.change(name, { target: { value: "Production" } });
    fireEvent.blur(name);
    await waitFor(() => expect(backend.settings.clusters.aaaa?.displayName).toBe("Production"));
    expect(await within(rail()).findByRole("button", { name: "Production" })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Color 5" }));
    await waitFor(() => expect(backend.settings.clusters.aaaa?.color).toBe("#ce3933"));
    expect(railButton("Production").style.getPropertyValue("--cluster-color")).toBe("#ce3933");
    expect(backend.settings.clusters.aaaa).toMatchObject({ prometheus: { mode: "auto" }, usageSource: "auto" });
  });

  it("shows sections registered by other features", async () => {
    registerClusterSettingsSection({
      id: "test-metrics",
      order: 50,
      titleKey: "test:metrics",
      Component: ({ clusterId }) => <p>metrics of {clusterId}</p>,
    });
    try {
      setup([alpha]);
      render(<AppShell />);
      fireEvent.contextMenu(await within(rail()).findByRole("button", { name: "kind-alpha" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
      expect(screen.getByRole("dialog")).toHaveTextContent("metrics of aaaa");
    } finally {
      unregisterClusterSettingsSection("test-metrics");
    }
  });
});

describe("restart", () => {
  it("reopens the last active cluster in its last section and connects to it", async () => {
    setup([alpha, beta], {
      backend: {
        settings: {
          window: { sidebarWidth: 220, dockHeight: 300, dockOpen: false, lastCluster: "bbbb", width: null, height: null, maximized: false },
          clusters: {
            bbbb: { displayName: null, color: null, namespaces: null, lastView: "nodes", prometheus: { mode: "auto" }, usageSource: "auto" },
          },
        },
      },
    });
    render(<AppShell />);
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("bbbb"));
    expect(useAppStore.getState().clusterViews.bbbb?.view).toBe("nodes");
    expect(commands("cluster_connect").map((c) => c.args.clusterId)).toEqual(["bbbb"]);
  });

  it("saves the open section of a cluster as its last view", async () => {
    setup([alpha]);
    render(<AppShell />);
    fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));
    await waitFor(() => expect(useAppStore.getState().activeClusterId).toBe("aaaa"));
    act(() => useAppStore.getState().setView("aaaa", "deployments"));
    await waitFor(() => expect(backend.settings.clusters.aaaa?.lastView).toBe("deployments"), {
      timeout: VIEW_PERSIST_DELAY_MS + 1000,
    });
  });
});
