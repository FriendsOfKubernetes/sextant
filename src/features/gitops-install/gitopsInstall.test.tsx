import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type ClusterInfo,
  type InstallEvent,
  type InstallPreview,
  type MockBackend,
  type MockHandler,
  type ResourceKind,
} from "../../api";
import { resetAppStore } from "../../app/store";
import { AppShell } from "../../layout";
import { resetClusterKinds } from "../../resources";
import "../clusters";
import { openClusterSettings, resetClustersStore } from "../clusters/clustersStore";
import "./index";
import { closeInstall } from "./store";

const alpha: ClusterInfo = {
  id: "aaaa",
  context: "kind-alpha",
  clusterName: "kind-alpha-cluster",
  server: "https://kind-alpha.example:6443",
  user: "admin",
  namespace: null,
  sourceId: "src-home",
};

function kind(group: string, version: string, name: string, plural: string): ResourceKind {
  return {
    kindRef: { group, version, kind: name },
    plural,
    namespaced: true,
    verbs: ["get", "list", "watch"],
    printerColumns: [],
  };
}

const POD = kind("", "v1", "Pod", "pods");
const KUSTOMIZATION = kind("kustomize.toolkit.fluxcd.io", "v1", "Kustomization", "kustomizations");
const APPLICATION = kind("argoproj.io", "v1alpha1", "Application", "applications");

const SHA = "9c1fda7e401429531ed1478f67ba06b3edff6513b75da7ee47bde9f1c4d4251c";

function fluxPreview(overrides: Partial<InstallPreview> = {}): InstallPreview {
  const objects = [
    { kind: "Namespace", name: "flux-system", namespace: null, clusterScoped: true },
    {
      kind: "CustomResourceDefinition",
      name: "kustomizations.kustomize.toolkit.fluxcd.io",
      namespace: null,
      clusterScoped: true,
    },
    { kind: "ClusterRole", name: "crd-controller", namespace: null, clusterScoped: true },
    { kind: "Deployment", name: "source-controller", namespace: "flux-system", clusterScoped: false },
    { kind: "Deployment", name: "kustomize-controller", namespace: "flux-system", clusterScoped: false },
  ];
  return {
    token: "tok-1",
    tool: "flux",
    version: "v2.9.6",
    namespace: "flux-system",
    sourceUrl: "https://github.com/fluxcd/flux2/releases/download/v2.9.6/install.yaml",
    sha256: SHA,
    checksumVerified: true,
    summary: {
      tool: "flux",
      version: "v2.9.6",
      namespace: "flux-system",
      kinds: [
        { kind: "Namespace", count: 1 },
        { kind: "CustomResourceDefinition", count: 1 },
        { kind: "ClusterRole", count: 1 },
        { kind: "Deployment", count: 2 },
      ],
      objects,
      clusterScoped: 3,
    },
    access: { canCreateCrds: true, canCreateClusterRoleBindings: true },
    existing: { present: false, partial: false },
    overlap: { clusterObjects: [], leftOutControllers: [] },
    ...overrides,
  };
}

let backend: MockBackend;
let kinds: ResourceKind[];

function setup(handlers: Record<string, MockHandler> = {}) {
  kinds = [POD];
  backend = mockBackend({
    clusters_list: () => [alpha],
    kubeconfig_sources: () => [{ id: "src-home", path: "/home/me/.kube/config", kind: "default", error: null }],
    cluster_state: () => ({ state: "disconnected" }),
    cluster_connect: () => undefined,
    cluster_disconnect: () => undefined,
    cluster_kinds: () => kinds,
    cluster_kinds_refresh: () => undefined,
    watch_start: () => "watch",
    watch_stop: () => undefined,
    streams_reset: () => undefined,
    helm_status: () => ({ available: false, version: null, path: null }),
    settings_status: () => ({ writable: true, backupPath: null, error: null }),
    gitops_install_versions: (args) =>
      args.tool === "flux"
        ? { versions: ["v2.9.6", "v2.9.5"], latest: "v2.9.6", error: null }
        : { versions: ["v3.5.5"], latest: "v3.5.5", error: null },
    gitops_install_prepare: () => fluxPreview(),
    gitops_install_start: () => "install-1",
    ...handlers,
  });
}

const rail = () => screen.getByRole("navigation", { name: "Clusters" });
const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

async function connect() {
  render(<AppShell />);
  fireEvent.click(await within(rail()).findByRole("button", { name: "kind-alpha" }));
  await waitFor(() => expect(within(rail()).getByRole("button", { name: "kind-alpha" })).toHaveAttribute("data-state", "connected"));
}

async function openMenu() {
  fireEvent.contextMenu(within(rail()).getByRole("button", { name: "kind-alpha" }));
  return screen.findByRole("menu");
}

async function openFluxDialog() {
  await connect();
  const menu = await openMenu();
  fireEvent.click(await within(menu).findByRole("menuitem", { name: "Install Flux…" }));
  return screen.findByRole("dialog", { name: "Install Flux" });
}

async function toPreview(dialog: HTMLElement) {
  await within(dialog).findByRole("option", { name: "v2.9.6 (latest)" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Download and preview" }));
  await within(dialog).findByText(SHA);
}

function emit(event: InstallEvent) {
  act(() => backend.emit("gitops-install:install-1", event));
}

async function install(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
  await waitFor(() => expect(backend.listenerCount("gitops-install:install-1")).toBe(1));
  await waitFor(() => expect(calls("gitops_install_start")).toHaveLength(1));
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
  resetClusterKinds();
  closeInstall();
});
afterEach(() => {
  closeInstall();
  resetClustersStore();
  resetClusterKinds();
  backend.restore();
});

describe("where the install is offered", () => {
  it("the menu of a connected cluster offers the tools its discovery does not serve", async () => {
    setup();
    render(<AppShell />);
    await within(rail()).findByRole("button", { name: "kind-alpha" });
    const menu = await openMenu();
    // Not connected: nothing to install into.
    expect(within(menu).queryByRole("menuitem", { name: /Install/ })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Connect" }));
    await waitFor(() => expect(within(rail()).getByRole("button", { name: "kind-alpha" })).toHaveAttribute("data-state", "connected"));
    const connected = await openMenu();
    expect(await within(connected).findByRole("menuitem", { name: "Install Flux…" })).toBeInTheDocument();
    expect(within(connected).getByRole("menuitem", { name: "Install Argo CD…" })).toBeInTheDocument();
  });

  it("a tool already in discovery is not offered", async () => {
    setup();
    kinds = [POD, KUSTOMIZATION];
    await connect();
    const menu = await openMenu();
    expect(await within(menu).findByRole("menuitem", { name: "Install Argo CD…" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Install Flux…" })).not.toBeInTheDocument();
  });

  it("the GitOps section of the cluster settings shows what is installed and offers the rest", async () => {
    setup();
    kinds = [POD, APPLICATION];
    await connect();
    act(() => openClusterSettings("aaaa"));
    const settings = await screen.findByRole("dialog", { name: /Cluster settings/ });
    expect(await within(settings).findByText("GitOps")).toBeInTheDocument();
    expect(await within(settings).findByText("Installed")).toBeInTheDocument();
    fireEvent.click(within(settings).getByRole("button", { name: "Install Flux…" }));
    expect(await screen.findByRole("dialog", { name: "Install Flux" })).toBeInTheDocument();
    expect(within(settings).queryByRole("button", { name: "Install Argo CD…" })).not.toBeInTheDocument();
  });
});

describe("the install dialog", () => {
  it("goes from the version to the preview, installs with progress and waits until the controllers are ready", async () => {
    setup({
      gitops_install_prepare: () =>
        fluxPreview({
          existing: { present: false, partial: true },
          overlap: {
            clusterObjects: [{ kind: "ClusterRole", name: "crd-controller", namespace: null, clusterScoped: true }],
            leftOutControllers: ["image-reflector-controller"],
          },
        }),
    });
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    expect(calls("gitops_install_prepare")[0]?.args).toEqual({ clusterId: "aaaa", tool: "flux", version: "v2.9.6" });

    // The preview: source, verified checksum, cluster-wide warning, what exists and what loses its permissions.
    expect(within(dialog).getByText(fluxPreview().sourceUrl)).toBeInTheDocument();
    expect(within(dialog).getByText("matches the checksums file of the release")).toBeInTheDocument();
    expect(within(dialog).getByText(/It needs cluster-admin rights/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Flux is partly installed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/already exist and will be overwritten/)).toHaveTextContent("ClusterRole crd-controller");
    expect(within(dialog).getByText(/image-reflector-controller/)).toHaveTextContent("lose their permissions");
    expect(within(dialog).getByText("Objects (5)")).toBeInTheDocument();

    await install(dialog);
    expect(calls("gitops_install_start")[0]?.args).toMatchObject({ clusterId: "aaaa", token: "tok-1" });
    emit({ type: "applied", kind: "Namespace", name: "flux-system" });
    emit({ type: "applied", kind: "CustomResourceDefinition", name: "kustomizations.kustomize.toolkit.fluxcd.io" });
    expect(within(dialog).getByText("Applying objects: 2 of 5")).toBeInTheDocument();
    emit({ type: "applied", kind: "ClusterRole", name: "crd-controller" });
    emit({ type: "applied", kind: "Deployment", name: "source-controller" });
    emit({ type: "applied", kind: "Deployment", name: "kustomize-controller" });
    emit({
      type: "waiting",
      workloads: [
        { kind: "Deployment", name: "source-controller", ready: true, reason: null },
        { kind: "Deployment", name: "kustomize-controller", ready: false, reason: "waiting for its pods" },
      ],
    });
    expect(within(dialog).getByText(/Waiting for the controllers/)).toBeInTheDocument();
    expect(within(dialog).getByText("waiting for its pods")).toBeInTheDocument();

    emit({
      type: "done",
      workloads: [
        { kind: "Deployment", name: "source-controller", ready: true, reason: null },
        { kind: "Deployment", name: "kustomize-controller", ready: true, reason: null },
      ],
    });
    expect(await within(dialog).findByText("Flux v2.9.6 is installed and running. Its section is in the sidebar.")).toBeInTheDocument();
    // Discovery is read again, so the Flux section appears without reconnecting.
    await waitFor(() => expect(calls("cluster_kinds_refresh")).toHaveLength(1));
    expect(within(dialog).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    // The footer's Close (the header has one too); nothing runs any more, so nothing is asked.
    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog", { name: "Install Flux" })).not.toBeInTheDocument();
  });

  it("offers the bundled version with the reason when GitHub cannot be asked", async () => {
    setup({
      gitops_install_versions: () => ({ versions: ["v2.9.6"], latest: "v2.9.6", error: "The download failed: HTTP 403 Forbidden" }),
    });
    const dialog = await openFluxDialog();
    expect(await within(dialog).findByText(/only the tested version v2.9.6 is offered/)).toBeInTheDocument();
    expect(within(dialog).getByText("The download failed: HTTP 403 Forbidden")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("option")).toHaveLength(1);
  });

  it("shows a refused download and stays on the version step", async () => {
    setup({
      gitops_install_prepare: () => {
        throw { code: "invalid", message: "The SHA-256 of the downloaded install.yaml is not the one in flux_2.9.6_checksums.txt" };
      },
    });
    const dialog = await openFluxDialog();
    await within(dialog).findByRole("option", { name: "v2.9.6 (latest)" });
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "v2.9.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download and preview" }));
    expect(await within(dialog).findByText(/flux_2.9.6_checksums.txt/)).toBeInTheDocument();
    expect(calls("gitops_install_prepare")[0]?.args).toMatchObject({ version: "v2.9.5" });
    expect(within(dialog).getByRole("button", { name: "Download and preview" })).toBeInTheDocument();
  });

  it("warns before the install when the user may not create CRDs or ClusterRoleBindings", async () => {
    setup({
      gitops_install_prepare: () =>
        fluxPreview({ access: { canCreateCrds: false, canCreateClusterRoleBindings: false }, checksumVerified: false }),
    });
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    expect(within(dialog).getByText(/may not create CustomResourceDefinitions/)).toBeInTheDocument();
    expect(within(dialog).getByText(/may not create ClusterRoleBindings/)).toBeInTheDocument();
    expect(within(dialog).getByText("the project publishes no checksum for this file")).toBeInTheDocument();
    // The user decides: the button stays.
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeEnabled();
  });

  it("a failure shows what was applied, what was not and why", async () => {
    setup();
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    await install(dialog);
    emit({ type: "applied", kind: "Namespace", name: "flux-system" });
    emit({ type: "failed", kind: "CustomResourceDefinition", name: "kustomizations.kustomize.toolkit.fluxcd.io", error: "forbidden" });
    emit({ type: "error", message: "CustomResourceDefinition kustomizations.kustomize.toolkit.fluxcd.io: forbidden (1 of 5 objects were applied before it; the rest were not sent)" });

    expect(await within(dialog).findByText(/The install failed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 of 5 objects were applied before it/)).toBeInTheDocument();
    expect(within(dialog).getByText("Applied (1)")).toBeInTheDocument();
    expect(within(dialog).getByText("Not applied (4)")).toBeInTheDocument();
    expect(within(dialog).getByText("Deployment kustomize-controller")).toBeInTheDocument();
  });

  it("a wait that times out names the controllers that are not ready and why", async () => {
    setup();
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    await install(dialog);
    emit({
      type: "timedOut",
      workloads: [
        { kind: "Deployment", name: "source-controller", ready: true, reason: null },
        {
          kind: "Deployment",
          name: "kustomize-controller",
          ready: false,
          reason: "pod kustomize-controller-1: ImagePullBackOff: Back-off pulling image",
        },
      ],
    });
    expect(await within(dialog).findByText(/not every controller was ready within 5 minutes/)).toBeInTheDocument();
    expect(within(dialog).getByText(/ImagePullBackOff/)).toBeInTheDocument();
    expect(within(dialog).getByText("not ready")).toBeInTheDocument();
  });

  it("Stop asks the backend to stop after the current object and shows what was applied", async () => {
    setup();
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    await install(dialog);
    emit({ type: "applied", kind: "Namespace", name: "flux-system" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls("gitops_install_stop")).toHaveLength(1));
    const streamId = calls("gitops_install_start")[0]?.args.streamId;
    expect(calls("gitops_install_stop")[0]?.args).toEqual({ streamId });
    expect(within(dialog).getByText("Stopping after the current object…")).toBeInTheDocument();
    emit({ type: "stopped", applied: 1 });
    expect(await within(dialog).findByText(/The install was stopped. 1 objects were applied/)).toBeInTheDocument();
    expect(within(dialog).getByText("Not applied (4)")).toBeInTheDocument();
  });

  it("keeps a running install and its dialog when the window crosses the narrow layout width", async () => {
    let width = 1280;
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    // jsdom has no layout: answer max-width queries from `width`.
    window.matchMedia = ((query: string) => {
      const max = /max-width:\s*(\d+)px/.exec(query);
      return {
        get matches() {
          return max ? width <= Number(max[1]) : false;
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
        addListener: (fn: () => void) => listeners.add(fn),
        removeListener: (fn: () => void) => listeners.delete(fn),
        dispatchEvent: () => true,
      };
    }) as unknown as typeof window.matchMedia;
    const resizeTo = (next: number) => {
      width = next;
      act(() => {
        for (const fn of [...listeners]) fn();
      });
    };
    try {
      setup();
      const dialog = await openFluxDialog();
      await toPreview(dialog);
      await install(dialog);
      emit({ type: "applied", kind: "Namespace", name: "flux-system" });

      resizeTo(600);
      expect(screen.getByRole("button", { name: "Open menu" })).toBeInTheDocument();
      emit({ type: "applied", kind: "CustomResourceDefinition", name: "kustomizations.kustomize.toolkit.fluxcd.io" });
      resizeTo(1280);
      expect(screen.queryByRole("button", { name: "Open menu" })).not.toBeInTheDocument();

      const same = screen.getByRole("dialog", { name: "Install Flux" });
      expect(within(same).getByText("Applying objects: 2 of 5")).toBeInTheDocument();
      expect(within(same).getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(calls("gitops_install_stop")).toHaveLength(0);
      expect(calls("gitops_install_start")).toHaveLength(1);
      expect(backend.listenerCount("gitops-install:install-1")).toBe(1);
    } finally {
      window.matchMedia = original;
    }
  });

  it("an install aborted by a disconnect ends with what was applied", async () => {
    setup();
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    await install(dialog);
    emit({ type: "applied", kind: "Namespace", name: "flux-system" });
    emit({
      type: "error",
      message:
        "The install was stopped because the cluster was disconnected: 1 of 5 objects were applied; the object being sent at that moment may or may not have been applied, and nothing after it was sent",
    });
    expect(await within(dialog).findByText(/the cluster was disconnected/)).toBeInTheDocument();
    expect(within(dialog).getByText("Applied (1)")).toBeInTheDocument();
    expect(within(dialog).getByText("Not applied (4)")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("closing the dialog while installing asks whether to stop", async () => {
    setup();
    const dialog = await openFluxDialog();
    await toPreview(dialog);
    await install(dialog);
    emit({ type: "applied", kind: "Namespace", name: "flux-system" });

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const ask = await screen.findByRole("dialog", { name: "Stop the install?" });
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Install Flux" })).toBeInTheDocument();
    expect(calls("gitops_install_stop")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Stop the install?" })).getByRole("button", { name: "Stop the install" }));
    await waitFor(() => expect(calls("gitops_install_stop")).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Install Flux" })).not.toBeInTheDocument();
    expect(backend.listenerCount("gitops-install:install-1")).toBe(0);
  });

  it("after Argo CD it says how to sign in and opens the Argo CD UI", async () => {
    setup({
      gitops_install_prepare: () =>
        fluxPreview({
          token: "tok-argo",
          tool: "argoCd",
          version: "v3.5.5",
          namespace: "argocd",
          sourceUrl: "https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/install.yaml",
          checksumVerified: false,
        }),
      argocd_status: () => ({ namespace: "argocd", signedIn: false, saved: false }),
    });
    await connect();
    const menu = await openMenu();
    fireEvent.click(await within(menu).findByRole("menuitem", { name: "Install Argo CD…" }));
    const dialog = await screen.findByRole("dialog", { name: "Install Argo CD" });
    await within(dialog).findByRole("option", { name: "v3.5.5 (latest)" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Download and preview" }));
    await within(dialog).findByText(SHA);
    await install(dialog);
    emit({ type: "done", workloads: [{ kind: "StatefulSet", name: "argocd-application-controller", ready: true, reason: null }] });
    expect(await within(dialog).findByText(/argocd-initial-admin-secret/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Open Argo CD UI" })).toBeInTheDocument();
  });
});
