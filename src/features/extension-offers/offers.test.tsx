import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type ExtensionInfo, type MockBackend, type ResourceKind } from "../../api";
import { getSettingsSnapshot } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import { useInstallRequest } from "../extensions/installRequest";
import { ExtensionOffers, resetNotNow } from "./ExtensionOffers";
import { offersFor } from "./offers";

const kind = (group: string, k: string, version = "v1"): ResourceKind => ({
  kindRef: { group, version, kind: k },
  plural: `${k.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const FLUX = kind("kustomize.toolkit.fluxcd.io", "Kustomization");
const APP = kind("argoproj.io", "Application", "v1alpha1");
const WORKFLOW = kind("argoproj.io", "Workflow", "v1alpha1");
/** A kind no extension of Sextant's own is offered for. */
const OTHER = kind("demo.sextant.dev", "Widget");

describe("offersFor", () => {
  const refs = (...kinds: ResourceKind[]) => kinds.map((k) => k.kindRef);
  it("offers an extension of Sextant's own only where its tool runs, unless installed, declined or put off", () => {
    expect(offersFor(refs(FLUX, APP), new Set(), [], new Set()).map((o) => o.id)).toEqual(["sextant.flux", "sextant.argo-cd"]);
    // Argo Workflows shares the group: its own extension, not Argo CD's (#397).
    expect(offersFor(refs(WORKFLOW), new Set(), [], new Set()).map((o) => o.id)).toEqual(["sextant.argo-workflows"]);
    expect(offersFor(refs(FLUX, APP), new Set(["sextant.flux"]), ["sextant.argo-cd"], new Set())).toEqual([]);
    expect(offersFor(refs(FLUX), new Set(), [], new Set(["sextant.flux"]))).toEqual([]);
  });

  it("offers the one service mesh extension once, where Istio's or Linkerd's kinds are served", () => {
    const vs = kind("networking.istio.io", "VirtualService");
    const pa = kind("security.istio.io", "PeerAuthentication");
    const server = kind("policy.linkerd.io", "Server", "v1beta3");
    const profile = kind("linkerd.io", "ServiceProfile", "v1alpha2");
    for (const served of [[vs], [pa], [server], [profile], [vs, server, profile]]) {
      expect(offersFor(refs(...served), new Set(), [], new Set()).map((o) => o.id)).toEqual(["sextant.mesh"]);
    }
    expect(offersFor(refs(kind("istio.io", "Other"), OTHER), new Set(), [], new Set())).toEqual([]);
  });

  it("offers Crossplane where its own kinds are served", () => {
    for (const served of [[kind("apiextensions.crossplane.io", "CompositeResourceDefinition")], [kind("pkg.crossplane.io", "Provider")]]) {
      expect(offersFor(refs(...served), new Set(), [], new Set()).map((o) => o.id)).toEqual(["sextant.crossplane"]);
    }
    expect(offersFor(refs(kind("database.example.org", "XPostgreSQLInstance"), OTHER), new Set(), [], new Set())).toEqual([]);
  });
});

describe("the offers above the sidebar", () => {
  let backend: MockBackend;
  let installed: ExtensionInfo[];

  beforeEach(() => {
    resetAppStore();
    resetClusterKinds();
    resetNotNow();
    installed = [];
    backend = mockBackend({ cluster_kinds: () => [FLUX, OTHER], extensions_list: () => installed }, {
      settings: { extensionCatalog: { enabled: true, declinedOffers: [] } },
    });
    useAppStore.getState().setActiveCluster("c1");
  });
  afterEach(() => {
    backend.restore();
    useInstallRequest.setState({ id: null });
  });

  it("Install asks the catalog's install of the extension", async () => {
    const { container } = render(<ExtensionOffers />);
    expect(await screen.findByText("This cluster runs Flux. Sextant shows it through its Flux extension from the catalog.")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(useInstallRequest.getState().id).toBe("sextant.flux");
  });

  it("Not now hides it for this run; Don't offer again keeps it hidden in the settings", async () => {
    const { unmount } = render(<ExtensionOffers />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    expect(getSettingsSnapshot()?.extensionCatalog.declinedOffers).toEqual([]);
    unmount();
    resetNotNow();
    render(<ExtensionOffers />);
    fireEvent.click(await screen.findByRole("button", { name: "Don't offer again" }));
    await waitFor(() => expect(getSettingsSnapshot()?.extensionCatalog.declinedOffers).toEqual(["sextant.flux"]));
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("an installed extension is not offered", async () => {
    installed = [{ id: "sextant.flux" } as ExtensionInfo];
    render(<ExtensionOffers />);
    await waitFor(() => expect(backend.calls.some((c) => c.cmd === "extensions_list")).toBe(true));
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });
});
