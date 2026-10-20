import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "i18next";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import { CompositesPage } from "./CompositesPage";
import claimJson from "./fixtures/claim.json";
import compositeJson from "./fixtures/composite.json";
import managedJson from "./fixtures/managed.json";
import providerJson from "./fixtures/provider.json";
import xrdJson from "./fixtures/xrd.json";
import "./index";
import {
  COMPOSITION,
  explainResource,
  firstFailing,
  FUNCTION,
  packageHealth,
  parseXrd,
  PKG_CONFIGURATION,
  PROVIDER,
  resourceHealth,
  resourceRefsOf,
  roleOf,
  XRD,
} from "./model";
import { CREATING_GRACE_MS, FAILURE_GRACE_MS, toProblems } from "./provider";
import { acquireCrossplane, getCrossplane, MAX_ROWS, resetCrossplaneStore, toRow } from "./store";

const xrd = xrdJson as KubeObject;
const claim = claimJson as KubeObject;
const composite = compositeJson as KubeObject;
const managed = managedJson as KubeObject;
const provider = providerJson as KubeObject;
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const CLAIM = kindOf(claim);
const COMPOSITE = kindOf(composite);

describe("the model", () => {
  it("reads the kinds an XRD defines and tells claims from composites", () => {
    const info = parseXrd(xrd)!;
    expect(info.composite).toEqual(COMPOSITE);
    expect(info.claim).toEqual(CLAIM);
    expect(roleOf(CLAIM, [info])).toBe("claim");
    expect(roleOf(COMPOSITE, [info])).toBe("composite");
    expect(roleOf(kindOf(managed), [info])).toBeUndefined();
  });

  it("Synced and Ready: creating is progress, a reconcile error is a failure named first", () => {
    expect(resourceHealth(claim)).toBe("progressing");
    expect(explainResource(claim)).toEqual({ key: "creating" });
    expect(resourceHealth(managed)).toBe("failed");
    expect(firstFailing(managed)?.reason).toBe("ReconcileError");
    expect(explainResource(managed)).toEqual({ key: "notSynced", params: { reason: "ReconcileError" } });
    expect(packageHealth(provider)).toBe("failed");
    expect(getResourceDef(PROVIDER).problem?.(provider)).toBe(true);
  });

  it("a paused resource (ReconcilePaused) is neutral: paused, never failed, never a problem", () => {
    // As crossplane-runtime marks it: Synced=False, reason ReconcilePaused, with the annotation crossplane.io/paused.
    const paused = copy(claim);
    paused.metadata!.annotations = { ...(paused.metadata!.annotations ?? {}), "crossplane.io/paused": "true" };
    (paused.status as { conditions: unknown[] }).conditions = [
      { type: "Synced", status: "False", reason: "ReconcilePaused", lastTransitionTime: "2026-10-10T10:00:00Z" },
      { type: "Ready", status: "True", reason: "Available" },
    ];
    expect(resourceHealth(paused)).toBe("paused");
    expect(firstFailing(paused)).toBeUndefined();
    expect(explainResource(paused)).toEqual({ key: "paused" });
    expect(toProblems([toRow(paused, CLAIM, "claim")], new Map(), Date.parse("2026-10-10T12:00:00Z"))).toEqual([]);
    // The condition alone (management policies pause it too).
    paused.metadata!.annotations = {};
    expect(resourceHealth(paused)).toBe("paused");
    // Another Synced=False reason is still a failure.
    (paused.status as { conditions: { reason: string }[] }).conditions[0]!.reason = "ReconcileError";
    expect(resourceHealth(paused)).toBe("failed");
  });

  it("reads Crossplane v2's fields under spec.crossplane", () => {
    const v2 = copy(composite);
    const spec = v2.spec as Record<string, unknown>;
    spec.crossplane = { resourceRefs: spec.resourceRefs };
    delete spec.resourceRefs;
    expect(resourceRefsOf(v2).map((r) => r.kind)).toEqual(["Instance", "SecurityGroup"]);
  });
});

describe("problems", () => {
  const now = Date.parse("2026-10-10T10:01:00Z");
  it("a claim out of sync counts after a short grace; one still being created only after half an hour", () => {
    const failing = copy(claim);
    (failing.status as { conditions: { type: string; status: string; reason: string }[] }).conditions[0] = {
      type: "Synced",
      status: "False",
      reason: "ReconcileError",
    };
    const [p] = toProblems([toRow(failing, CLAIM, "claim")], new Map(), now);
    expect(p).toMatchObject({ category: "crossplane", reason: "ReconcileError", object: { name: "my-db", namespace: "default" } });
    expect(p!.activeAt).toBe(now + FAILURE_GRACE_MS);
    const [creating] = toProblems([toRow(claim, CLAIM, "claim")], new Map(), now);
    expect(creating!.activeAt).toBe(Date.parse("2026-10-10T10:00:02Z") + CREATING_GRACE_MS);
  });

  it("a composite a claim stands for is told through the claim", () => {
    expect(toProblems([toRow(composite, COMPOSITE, "composite")], new Map(), now)).toEqual([]);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef, namespaced = false): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced, verbs: ["list", "watch"], printerColumns: [] });
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

let wb: WatchBackend;
let discovery: ResourceKind[];
let objects: KubeObject[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetCrossplaneStore();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [served(POD, true), served(XRD), served(COMPOSITION), served(PROVIDER), served(PKG_CONFIGURATION), served(FUNCTION), served(CLAIM, true), served(COMPOSITE)];
  objects = [composite, managed];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery);
  wb.backend.on("settings_get", () => defaultAppSettings());
  wb.backend.on("resource_get", (args) => {
    const ref = args.ref as ObjectRef;
    const found = objects.find((o) => o.kind === ref.kind.kind && o.metadata?.name === ref.name);
    if (!found) throw { code: "notFound", message: "not found" };
    return found;
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetCrossplaneStore();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the Crossplane section", () => {
  it("lists the page and the kinds the cluster serves", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Crossplane"));
    fireEvent.click(screen.getByRole("button", { name: /Crossplane/ }));
    const section = within(screen.getByRole("button", { name: /Crossplane/ }).closest("li")!);
    for (const label of ["Composite Resources", "Composite Resource Definitions", "Compositions", "Providers", "Functions"]) {
      expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("counts the claims that need attention on its header, through the problems provider", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Crossplane"));
    emitSnapshot(wb, await watchOf(wb, "CompositeResourceDefinition"), [xrd]);
    const failing = copy(claim);
    (failing.status as { conditions: { type: string; status: string; reason: string; lastTransitionTime: string }[] }).conditions[0] = {
      type: "Synced",
      status: "False",
      reason: "ReconcileError",
      lastTransitionTime: "2026-10-10T10:00:02Z",
    };
    emitSnapshot(wb, await watchOf(wb, "PostgreSQLInstance"), [failing]);
    emitSnapshot(wb, await watchOf(wb, "XPostgreSQLInstance"), [composite]);
    await waitFor(() => expect(screen.getByTitle("1 claim or composite resource needs attention")).toHaveTextContent("1"));
  });

  it("is not there without Crossplane", async () => {
    discovery = [served(POD, true)];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Crossplane");
  });
});

describe("the store", () => {
  it("caps the claim and composite watches and says when a list is cut", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Crossplane"));
    const release = acquireCrossplane("c1");
    emitSnapshot(wb, await watchOf(wb, "CompositeResourceDefinition"), [xrd]);
    const claims = await watchOf(wb, "PostgreSQLInstance");
    const start = wb.backend.calls.find((c) => c.cmd === "watch_start" && (c.args.spec as { kind: KindRef }).kind.kind === "PostgreSQLInstance")!;
    expect(start.args.options).toEqual({ progressive: false, maxObjects: MAX_ROWS });
    emitSnapshot(wb, claims, [claim]);
    emitSnapshot(wb, await watchOf(wb, "XPostgreSQLInstance"), [composite]);
    await waitFor(() => expect(getCrossplane("c1").loading).toBe(false));
    expect(getCrossplane("c1").rowsTruncated).toBe(false);
    act(() => wb.backend.emit(`watch:${claims}`, { type: "capped", total: MAX_ROWS + 1 }));
    await waitFor(() => expect(getCrossplane("c1").rowsTruncated).toBe(true));
    release();
  });
});

describe("the Composite resources page", () => {
  it("watches the kinds the XRDs define and lists claims and composites, problems first", async () => {
    render(<CompositesPage clusterId="c1" />);
    emitSnapshot(wb, await watchOf(wb, "CompositeResourceDefinition"), [xrd]);
    const failing = copy(claim);
    (failing.status as { conditions: { type: string; status: string; reason: string }[] }).conditions[0] = {
      type: "Synced",
      status: "False",
      reason: "ReconcileError",
    };
    emitSnapshot(wb, await watchOf(wb, "PostgreSQLInstance"), [failing]);
    emitSnapshot(wb, await watchOf(wb, "XPostgreSQLInstance"), [composite]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open PostgreSQLInstance my-db" })).toBeInTheDocument());
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]!).getByText("Failed")).toHaveClass("rt-status--danger");
    expect(within(rows[1]!).getByText("ReconcileError")).toBeInTheDocument();
    expect(within(rows[2]!).getByText("XPostgreSQLInstance (composite)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Only problems" }));
    expect(screen.queryByRole("button", { name: "Open XPostgreSQLInstance my-db-x7k2p" })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const section = (id: string) => within(document.querySelector<HTMLElement>(`[data-section='${id}']`)!);

describe("details", () => {
  it("of a claim: the chain to the composite and its resources, with what fails first", async () => {
    await openDetails(claim);
    emitSnapshot(wb, await watchOf(wb, "CompositeResourceDefinition"), [xrd]);
    const xp = section("crossplaneResource");
    await waitFor(() => expect(xp.getByText("Not ready yet: Crossplane is still creating it or its resources.")).toBeInTheDocument());
    expect(xp.getByRole("button", { name: "Open Secret db-conn" })).toBeInTheDocument();
    await waitFor(() => expect(xp.getByRole("button", { name: "Open XPostgreSQLInstance my-db-x7k2p" })).toBeInTheDocument());
    await waitFor(() => expect(xp.getByRole("button", { name: "Open Instance my-db-x7k2p-9fz2l" })).toBeInTheDocument());
    await waitFor(() => expect(xp.getByText(/Cannot find version 9.1 for postgres/)).toBeInTheDocument());
    // A named resource that is gone says so.
    expect(xp.getByText("Not found")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of a managed resource: its state, ProviderConfig and composite", async () => {
    await openDetails(managed);
    const xp = section("crossplaneResource");
    await waitFor(() => expect(xp.getByText(/Crossplane cannot reconcile it \(ReconcileError\)/)).toBeInTheDocument());
    expect(xp.getByText("Managed resource")).toBeInTheDocument();
    expect(xp.getByRole("button", { name: "Open XPostgreSQLInstance my-db-x7k2p" })).toBeInTheDocument();
    expect(xp.getByText("default/my-db")).toBeInTheDocument();
  });

  it("of a paused claim: says it is paused, with nothing failing", async () => {
    const paused = copy(claim);
    paused.metadata!.annotations = { "crossplane.io/paused": "true" };
    (paused.status as { conditions: unknown[] }).conditions = [{ type: "Synced", status: "False", reason: "ReconcilePaused" }];
    await openDetails(paused);
    emitSnapshot(wb, await watchOf(wb, "CompositeResourceDefinition"), [xrd]);
    const xp = section("crossplaneResource");
    await waitFor(() => expect(xp.getByText(/^Paused: Crossplane does not reconcile it/)).toBeInTheDocument());
    expect(xp.queryByText(/ReconcilePaused/)).toBeNull();
  });

  it("of an XRD: a version's flags as one list in the UI language", async () => {
    i18n.addResourceBundle("xx", "common", { list: { separator: "; " } }, true, true);
    i18n.addResourceBundle("xx", "crossplane", { versionWithFlags: "{{flags}} — {{name}}" }, true, true);
    await i18n.changeLanguage("xx");
    try {
      await openDetails(xrd);
      const xp = section("crossplane");
      await waitFor(() => expect(xp.getByText("served; referenceable — v1alpha1")).toBeInTheDocument());
    } finally {
      await i18n.changeLanguage("en");
      i18n.removeResourceBundle("xx", "common");
      i18n.removeResourceBundle("xx", "crossplane");
    }
  });

  it("of a Provider: why the package is not healthy", async () => {
    await openDetails(provider);
    const xp = section("crossplane");
    await waitFor(() => expect(xp.getByText("The package is installed but not healthy (UnhealthyPackageRevision).")).toBeInTheDocument());
    expect(xp.getByText(/incompatible dependencies/)).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
