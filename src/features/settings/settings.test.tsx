import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type HelmStatus, type KubeconfigSource, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { AppShell } from "../../layout";
import { getPage } from "../../layout/pages";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { SETTINGS_PAGE_ID } from "./index";

const home: KubeconfigSource = { id: "src-home", path: "/home/me/.kube/config", kind: "default", error: null };
const pasted: KubeconfigSource = { id: "src-pasted", path: "/data/kubeconfigs/pasted-1.yaml", kind: "pasted", error: null };
const cloud: KubeconfigSource = { id: "src-cloud", path: "/data/kubeconfigs/cloud-aws.yaml", kind: "cloud", error: null };
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

  it("shows a failed save as an error with its code and the backend's message", async () => {
    setup();
    renderPage();
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    await waitFor(() => expect(within(theme).getByRole("radio", { name: "System" })).toBeChecked());
    backend.restore();
    backend = mockBackend({
      kubeconfig_sources: () => sources,
      helm_status: () => helm,
      settings_update: () => {
        throw { code: "other", message: "disk is full" };
      },
    });
    fireEvent.click(within(theme).getByRole("radio", { name: "Dark" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save settings");
    expect(alert).toHaveTextContent("disk is full");
    expect(alert).toHaveAttribute("data-code", "other");
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

  it("removes a cloud source like any other, saying what goes with it", async () => {
    setup();
    sources = [home, cloud];
    renderPage();
    const list = within(screen.getByRole("region", { name: "Kubeconfig" })).getByRole("list", {
      name: "Kubeconfig sources",
    });
    fireEvent.click(await within(list).findByRole("button", { name: `Remove ${cloud.path}` }));
    const confirm = await screen.findByRole("dialog", { name: "Remove kubeconfig source?" });
    expect(confirm).toHaveTextContent("Sextant's kubeconfig of these cloud clusters is deleted");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("kubeconfig_remove")).toHaveLength(1));
    expect(calls("kubeconfig_remove")[0]!.args).toEqual({ sourceId: "src-cloud" });
  });

  it("saves the node shell image, and an emptied field goes back to busybox", async () => {
    setup();
    renderPage();
    const section = screen.getByRole("region", { name: "Terminal" });
    const field = within(section).getByRole("textbox", { name: "Node shell image" });
    await waitFor(() => expect(field).toHaveValue("busybox:stable"));

    fireEvent.change(field, { target: { value: " registry.example/tools:1 " } });
    fireEvent.blur(field);
    await waitFor(() => expect(backend.settings.nodeShellImage).toBe("registry.example/tools:1"));

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.submit(field);
    await waitFor(() => expect(backend.settings.nodeShellImage).toBe("busybox:stable"));
    expect(field).toHaveValue("busybox:stable");
  });
});

describe("kubeconfig source errors in Settings", () => {
  it("shows the error of a source next to it, the others stay plain", async () => {
    setup();
    const broken: KubeconfigSource = {
      id: "src-env-bad",
      path: "/home/me/broken.yaml",
      kind: "env",
      error: { code: "kubeconfig", message: "the kubeconfig is not valid YAML (line 3, column 1)" },
    };
    sources = [home, broken];
    renderPage();
    const list = within(screen.getByRole("region", { name: "Kubeconfig" })).getByRole("list", { name: "Kubeconfig sources" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(2));
    const [homeItem, brokenItem] = within(list).getAllByRole("listitem");
    expect(within(brokenItem!).getByText(broken.path)).toBeInTheDocument();
    const alert = within(brokenItem!).getByRole("alert");
    expect(alert).toHaveAttribute("data-code", "kubeconfig");
    expect(alert).toHaveTextContent("line 3, column 1");
    expect(within(homeItem!).queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("settings file banner", () => {
  const banner = () => screen.findByRole("alert", { name: "Settings file" });

  it("says the file cannot be read and changes are not saved, with the file's path", async () => {
    setup();
    backend.on("settings_status", () => ({
      writable: false,
      backupPath: null,
      error: { code: "forbidden", message: "cannot read /cfg/sextant/settings.json: Permission denied (os error 13)" },
    }));
    render(<AppShell />);
    const alert = await banner();
    expect(alert).toHaveTextContent("Changes are not saved");
    expect(alert).toHaveTextContent("/cfg/sextant/settings.json");

    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert", { name: "Settings file" })).not.toBeInTheDocument();
  });

  it("names the copy of a damaged file", async () => {
    setup();
    backend.on("settings_status", () => ({
      writable: true,
      backupPath: "/cfg/sextant/settings.json.bak-20261012-153012",
      error: { code: "invalid", message: "/cfg/sextant/settings.json is not valid (expected value at line 1 column 1)" },
    }));
    render(<AppShell />);
    const alert = await banner();
    expect(alert).toHaveTextContent("/cfg/sextant/settings.json.bak-20261012-153012");
    expect(alert).not.toHaveTextContent("Changes are not saved");
  });

  it("is not shown when the file is fine", async () => {
    setup();
    backend.on("settings_status", () => ({ writable: true, backupPath: null, error: null }));
    render(<AppShell />);
    await waitFor(() => expect(calls("settings_status")).toHaveLength(1));
    expect(screen.queryByRole("alert", { name: "Settings file" })).not.toBeInTheDocument();
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
