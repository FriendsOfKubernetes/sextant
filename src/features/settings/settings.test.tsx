import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type HelmStatus, type KubeconfigSource, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { AppShell } from "../../layout";
import { getPage } from "../../layout/pages";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { SETTINGS_PAGE_ID } from "./index";

const home: KubeconfigSource = { id: "src-home", path: "/home/me/.kube/config", kind: "default" };
const pasted: KubeconfigSource = { id: "src-pasted", path: "/data/kubeconfigs/pasted-1.yaml", kind: "pasted" };
const FOUND: HelmStatus = { available: true, version: "v4.3.0", path: "/usr/local/bin/helm" };
const MISSING: HelmStatus = { available: false, version: null, path: null };

let backend: MockBackend;
let sources: KubeconfigSource[];
let helm: HelmStatus;

function setup(options: Parameters<typeof mockBackend>[1] = {}) {
  sources = [home, pasted];
  helm = FOUND;
  backend = mockBackend(
    {
      clusters_list: () => [],
      kubeconfig_sources: () => sources,
      kubeconfig_remove: (args) => {
        sources = sources.filter((s) => s.id !== args.sourceId);
      },
      cluster_state: () => ({ state: "disconnected" }),
      helm_status: () => helm,
    },
    options,
  );
}

function renderPage() {
  const page = getPage(SETTINGS_PAGE_ID);
  if (!page) throw new Error("the settings page is not registered");
  return render(<page.Component clusterId="c1" />);
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetHelmStatus();
});
afterEach(() => backend.restore());

describe("Settings page", () => {
  it("is a sidebar page and changes the theme", async () => {
    setup();
    expect(getPage(SETTINGS_PAGE_ID)?.labelKey).toBe("settings:page.title");
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    await waitFor(() => expect(within(theme).getByRole("radio", { name: "System" })).toBeChecked());

    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(backend.settings.theme).toBe("dark"));
    expect(within(theme).getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("offers the languages found in src/locales", async () => {
    setup();
    renderPage();
    const language = screen.getByRole("combobox", { name: "Language" });
    expect(within(language).getAllByRole("option").map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["en", "English"],
    ]);
    await waitFor(() => expect(language).toHaveValue("en"));
  });

  it("shows the helm found in PATH and switches to a chosen binary and back", async () => {
    setup({ openFile: () => "/opt/helm/bin/helm" });
    renderPage();
    const section = screen.getByRole("region", { name: "Helm" });
    await waitFor(() => expect(section).toHaveTextContent("Helm v4.3.0 at /usr/local/bin/helm"));
    expect(within(section).getByRole("radio", { name: "Find helm in PATH" })).toBeChecked();

    fireEvent.click(within(section).getByRole("radio", { name: "Use this binary" }));
    fireEvent.click(within(section).getByRole("button", { name: "Browse…" }));
    const input = within(section).getByRole("textbox", { name: "Path to helm" });
    await waitFor(() => expect(input).toHaveValue("/opt/helm/bin/helm"));
    helm = { available: true, version: "v3.17.0", path: "/opt/helm/bin/helm" };
    const statusChecks = calls("helm_status").length;
    fireEvent.click(within(section).getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(backend.settings.helmPath).toBe("/opt/helm/bin/helm"));
    await waitFor(() => expect(section).toHaveTextContent("Helm v3.17.0 at /opt/helm/bin/helm"));
    expect(calls("helm_status").length).toBeGreaterThan(statusChecks);

    helm = FOUND;
    fireEvent.click(within(section).getByRole("radio", { name: "Find helm in PATH" }));
    await waitFor(() => expect(backend.settings.helmPath).toBeNull());
    await waitFor(() => expect(section).toHaveTextContent("Helm v4.3.0 at /usr/local/bin/helm"));
  });

  it("says when helm is not found", async () => {
    setup();
    helm = MISSING;
    renderPage();
    const section = screen.getByRole("region", { name: "Helm" });
    await waitFor(() => expect(section).toHaveTextContent("Helm was not found"));
  });

  it("lists kubeconfig sources and removes an added one after confirmation", async () => {
    setup();
    renderPage();
    const section = screen.getByRole("region", { name: "Kubeconfig" });
    const list = within(section).getByRole("list", { name: "Kubeconfig sources" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    expect(within(list).queryByRole("button", { name: `Remove ${home.path}` })).not.toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Add kubeconfig file" })).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Paste kubeconfig" })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: `Remove ${pasted.path}` }));
    const confirm = await screen.findByRole("dialog", { name: "Remove kubeconfig source?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("kubeconfig_remove")).toHaveLength(1));
    expect(calls("kubeconfig_remove")[0]!.args).toEqual({ sourceId: "src-pasted" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
  });
});

describe("Settings button in the cluster rail", () => {
  it("opens the settings page of the active cluster", async () => {
    setup();
    render(<AppShell />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(SETTINGS_PAGE_ID);
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });

  it("without an open cluster shows the settings in a dialog", async () => {
    setup();
    render(<AppShell />);
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });
});
