// Terminal tools (ADR-0132): the kubectl offer above a cluster's terminal and Settings → "Terminal tools".
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, mockBackend, type AppSettings, type InstalledTool, type MockBackend } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { axeViolations } from "../../test/axe";
import { KubectlBar, resetKubectlOffers } from "./KubectlBar";
import { InstallHelm, ToolsPanel } from "./ToolsPanel";

let backend: MockBackend;

beforeEach(() => {
  resetSettingsCache();
  resetKubectlOffers();
});

describe("the kubectl offer", () => {
  it("names the cluster's version and installs kubectl for that cluster only", async () => {
    backend = mockBackend({
      tools_kubectl_offer: () => ({ need: { type: "missing" }, server: "1.37" }),
      tools_install: () => ({ tool: "kubectl", version: "v1.37.2", bytes: 1 }),
    });
    render(<KubectlBar clusterId="c1" />);
    expect(await screen.findByText(/kubectl is not installed\. Sextant can install kubectl 1\.37/)).toBeTruthy();
    expect(await axeViolations(document.body)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Install kubectl 1.37" }));
    expect(await screen.findByText(/kubectl v1\.37\.2 is installed\. New terminals of this cluster use it\./)).toBeTruthy();
    // The window names the tool and the cluster, never a version or a URL.
    expect(backend.calls.find((c) => c.cmd === "tools_install")?.args).toEqual({ tool: "kubectl", clusterId: "c1" });
  });

  it("tells the found version when it is out of skew, and shows a failure with the offer again", async () => {
    backend = mockBackend({
      tools_kubectl_offer: () => ({ need: { type: "outOfSkew", found: "v1.30.1" }, server: "1.37" }),
      tools_install: () => {
        throw { code: "other", message: "no network" };
      },
    });
    render(<KubectlBar clusterId="c1" />);
    expect(await screen.findByText(/This kubectl \(v1\.30\.1\) is too far from the cluster's version 1\.37/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Install kubectl 1.37" }));
    expect(await screen.findByText(/kubectl could not be installed: no network/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install kubectl 1.37" })).toBeTruthy();
  });

  it("is put off for this run by Not now, and turned off by Don't ask again", async () => {
    backend = mockBackend({ tools_kubectl_offer: () => ({ need: { type: "missing" }, server: "1.37" }) });
    const first = render(<KubectlBar clusterId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("status")).toBeNull();
    first.unmount();
    render(<KubectlBar clusterId="c1" />);
    await Promise.resolve();
    expect(backend.calls.filter((c) => c.cmd === "tools_kubectl_offer")).toHaveLength(1);

    render(<KubectlBar clusterId="c2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Don't ask again" }));
    await waitFor(() => {
      const saved = backend.calls.filter((c) => c.cmd === "settings_update").at(-1)?.args.settings as AppSettings;
      expect(saved.terminalTools.offerKubectl).toBe(false);
    });
  });
});

describe("Settings → Terminal tools", () => {
  function renderPanel(installed: InstalledTool[]) {
    let list = installed;
    backend = mockBackend({
      tools_list: () => ({ dir: "/data/tools", installed: list, supported: true }),
      tools_latest: () => "v4.3.1",
      tools_install: (args) => {
        const tool = args.tool as string;
        const item = { tool, version: tool === "helm" ? "v4.3.1" : "v0.51.0", bytes: 50 * 1024 * 1024 } as InstalledTool;
        list = [...list, item];
        return item;
      },
      tools_remove: (args) => {
        const { tool, version } = args as { tool: string; version: string };
        list = list.filter((i) => i.tool !== tool || i.version !== version);
      },
      helm_status: () => ({ available: true, path: "/data/tools/helm/v4.3.1/helm", version: "v4.3.1" }),
    });
    return render(<ToolsPanel settings={defaultAppSettings()} save={async () => true} />);
  }

  it("installs, checks and removes a tool, asking a source only on a click", async () => {
    renderPanel([{ tool: "kubectl", version: "v1.37.2", bytes: 60 * 1024 * 1024 }]);
    expect(await screen.findByText("Folder: /data/tools")).toBeTruthy();
    expect(screen.getByText(/v1\.37\.2/)).toBeTruthy();
    expect(backend.calls.some((c) => c.cmd === "tools_latest" || c.cmd === "tools_install")).toBe(false);
    expect(await axeViolations(document.body)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Install k9s" }));
    expect(await screen.findByRole("button", { name: "Check for updates of k9s" })).toBeTruthy();
    expect(backend.calls.find((c) => c.cmd === "tools_install")?.args).toEqual({ tool: "k9s", clusterId: null });

    fireEvent.click(screen.getByRole("button", { name: "Check for updates of k9s" }));
    fireEvent.click(await screen.findByRole("button", { name: "Update k9s to v4.3.1" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "tools_install")).toHaveLength(2));

    fireEvent.click(await screen.findByRole("button", { name: "Remove kubectl v1.37.2" }));
    await waitFor(() =>
      expect(backend.calls.find((c) => c.cmd === "tools_remove")?.args).toEqual({ tool: "kubectl", version: "v1.37.2" }),
    );
  });

  it("shows a Helm installed from the Helm section in a list already on screen", async () => {
    renderPanel([]);
    render(<InstallHelm />);
    expect(await screen.findByRole("button", { name: "Install Helm" })).toBeTruthy();
    const installs = screen.getAllByRole("button", { name: "Install Helm" });
    // The Helm section's button has no extra name; the list's is "Install Helm" too, by its aria-label.
    fireEvent.click(installs[installs.length - 1] as HTMLElement);
    expect(await screen.findByRole("button", { name: "Check for updates of Helm" })).toBeTruthy();
    expect(backend.calls.filter((c) => c.cmd === "tools_install")).toHaveLength(1);
  });

  it("says when this computer gets no tools", async () => {
    backend = mockBackend({ tools_list: () => ({ dir: "/data/tools", installed: [], supported: false }) });
    render(<ToolsPanel settings={null} save={async () => true} />);
    expect(await screen.findByText(/Sextant offers no tools for this operating system or processor/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install Helm" })).toBeNull();
  });
});
