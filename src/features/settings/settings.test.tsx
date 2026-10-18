import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type HelmStatus, type KubeconfigSource, type MockBackend } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { availableLanguages } from "../../i18n";
import { AppShell } from "../../layout";
import { getPage } from "../../layout/pages";
import { resetClustersStore } from "../clusters/clustersStore";
import { resetHelmStatus } from "../helm";
import { SETTINGS_PAGE_ID, languageName, openSettings, resetSettingsUi, selectSettingsTab, type SettingsTab } from "./index";

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

function renderPage(tab?: SettingsTab) {
  const page = getPage(SETTINGS_PAGE_ID);
  if (!page) throw new Error("the settings page is not registered");
  if (tab) selectSettingsTab(tab);
  return render(<page.Component clusterId="c1" />);
}

const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetHelmStatus();
  resetSettingsUi();
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
    // A new install follows the system (jsdom says en-US); then every directory, by its own name.
    expect(within(language).getAllByRole("option").map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["system", "System (English)"],
      ...availableLanguages.map((code) => [code, languageName(code)]),
    ]);
    expect(within(language).getByRole("option", { name: "English" })).toHaveValue("en");
    await waitFor(() => expect(language).toHaveValue("system"));
  });

  it("shows the helm found in PATH and switches to a chosen binary and back", async () => {
    setup({ openFile: () => "/opt/helm/bin/helm" });
    renderPage("clusters");
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
    renderPage("clusters");
    const section = screen.getByRole("region", { name: "Helm" });
    await waitFor(() => expect(section).toHaveTextContent("Helm was not found"));
  });

  it("lists kubeconfig sources and removes an added one after confirmation", async () => {
    setup();
    renderPage("clusters");
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
    renderPage("clusters");
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
    renderPage("clusters");
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
    renderPage("clusters");
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

describe("Settings → Window", () => {
  const KEEP = "Closing the window keeps Sextant in the tray";

  it("is off by default and saves closeToTray when turned on", async () => {
    setup();
    renderPage();
    const section = screen.getByRole("region", { name: "Window" });
    const box = within(section).getByRole("checkbox", { name: KEEP });
    await waitFor(() => expect(box).toBeEnabled());
    expect(box).not.toBeChecked();
    expect(within(section).getByText(/keeps running in the tray/)).toBeInTheDocument();

    fireEvent.click(box);
    await waitFor(() => expect(backend.settings.closeToTray).toBe(true));
    expect(box).toBeChecked();
  });

  it("shows a saved choice", async () => {
    setup({ settings: { closeToTray: true } });
    renderPage();
    const box = within(screen.getByRole("region", { name: "Window" })).getByRole("checkbox", { name: KEEP });
    await waitFor(() => expect(box).toBeChecked());
  });

  it("without a tray icon cannot be turned on and says why", async () => {
    setup();
    backend.on("tray_status", () => ({ available: false }));
    renderPage();
    const section = screen.getByRole("region", { name: "Window" });
    expect(await within(section).findByText(/No system tray was found/)).toBeInTheDocument();
    expect(within(section).getByRole("checkbox", { name: KEEP })).toBeDisabled();
  });

  it("treats a failed tray check as no tray", async () => {
    setup();
    backend.on("tray_status", () => {
      throw { code: "other", message: "boom" };
    });
    renderPage();
    const section = screen.getByRole("region", { name: "Window" });
    expect(await within(section).findByText(/No system tray was found/)).toBeInTheDocument();
    expect(within(section).getByRole("checkbox", { name: KEEP })).toBeDisabled();
  });
});

describe("Settings tabs", () => {
  const regions = () => screen.getAllByRole("region").map((r) => r.querySelector("h2")?.textContent);

  it("groups the sections into five tabs and shows only the selected tab's sections", async () => {
    setup();
    renderPage();
    const list = screen.getByRole("tablist", { name: "Settings sections" });
    expect(within(list).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "General",
      "Clusters",
      "AI agents",
      "Extensions",
      "Updates & About",
    ]);
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(regions()).toEqual(["Appearance", "Window", "Notifications", "Editor"]);

    fireEvent.click(screen.getByRole("tab", { name: "Clusters" }));
    expect(regions()).toEqual(["Kubeconfig", "Helm", "Terminal"]);
    expect(screen.queryByRole("radiogroup", { name: "Theme" })).not.toBeInTheDocument();

    // Keyboard as everywhere else: the arrow moves to the next tab and selects it.
    fireEvent.keyDown(screen.getByRole("tab", { name: "Clusters" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "AI agents" })).toHaveFocus();
    expect(regions()).toEqual(["AI agents (MCP)"]);

    fireEvent.click(screen.getByRole("tab", { name: "Extensions" }));
    expect(regions()).toEqual(["Extensions"]);

    fireEvent.click(screen.getByRole("tab", { name: "Updates & About" }));
    expect(regions()).toEqual(["Updates", "About"]);
    expect(screen.getByRole("tabpanel", { name: "Updates & About" })).toContainElement(
      screen.getByRole("button", { name: "About Sextant" }),
    );
  });

  it("remembers the last tab: the page opens at it again", async () => {
    setup();
    const { unmount } = renderPage();
    fireEvent.click(screen.getByRole("tab", { name: "Clusters" }));
    unmount();
    renderPage();
    expect(screen.getByRole("tab", { name: "Clusters" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: "Helm" })).toBeInTheDocument();
  });

  it("remembers the last tab of the dialog (no cluster) after it is closed", async () => {
    setup();
    render(<AppShell />);
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    let dialog = await screen.findByRole("dialog", { name: "Settings" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Extensions" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    fireEvent.click(within(rail).getByRole("button", { name: "Settings" }));
    dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: "Extensions" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("region", { name: "Extensions" })).toBeInTheDocument();
  });

  it("a link to AI agents opens the page of the active cluster at that tab", async () => {
    setup();
    render(<AppShell />);
    act(() => useAppStore.getState().setActiveCluster("c1"));
    act(() => openSettings({ tab: "agents" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(SETTINGS_PAGE_ID);
    const main = screen.getByRole("main");
    expect(await within(main).findByRole("region", { name: "AI agents (MCP)" })).toBeInTheDocument();
    expect(within(main).getByRole("tab", { name: "AI agents" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("a link to About opens the dialog at Updates & About when no cluster is open", async () => {
    setup();
    render(<AppShell />);
    act(() => openSettings({ tab: "about" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("tab", { name: "Updates & About" })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("button", { name: "About Sextant" })).toBeInTheDocument();
    // Without a tab the link keeps the tab left last.
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    act(() => openSettings());
    expect(
      within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("tab", { name: "Updates & About" }),
    ).toHaveAttribute("aria-selected", "true");
  });
});
