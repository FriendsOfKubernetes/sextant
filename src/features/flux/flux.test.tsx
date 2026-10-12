import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { ActionDialogHost } from "../../layout/main/ActionDialogHost";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds, type ColumnDef } from "../../resources";
import "../actions";
import { getAction, getActionsFor, runAction, type ActionId } from "../actions/registry";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import helmDeploymentJson from "./fixtures/helm-deployment.json";
import alertJson from "./fixtures/alert.json";
import bucketJson from "./fixtures/bucket.json";
import gitRepositoryJson from "./fixtures/gitrepository.json";
import helmChartJson from "./fixtures/helmchart.json";
import helmReleaseJson from "./fixtures/helmrelease.json";
import helmRepositoryJson from "./fixtures/helmrepository.json";
import imagePolicyJson from "./fixtures/imagepolicy.json";
import imageRepositoryJson from "./fixtures/imagerepository.json";
import imageUpdateAutomationJson from "./fixtures/imageupdateautomation.json";
import kustomizationJson from "./fixtures/kustomization.json";
import ociRepositoryJson from "./fixtures/ocirepository.json";
import providerJson from "./fixtures/provider.json";
import receiverJson from "./fixtures/receiver.json";
import "./index";

// Objects as `kubectl get -o json` returned them on the kind cluster of `scripts/test-cluster.sh up --gitops`
// (Flux v2.9.6): the podinfo fixtures of `sextant-flux` and a few more made for this test (a bucket without a
// server, image automation, notifications).
const gitRepository = gitRepositoryJson as KubeObject;
const ociRepository = ociRepositoryJson as KubeObject;
const helmRepository = helmRepositoryJson as KubeObject;
const helmChart = helmChartJson as KubeObject;
const bucket = bucketJson as KubeObject;
const kustomization = kustomizationJson as KubeObject;
const helmRelease = helmReleaseJson as KubeObject;
const imageRepository = imageRepositoryJson as KubeObject;
const imagePolicy = imagePolicyJson as KubeObject;
const imageUpdateAutomation = imageUpdateAutomationJson as KubeObject;
const provider = providerJson as KubeObject;
const alert = alertJson as KubeObject;
const receiver = receiverJson as KubeObject;
const helmDeployment = helmDeploymentJson as KubeObject;

const copy = <T,>(value: T): T => structuredClone(value);
const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");

function columnsOf(obj: KubeObject): ColumnDef[] {
  return getResourceDef(kindOf(obj)).columns;
}

function columnOf(obj: KubeObject, id: string): ColumnDef {
  const col = columnsOf(obj).find((c) => c.id === id);
  if (!col) throw new Error(`${obj.kind} has no column ${id}`);
  return col;
}

/** What the table shows in the cell (the rendered cell, or the value). */
function cell(obj: KubeObject, id: string): HTMLElement {
  const col = columnOf(obj, id);
  const content = col.render
    ? col.render(obj, { clusterId: "c1", kind: kindOf(obj), now: Date.parse("2026-10-12T18:00:00Z") })
    : String(col.value(obj) ?? "");
  const { container } = render(<div data-testid="cell">{content as ReactElement}</div>);
  return within(container).getByTestId("cell");
}

const SHA = "master@sha1:3e0ff8ae123b710bc91de1315cba0f996a8896c2";

describe("Flux tables", () => {
  // [object, Ready, Status (message of the Ready condition), Revision]
  const cases: [string, KubeObject, string | undefined, string | undefined, string | undefined][] = [
    ["GitRepository", gitRepository, "True", `stored artifact for revision '${SHA}'`, SHA],
    [
      "OCIRepository",
      ociRepository,
      "True",
      "stored artifact for digest 'latest@sha256:87815bbd58f5bfd5ad9deabb76dbd0615562cd0df288759c6e50ee54b2860b0c'",
      "latest@sha256:87815bbd58f5bfd5ad9deabb76dbd0615562cd0df288759c6e50ee54b2860b0c",
    ],
    [
      "HelmRepository",
      helmRepository,
      "True",
      "stored artifact: revision 'sha256:e7dc68a4dec90a35c2c6d8cdfedb7eaaee17fde45dced5898289df85069ec089'",
      "sha256:e7dc68a4dec90a35c2c6d8cdfedb7eaaee17fde45dced5898289df85069ec089",
    ],
    ["HelmChart", helmChart, "True", "pulled 'podinfo' chart with version '6.15.0'", "6.15.0"],
    ["Kustomization", kustomization, "True", `Applied revision: ${SHA}`, SHA],
    [
      "HelmRelease",
      helmRelease,
      "True",
      "Helm install succeeded for release sextant-flux/podinfo-helm.v1 with chart podinfo@6.15.0",
      "6.15.0",
    ],
    [
      "ImageRepository",
      imageRepository,
      "True",
      "successful scan: found 97 tags with checksum 3282451018",
      "3282451018",
    ],
    [
      "ImagePolicy",
      imagePolicy,
      "True",
      "Latest image tag for ghcr.io/stefanprodan/podinfo resolved to 6.15.0",
      "ghcr.io/stefanprodan/podinfo:6.15.0",
    ],
    ["ImageUpdateAutomation", imageUpdateAutomation, "True", "repository up-to-date", SHA],
    [
      "Receiver",
      receiver,
      "True",
      "Receiver initialized for path: /hook/55d86edf423c2a333a6335f7aca15e088ae7b5ea87880acbe0a6c397419708cc",
      undefined,
    ],
    // Static since notification.toolkit.fluxcd.io/v1beta3: no status at all.
    ["Provider", provider, undefined, undefined, undefined],
    ["Alert", alert, undefined, undefined, undefined],
  ];

  it.each(cases)("%s: Ready, Status, Revision, Suspended and Age", (_kind, obj, ready, message, revision) => {
    expect(columnsOf(obj).map((c) => c.id)).toEqual(
      expect.arrayContaining(["name", "namespace", "ready", "status", "revision", "suspended", "age"]),
    );
    expect(columnsOf(obj).at(-1)?.id).toBe("age");
    expect(columnOf(obj, "ready").value(obj) ?? undefined).toBe(ready);
    expect(columnOf(obj, "status").value(obj) ?? undefined).toBe(message);
    expect(columnOf(obj, "revision").value(obj) ?? undefined).toBe(revision);
    expect(columnOf(obj, "suspended").value(obj)).toBe(false);
    expect(cell(obj, "suspended")).toHaveTextContent("No");
    if (ready) expect(cell(obj, "ready")).toHaveTextContent(ready);
  });

  it("a bucket whose server cannot be reached is not ready, in red, with the controller's message", () => {
    expect(columnOf(bucket, "ready").value(bucket)).toBe("False");
    expect(cell(bucket, "ready").querySelector(".rt-status--danger")).toHaveTextContent("False");
    expect(String(columnOf(bucket, "status").value(bucket))).toMatch(/^failed to confirm existence of 'assets' bucket/);
    expect(columnOf(bucket, "revision").value(bucket) ?? undefined).toBeUndefined();
  });

  it("colors Ready: True green, Unknown (reconciling) yellow", () => {
    expect(cell(kustomization, "ready").querySelector(".rt-status--success")).toHaveTextContent("True");
    const progressing = copy(kustomization);
    const conditions = (progressing.status as { conditions: Record<string, unknown>[] }).conditions;
    conditions[0] = {
      ...conditions[0],
      status: "Unknown",
      reason: "Progressing",
      message: "Reconciliation in progress",
    };
    expect(cell(progressing, "ready").querySelector(".rt-status--warning")).toHaveTextContent("Unknown");
    expect(columnOf(progressing, "status").value(progressing)).toBe("Reconciliation in progress");
  });

  it("shows a suspended object as suspended", () => {
    const suspended = copy(helmRelease);
    (suspended.spec as Record<string, unknown>).suspend = true;
    expect(columnOf(suspended, "suspended").value(suspended)).toBe(true);
    expect(cell(suspended, "suspended")).toHaveTextContent("Yes");
  });

  it("registers every kind in the Flux section with the version the cluster serves", () => {
    const labels = [
      gitRepository,
      ociRepository,
      helmRepository,
      helmChart,
      bucket,
      kustomization,
      helmRelease,
      imageRepository,
      imagePolicy,
      imageUpdateAutomation,
      provider,
      alert,
      receiver,
    ].map((obj) => {
      const def = getResourceDef(kindOf(obj));
      expect(def.sidebar?.section).toBe("flux");
      expect(def.kind.version).toBe(kindOf(obj).version);
      return def.sidebar?.labelKey;
    });
    expect(new Set(labels).size).toBe(13);
  });
});

// ---------- Discovery ----------

const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const ALL_FLUX = [
  gitRepository,
  ociRepository,
  helmRepository,
  helmChart,
  bucket,
  kustomization,
  helmRelease,
  imageRepository,
  imagePolicy,
  imageUpdateAutomation,
  provider,
  alert,
  receiver,
].map(kindOf);
const BUILT_IN = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "Service" },
  { group: "apps", version: "v1", kind: "Deployment" },
];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  discovery = [...BUILT_IN, ...ALL_FLUX];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent?.replace(/[▸▾]/g, ""));

describe("the Flux section", () => {
  it("lists the Flux kinds the cluster serves, and only those", async () => {
    // Flux without the image automation controllers.
    discovery = discovery.filter((k) => k.group !== "image.toolkit.fluxcd.io");
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Flux"));
    fireEvent.click(screen.getByRole("button", { name: /Flux/ }));
    const flux = within(screen.getByRole("button", { name: /Flux/ }).closest("li")!);
    for (const label of [
      "Git Repositories",
      "OCI Repositories",
      "Helm Repositories",
      "Helm Charts",
      "Buckets",
      "Kustomizations",
      "Helm Releases",
      "Alerts",
      "Providers",
      "Receivers",
    ]) {
      expect(flux.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(flux.queryByRole("button", { name: "Image Policies" })).toBeNull();
    // Flux kinds are not listed again under Custom Resources.
    expect(screen.queryByRole("button", { name: "source.toolkit.fluxcd.io" })).toBeNull();
  });

  it("is not there without Flux", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Flux");
  });
});

// ---------- Details ----------

function refTo(obj: KubeObject): ObjectRef {
  return { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

/** Opens the details of `obj` and delivers it through the panel's own watch. */
async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

/** The watch of every `kind` in the cluster (not the panel's own watch of one object). */
const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null && s.labelSelector === null);

describe("details of a Kustomization", () => {
  it("show revision, interval and the source as a link", async () => {
    await openDetails(kustomization);
    const fields = within(section("fields"));
    expect(fields.getByText(SHA)).toBeInTheDocument();
    expect(fields.getByText("10m")).toBeInTheDocument();
    expect(fields.getByText("./kustomize")).toBeInTheDocument();
    fireEvent.click(fields.getByRole("button", { name: "Open GitRepository podinfo" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "source.toolkit.fluxcd.io", version: "v1", kind: "GitRepository" },
      namespace: "sextant-flux",
      name: "podinfo",
    });
  });

  it("list the objects it applied (status.inventory) as links", async () => {
    await openDetails(kustomization);
    const resources = within(section("flux"));
    expect(resources.getByRole("button", { name: "Open Service podinfo" })).toBeInTheDocument();
    expect(resources.getByRole("button", { name: "Open Deployment podinfo" })).toBeInTheDocument();
    fireEvent.click(resources.getByRole("button", { name: "Open HorizontalPodAutoscaler podinfo" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" },
      namespace: "sextant-flux",
      name: "podinfo",
    });
  });
});

describe("details of a source", () => {
  it("list the Kustomizations and HelmReleases that use it", async () => {
    await openDetails(gitRepository);
    emitSnapshot(wb, await listWatch("Kustomization"), [kustomization]);
    // A HelmRelease of another source is not listed.
    emitSnapshot(wb, await listWatch("HelmRelease"), [helmRelease]);
    const usedBy = within(section("flux"));
    fireEvent.click(usedBy.getByRole("button", { name: "Open Kustomization podinfo" }));
    expect(useAppStore.getState().details).toEqual(refTo(kustomization));
    expect(usedBy.queryByRole("button", { name: "Open HelmRelease podinfo-helm" })).toBeNull();
  });

  it("a HelmRepository lists the HelmReleases whose chart comes from it", async () => {
    await openDetails(helmRepository);
    emitSnapshot(wb, await listWatch("Kustomization"), [kustomization]);
    emitSnapshot(wb, await listWatch("HelmRelease"), [helmRelease]);
    const usedBy = within(section("flux"));
    expect(usedBy.getByRole("button", { name: "Open HelmRelease podinfo-helm" })).toBeInTheDocument();
    expect(usedBy.queryByRole("button", { name: "Open Kustomization podinfo" })).toBeNull();
  });
});

describe("related objects while their lists load", () => {
  it("a source says it is loading until its users are known, then that nothing uses it", async () => {
    await openDetails(bucket);
    const related = within(section("flux"));
    expect(related.getByRole("status")).toHaveTextContent("Loading…");

    emitSnapshot(wb, await listWatch("Kustomization"), []);
    emitSnapshot(wb, await listWatch("HelmRelease"), []);

    expect(related.queryByRole("status")).toBeNull();
    expect(related.getByText("Used by")).toBeInTheDocument();
    expect(related.getByText("No Kustomization or HelmRelease uses this source.")).toBeInTheDocument();
  });

  it("a HelmRelease says it is loading until every labelled kind is listed", async () => {
    await openDetails(helmRelease);
    const related = within(section("flux"));
    expect(related.getByRole("status")).toHaveTextContent("Loading…");

    const selector = "helm.toolkit.fluxcd.io/name=podinfo-helm,helm.toolkit.fluxcd.io/namespace=sextant-flux";
    const kinds = ["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Service", "ConfigMap", "Secret"];
    for (const kind of [...kinds, "ServiceAccount", "PersistentVolumeClaim"]) {
      emitSnapshot(wb, await watchOf(wb, kind, (s) => s.labelSelector === selector), []);
    }
    expect(related.getByRole("status")).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "Ingress", (s) => s.labelSelector === selector), []);

    expect(related.queryByRole("status")).toBeNull();
    expect(related.getByRole("button", { name: "Open Deployment podinfo-helm" })).toBeInTheDocument();
  });
});

describe("details of a HelmRelease", () => {
  it("show the chart, its source and the HelmChart as links", async () => {
    await openDetails(helmRelease);
    const fields = within(section("fields"));
    expect(fields.getByText("podinfo 6.x")).toBeInTheDocument();
    expect(fields.getByRole("button", { name: "Open HelmRepository podinfo" })).toBeInTheDocument();
    expect(fields.getByRole("button", { name: "Open HelmChart sextant-flux-podinfo-helm" })).toBeInTheDocument();
  });

  it("list the objects labelled with its name and namespace", async () => {
    const release = copy(helmRelease);
    // Before Flux 2.8 a HelmRelease had no inventory: the labels are all there is.
    delete (release.status as Record<string, unknown>).inventory;
    await openDetails(release);
    const selector = "helm.toolkit.fluxcd.io/name=podinfo-helm,helm.toolkit.fluxcd.io/namespace=sextant-flux";
    const id = await watchOf(wb, "Deployment", (s) => s.labelSelector === selector);
    expect(wb.specs.get(id)?.namespaces).toBeNull();
    emitSnapshot(wb, id, [helmDeployment]);
    const resources = within(section("flux"));
    fireEvent.click(resources.getByRole("button", { name: "Open Deployment podinfo-helm" }));
    expect(useAppStore.getState().details).toEqual({
      kind: { group: "apps", version: "v1", kind: "Deployment" },
      namespace: "sextant-flux",
      name: "podinfo-helm",
    });
  });
});

// ---------- Actions ----------

const FLUX_ACTIONS: ActionId[] = ["reconcile", "reconcileWithSource", "fluxSuspend", "fluxResume"];
const offered = (obj: KubeObject) => getActionsFor([obj], kindOf(obj), FLUX_ACTIONS).map((a) => a.id);
const patches = () => wb.backend.calls.filter((c) => c.cmd === "resource_patch").map((c) => c.args);

async function run(id: ActionId, obj: KubeObject) {
  const action = getAction(id);
  if (!action) throw new Error(`action ${id} is not registered`);
  await act(async () => {
    await runAction(action, "c1", kindOf(obj), [obj]);
  });
}

const requestedAt = (patch: unknown) =>
  (patch as { metadata: { annotations: Record<string, string> } }).metadata.annotations[
    "reconcile.fluxcd.io/requestedAt"
  ];

describe("Flux actions", () => {
  beforeEach(() => {
    wb.backend.on("resource_patch", (args) => ({ metadata: { name: (args.ref as ObjectRef).name } }));
    render(<ActionDialogHost />);
    while (screen.queryAllByRole("dialog").length > 0) fireEvent.keyDown(window, { key: "Escape" });
  });

  it("are offered as they apply: with source only for Kustomizations and HelmReleases, Suspend or Resume", () => {
    expect(offered(kustomization)).toEqual(["reconcile", "reconcileWithSource", "fluxSuspend"]);
    expect(offered(helmRelease)).toEqual(["reconcile", "reconcileWithSource", "fluxSuspend"]);
    expect(offered(gitRepository)).toEqual(["reconcile", "fluxSuspend"]);
    const suspended = copy(gitRepository);
    (suspended.spec as Record<string, unknown>).suspend = true;
    expect(offered(suspended)).toEqual(["reconcile", "fluxResume"]);
    expect(getResourceDef(kindOf(imagePolicy)).actions).toEqual(expect.arrayContaining(FLUX_ACTIONS));
  });

  it("Reconcile now sets reconcile.fluxcd.io/requestedAt to the current time by a merge patch", async () => {
    const before = Date.now();
    await run("reconcile", kustomization);
    const [call] = patches();
    expect(call).toMatchObject({ clusterId: "c1", ref: refTo(kustomization), patchType: "merge" });
    const at = requestedAt(call?.patch);
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(at!)).toBeGreaterThanOrEqual(before - 1);
    expect(Date.parse(at!)).toBeLessThanOrEqual(Date.now());
  });

  it("Reconcile with source asks the source first, then the Kustomization", async () => {
    await run("reconcileWithSource", kustomization);
    expect(patches().map((p) => p.ref)).toEqual([
      {
        kind: { group: "source.toolkit.fluxcd.io", version: "v1", kind: "GitRepository" },
        namespace: "sextant-flux",
        name: "podinfo",
      },
      refTo(kustomization),
    ]);
    expect(patches().every((p) => p.patchType === "merge" && requestedAt(p.patch))).toBe(true);
  });

  it("Reconcile with source of a HelmRelease asks its repository, then its HelmChart, then the release", async () => {
    await run("reconcileWithSource", helmRelease);
    expect(patches().map((p) => (p.ref as ObjectRef).kind.kind + " " + (p.ref as ObjectRef).name)).toEqual([
      "HelmRepository podinfo",
      "HelmChart sextant-flux-podinfo-helm",
      "HelmRelease podinfo-helm",
    ]);
  });

  it("Suspend changes nothing until confirmed, then sets spec.suspend", async () => {
    await run("fluxSuspend", helmRelease);
    const dialog = screen.getByRole("dialog", { name: "Suspend HelmRelease podinfo-helm?" });
    expect(patches()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]).toMatchObject({
      ref: refTo(helmRelease),
      patch: { spec: { suspend: true } },
      patchType: "merge",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Resume clears spec.suspend at once", async () => {
    const suspended = copy(helmRelease);
    (suspended.spec as Record<string, unknown>).suspend = true;
    await run("fluxResume", suspended);
    expect(patches()).toEqual([
      { clusterId: "c1", ref: refTo(helmRelease), patch: { spec: { suspend: false } }, patchType: "merge" },
    ]);
  });
});
