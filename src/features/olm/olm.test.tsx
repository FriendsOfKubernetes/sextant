import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { categoryOf, detect, OPT_IN_CATEGORIES, PROBLEM_CATEGORIES, resolve } from "../problems/model";
import { CATEGORY_SOURCES, MAX_SOURCE_OBJECTS } from "../problems/sources";
import { resetProblemSources } from "../problems/store";
import { resetSharedWatches } from "../resource-map/watches";
import objectsJson from "./fixtures/objects.json";
import "./index";
import {
  CATALOG_GRACE_MS,
  CATALOG_SOURCE,
  catalogInfo,
  CLUSTER_CATALOG,
  CLUSTER_EXTENSION,
  conditionText,
  copiedFrom,
  crdsOf,
  CSV,
  CSV_FAILED_GRACE_MS,
  deploymentSelector,
  INSTALL_PLAN,
  installModesOf,
  installPlanInfo,
  isCopy,
  isProblem,
  MAX_STEPS,
  NOT_COPIED_SELECTOR,
  olmProblems,
  OPERATOR,
  OPERATOR_GROUP,
  operatorGroupInfo,
  PLAN_STUCK_MS,
  RESOLUTION_GRACE_MS,
  requirementsOf,
  stepsOf,
  strategyDeployments,
  SUBSCRIPTION,
  subscriptionInfo,
  subscriptionState,
  unmetRequirements,
  upgradePending,
} from "./model";

const objects = objectsJson as KubeObject[];
const find = (kind: string, name: string, namespace?: string): KubeObject =>
  copy(objects.find((o) => o.kind === kind && o.metadata?.name === name && (namespace === undefined || o.metadata?.namespace === namespace))!);
const sub = (name: string) => find("Subscription", name);
const csv = (name: string, namespace = "operators") => find("ClusterServiceVersion", name, namespace);
const plan = (name: string) => find("InstallPlan", name);
const catalog = (name: string) => find("CatalogSource", name);
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const at = (iso: string) => Date.parse(iso);

describe("the model", () => {
  it("reads a Subscription's package, channel, approval and CSVs, and its state", () => {
    expect(subscriptionInfo(sub("prometheus"))).toMatchObject({
      packageName: "prometheus",
      channel: "beta",
      source: "operatorhubio-catalog",
      sourceNamespace: "olm",
      approval: "Automatic",
      installedCSV: "prometheusoperator.0.70.0",
      currentCSV: "prometheusoperator.0.70.0",
      installPlan: { name: "install-p7x2k", namespace: "operators" },
    });
    const table: [string, ReturnType<typeof subscriptionState>][] = [
      ["prometheus", "atLatest"],
      ["etcd", "waitingApproval"],
      ["strimzi-kafka-operator", "resolutionFailed"],
      ["broken-operator", "installPlanFailed"],
    ];
    for (const [name, state] of table) expect([name, subscriptionState(sub(name))]).toEqual([name, state]);
    expect(upgradePending(sub("etcd"))).toBe(true);
    expect(upgradePending(sub("prometheus"))).toBe(false);
    // Without an approval wait the differing CSVs are an upgrade pending; `installPlanApproval` unset is Automatic.
    const moving = sub("etcd");
    st(moving).conditions = [];
    delete (moving.spec as Record<string, unknown>).installPlanApproval;
    expect(subscriptionState(moving)).toBe("upgradePending");
    expect(subscriptionInfo(moving).approval).toBe("Automatic");
    // An older OLM names the plan only in `status.installplan`.
    const old = sub("prometheus");
    delete st(old).installPlanRef;
    expect(subscriptionInfo(old).installPlan).toEqual({ name: "install-p7x2k", namespace: "operators" });
    const fresh = sub("prometheus");
    delete (fresh as { status?: unknown }).status;
    expect(subscriptionState(fresh)).toBe("pending");
  });

  it("tells a copy of a CSV from its original, as OLM's IsCopied does", () => {
    expect(isCopy(csv("prometheusoperator.0.70.0"))).toBe(false);
    const copied = csv("prometheusoperator.0.70.0", "default");
    expect(isCopy(copied)).toBe(true);
    expect(copiedFrom(copied)).toBe("operators");
    // Only the reason, or only an annotation of another namespace, makes a copy too.
    const byReason = csv("etcdoperator.v0.9.2");
    st(byReason).reason = "Copied";
    expect(isCopy(byReason)).toBe(true);
    const byAnnotation = csv("etcdoperator.v0.9.2");
    byAnnotation.metadata!.namespace = "team-b";
    expect(isCopy(byAnnotation)).toBe(true);
    expect(copiedFrom(byAnnotation)).toBe("operators");
    expect(NOT_COPIED_SELECTOR).toBe("!olm.copiedFrom");
  });

  it("reads a CSV's requirements, CRDs, Deployments and install modes", () => {
    const prom = csv("prometheusoperator.0.70.0");
    expect(requirementsOf(prom).map((r) => `${r.kind}/${r.name}=${r.status}`)).toEqual([
      "CustomResourceDefinition/prometheuses.monitoring.coreos.com=Present",
      "CustomResourceDefinition/servicemonitors.monitoring.coreos.com=Present",
      "ServiceAccount/prometheus-operator=Present",
    ]);
    expect(unmetRequirements(csv("broken-operator.v1.0.0")).map((r) => r.name)).toEqual(["widgets.example.com"]);
    expect(crdsOf(prom, "owned").map((c) => c.kind)).toEqual(["Prometheus", "ServiceMonitor"]);
    expect(crdsOf(csv("broken-operator.v1.0.0"), "required").map((c) => c.name)).toEqual(["widgets.example.com"]);
    expect(strategyDeployments(csv("broken-operator.v1.0.0"))).toEqual(["broken-operator", "broken-webhook"]);
    expect(installModesOf(prom).filter((m) => !m.supported).map((m) => m.type)).toEqual(["MultiNamespace"]);
    expect(deploymentSelector(prom)).toBe("olm.owner=prometheusoperator.0.70.0,olm.owner.kind=ClusterServiceVersion");
    const long = csv("etcdoperator.v0.9.2");
    long.metadata!.name = "x".repeat(64);
    expect(deploymentSelector(long)).toBeUndefined();
    const other = csv("etcdoperator.v0.9.2");
    (other.spec as { install: { strategy: string } }).install.strategy = "unknown";
    expect(strategyDeployments(other)).toEqual([]);
  });

  it("reads an InstallPlan's approval, failure and steps, never a step's manifest", () => {
    expect(installPlanInfo(plan("install-q9w4m"))).toMatchObject({ phase: "RequiresApproval", approval: "Manual", approved: false, csvNames: ["etcdoperator.v0.9.4-clusterwide"] });
    expect(installPlanInfo(plan("install-z3v8b")).failure).toMatchObject({ reason: "InstallComponentFailed" });
    const { steps, total } = stepsOf(plan("install-q9w4m"));
    expect(total).toBe(3);
    expect(steps[2]).toEqual({ resolving: "etcdoperator.v0.9.4-clusterwide", group: "", version: "v1", kind: "Secret", name: "etcd-operator-webhook-cert", status: "Unknown", optional: false });
    expect(JSON.stringify(steps)).not.toContain("manifest");
    const big = plan("install-q9w4m");
    st(big).plan = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({ resolving: "x", resource: { kind: "ConfigMap", name: `c${i}` }, status: "Created" }));
    expect(stepsOf(big)).toMatchObject({ total: MAX_STEPS + 5 });
    expect(stepsOf(big).steps).toHaveLength(MAX_STEPS);
  });

  it("reads a CatalogSource, an OperatorGroup and OLM v1's conditions", () => {
    expect(catalogInfo(catalog("operatorhubio-catalog"))).toMatchObject({
      sourceType: "grpc",
      pollInterval: "60m",
      state: "READY",
      registryService: { name: "operatorhubio-catalog", namespace: "olm", port: "50051", protocol: "grpc" },
    });
    expect(operatorGroupInfo(find("OperatorGroup", "global-operators"))).toMatchObject({ allNamespaces: true, namespaces: [], upgradeStrategy: "Default" });
    expect(operatorGroupInfo(find("OperatorGroup", "team-a"))).toMatchObject({ allNamespaces: false, namespaces: ["team-a"], targetNamespaces: ["team-a"] });
    expect(conditionText(find("ClusterExtension", "argocd"), "Progressing")).toMatchObject({ text: "True (Succeeded)", tone: "success" });
    expect(conditionText(find("ClusterExtension", "cert-manager"), "Progressing")).toMatchObject({ text: "True (Retrying)", tone: "warning" });
    expect(conditionText(find("ClusterExtension", "cert-manager"), "Installed")).toMatchObject({ tone: "danger" });
    expect(conditionText(find("ClusterCatalog", "operatorhubio"), "Serving")).toMatchObject({ text: "True (Available)", tone: "success" });
  });
});

describe("problems", () => {
  it("is the category olm, on by default, of CSVs, Subscriptions and CatalogSources", () => {
    expect(PROBLEM_CATEGORIES).toContain("olm");
    expect(OPT_IN_CATEGORIES).not.toContain("olm");
    for (const kind of [CSV, SUBSCRIPTION, CATALOG_SOURCE]) expect(categoryOf(kind)).toBe("olm");
    for (const kind of [INSTALL_PLAN, OPERATOR_GROUP, OPERATOR, CLUSTER_EXTENSION, CLUSTER_CATALOG]) expect(categoryOf(kind)).toBeUndefined();
    // Knative's Subscription is another kind.
    expect(categoryOf({ group: "messaging.knative.dev", kind: "Subscription" })).not.toBe("olm");
    const defs = CATEGORY_SOURCES.olm;
    expect(defs.map((d) => `${d.kind.kind}:${d.external ? "external" : (d.maxObjects ?? "all")}`)).toEqual([
      `Subscription:${MAX_SOURCE_OBJECTS}`,
      "CatalogSource:all",
      "ClusterServiceVersion:external",
    ]);
    expect(defs.every((d) => d.discovered)).toBe(true);
  });

  it("a failed CSV counts after a grace; its copies never", () => {
    const failed = csv("broken-operator.v1.0.0");
    const problems = resolve(CSV, failed, at("2026-10-20T11:01:00Z"));
    expect(problems.map((p) => [p.reason, p.message])).toEqual([["InstallCheckFailed", "install timeout"]]);
    expect(problems[0]?.activeAt).toBe(at("2026-10-20T11:00:00Z") + CSV_FAILED_GRACE_MS);
    expect(detect(CSV, csv("broken-operator.v1.0.0", "default"))).toEqual([]);
    expect(detect(CSV, csv("prometheusoperator.0.70.0"))).toEqual([]);
    expect(isProblem(failed, CSV, at("2026-10-20T11:01:00Z"))).toBe(false);
    expect(isProblem(failed, CSV, at("2026-10-20T11:06:00Z"))).toBe(true);
    const deleting = csv("broken-operator.v1.0.0");
    deleting.metadata!.deletionTimestamp = "2026-10-20T11:02:00Z";
    expect(detect(CSV, deleting)).toEqual([]);
  });

  it("a Subscription: resolution failed after a grace; its current InstallPlan failed at once, about the plan", () => {
    const [resolution] = resolve(SUBSCRIPTION, sub("strimzi-kafka-operator"), at("2026-10-21T08:01:00Z"));
    expect(resolution).toMatchObject({ reason: "ConstraintsNotSatisfiable", category: "olm" });
    expect(resolution?.activeAt).toBe(at("2026-10-21T08:00:00Z") + RESOLUTION_GRACE_MS);
    const [failed] = resolve(SUBSCRIPTION, sub("broken-operator"), at("2026-10-21T08:11:00Z"));
    expect(failed).toMatchObject({
      reason: "InstallComponentFailed",
      message: "error creating clusterrole broken-operator: forbidden",
      object: { kind: INSTALL_PLAN, namespace: "operators", name: "install-z3v8b" },
      notify: true,
    });
    expect(failed?.activeAt).toBe(at("2026-10-21T08:10:00Z"));
  });

  it("waiting for an approval is no problem; planning or installing for half an hour is", () => {
    expect(detect(SUBSCRIPTION, sub("etcd"))).toEqual([]);
    const installing = sub("etcd");
    st(installing).conditions = [{ type: "InstallPlanPending", status: "True", reason: "Installing", lastTransitionTime: "2026-10-21T09:00:00Z" }];
    const [stuck] = resolve(SUBSCRIPTION, installing, at("2026-10-21T09:01:00Z"));
    expect(stuck).toMatchObject({ reason: "InstallPlanStuck", messageKey: "messages.olmPlanStuck", messageParams: { phase: "Installing" } });
    expect(stuck?.object).toMatchObject({ kind: INSTALL_PLAN, name: "install-q9w4m" });
    expect(stuck?.activeAt).toBe(at("2026-10-21T09:00:00Z") + PLAN_STUCK_MS);
    // The InstallPlan table's "Only problems" is its failed plans; the waiting one is not.
    expect(isProblem(plan("install-z3v8b"), INSTALL_PLAN)).toBe(true);
    expect(isProblem(plan("install-q9w4m"), INSTALL_PLAN)).toBe(false);
  });

  it("a catalog not READY (nor IDLE) for ten minutes; a new state starts the grace again", () => {
    expect(detect(CATALOG_SOURCE, catalog("operatorhubio-catalog"))).toEqual([]);
    const idle = catalog("operatorhubio-catalog");
    (st(idle).connectionState as Record<string, unknown>).lastObservedState = "IDLE";
    expect(detect(CATALOG_SOURCE, idle)).toEqual([]);
    const broken = catalog("broken-catalog");
    const [first] = resolve(CATALOG_SOURCE, broken, 1000);
    expect(first).toMatchObject({ reason: "CatalogSourceNotReady", messageParams: { state: "TRANSIENT_FAILURE" }, activeAt: 1000 + CATALOG_GRACE_MS });
    expect(resolve(CATALOG_SOURCE, broken, 5000, [first!])[0]?.activeAt).toBe(1000 + CATALOG_GRACE_MS);
    (st(broken).connectionState as Record<string, unknown>).lastObservedState = "CONNECTING";
    expect(resolve(CATALOG_SOURCE, broken, 5000, [first!])[0]?.activeAt).toBe(5000 + CATALOG_GRACE_MS);
    // A catalog without a connection state (a ConfigMap catalog) is not judged.
    const plain = catalog("broken-catalog");
    delete st(plain).connectionState;
    expect(olmProblems(CATALOG_SOURCE, plain)).toEqual([]);
  });
});

const OLM_KINDS_SERVED: KindRef[] = [SUBSCRIPTION, CSV, INSTALL_PLAN, CATALOG_SOURCE, OPERATOR_GROUP, OPERATOR, CLUSTER_EXTENSION, CLUSTER_CATALOG];
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const DEPLOYMENT: KindRef = { group: "apps", version: "v1", kind: "Deployment" };
const CLUSTER_SCOPED = new Set(["Operator", "ClusterExtension", "ClusterCatalog"]);
const served = (kind: KindRef): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced: !CLUSTER_SCOPED.has(kind.kind),
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [POD, DEPLOYMENT, ...OLM_KINDS_SERVED];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSharedWatches();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

const everywhere = (spec: { namespaces: string[] | null; fieldSelector: string | null; labelSelector: string | null }) =>
  spec.namespaces === null && spec.fieldSelector === null && spec.labelSelector === null;

describe("the Operators (OLM) section", () => {
  it("is there for a cluster that serves the kinds and counts failed operators, never a copy", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Operators (OLM)"));
    // The CSVs are listed without their copies, by the API server.
    const csvs = await watchOf(wb, "ClusterServiceVersion", (s) => s.labelSelector === "!olm.copiedFrom" && s.namespaces === null);
    const all = objects.filter((o) => o.kind === "ClusterServiceVersion").map(copy);
    // Even a copy the selector let through (an older OLM marked it by reason only) is not counted.
    const leaked = csv("broken-operator.v1.0.0", "default");
    delete leaked.metadata!.labels;
    emitSnapshot(wb, csvs, [...all.filter((o) => !isCopy(o)), leaked]);
    emitSnapshot(wb, await watchOf(wb, "Subscription", everywhere), objects.filter((o) => o.kind === "Subscription").map(copy));
    emitSnapshot(wb, await watchOf(wb, "CatalogSource", everywhere), objects.filter((o) => o.kind === "CatalogSource").map(copy));
    // The broken CSV and two Subscriptions (resolution failed, plan failed): the fixtures are old. The broken catalog
    // tells no time of its state: it counts ten minutes after it was first seen.
    await waitFor(() => expect(screen.getByTitle("3 OLM objects need attention")).toHaveTextContent("3"));
    // InstallPlans are not watched for problems.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "InstallPlan")).toBe(false);
  });

  it("is not there without the CRDs", async () => {
    discovery = [POD];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Workloads"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("Operators (OLM)");
  });

  it("registers every kind read-only, cluster-scoped where OLM's are", () => {
    for (const kind of OLM_KINDS_SERVED) {
      const def = getResourceDef(kind);
      expect(def.actions).toEqual(["edit", "delete"]);
      expect(def.namespaced).toBe(!CLUSTER_SCOPED.has(kind.kind));
    }
    const subscriptions = getResourceDef(SUBSCRIPTION);
    expect(subscriptions.columns.find((c) => c.id === "state")!.value(sub("etcd"))).toBe("waitingApproval");
    expect(getResourceDef(CSV).columns.find((c) => c.id === "copiedFrom")!.value(csv("prometheusoperator.0.70.0", "default"))).toBe("operators");
  });
});

function refTo(obj: KubeObject, kind: KindRef): ObjectRef {
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject, kind: KindRef): Promise<HTMLElement> {
  const ref = refTo(obj, kind);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  emitSnapshot(wb, await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}` && (ref.namespace === null || s.namespaces?.[0] === ref.namespace)), [obj]);
  await waitFor(() => expect(document.querySelector("[data-section='olm']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='olm']")!);
const named = (kind: string, ns: string, name: string) => (s: { namespaces: string[] | null; fieldSelector: string | null }) =>
  s.namespaces?.[0] === ns && s.fieldSelector === `metadata.name=${name}` && kind.length > 0;

describe("details", () => {
  it("of a Subscription waiting for approval: the plan, the CSVs and the pending upgrade", async () => {
    const container = await openDetails(sub("etcd"), SUBSCRIPTION);
    const v = view();
    expect(v.getByText(/The InstallPlan install-q9w4m waits for a manual approval/)).toBeInTheDocument();
    expect(v.getByText("An upgrade from etcdoperator.v0.9.2 to etcdoperator.v0.9.4-clusterwide is pending.")).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "InstallPlan", named("InstallPlan", "operators", "install-q9w4m")), [plan("install-q9w4m")]);
    emitSnapshot(wb, await watchOf(wb, "ClusterServiceVersion", named("CSV", "operators", "etcdoperator.v0.9.2")), [csv("etcdoperator.v0.9.2")]);
    await waitFor(() => expect(v.getByText("RequiresApproval")).toBeInTheDocument());
    expect(v.getByRole("button", { name: "Open InstallPlan install-q9w4m" })).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open ClusterServiceVersion etcdoperator.v0.9.2" })).toBeInTheDocument();
    // In the fields and in the catalog health.
    expect(v.getAllByRole("button", { name: "Open CatalogSource operatorhubio-catalog" })).toHaveLength(2);
    expect(v.getByText("Succeeded")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a failed CSV: why, the unmet requirement, its Deployments by OLM's labels", async () => {
    const container = await openDetails(csv("broken-operator.v1.0.0"), CSV);
    const v = view();
    expect(v.getByText("InstallCheckFailed: install timeout")).toBeInTheDocument();
    expect(v.getByText("1 requirement is not met.")).toBeInTheDocument();
    const deps = await watchOf(wb, "Deployment", (s) => s.labelSelector === "olm.owner=broken-operator.v1.0.0,olm.owner.kind=ClusterServiceVersion" && s.namespaces?.[0] === "operators");
    emitSnapshot(wb, deps, [find("Deployment", "broken-operator")]);
    await waitFor(() => expect(v.getByText("Not available")).toBeInTheDocument());
    expect(v.getByText("Not found")).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open CustomResourceDefinition widgets.example.com" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a CSV copy: says it is one and links the original, with no Deployments of its own", async () => {
    const container = await openDetails(csv("prometheusoperator.0.70.0", "default"), CSV);
    const v = view();
    expect(v.getByText(/the operator runs in operators/)).toBeInTheDocument();
    expect(v.getByRole("button", { name: "Open ClusterServiceVersion prometheusoperator.0.70.0" })).toHaveTextContent("operators/prometheusoperator.0.70.0");
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Deployment")).toBe(false);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of an InstallPlan: approval, steps without manifests; nothing to approve it with", async () => {
    const container = await openDetails(plan("install-q9w4m"), INSTALL_PLAN);
    const v = view();
    expect(v.getByText(/Sextant shows install plans but does not approve them/)).toBeInTheDocument();
    expect(v.getByText("etcd-operator-webhook-cert")).toBeInTheDocument();
    expect(container.textContent).not.toContain("c2VjcmV0LXZhbHVl");
    expect(v.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a failed InstallPlan: the reason and the bundle lookup", async () => {
    const container = await openDetails(plan("install-z3v8b"), INSTALL_PLAN);
    const v = view();
    expect(v.getByText("InstallComponentFailed: error creating clusterrole broken-operator: forbidden")).toBeInTheDocument();
    expect(v.getByText("BundleLookupFailed: unpack job not completed: DeadlineExceeded")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of a CatalogSource, an OperatorGroup and an Operator", async () => {
    let container = await openDetails(catalog("broken-catalog"), CATALOG_SOURCE);
    expect(view().getByText("The catalog's registry connection is TRANSIENT_FAILURE: Subscriptions cannot resolve from it.")).toBeInTheDocument();
    expect(view().getByRole("button", { name: "Open Service broken-catalog" })).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    document.body.innerHTML = "";
    container = await openDetails(find("OperatorGroup", "team-a"), OPERATOR_GROUP);
    expect(view().getByText(/TechPreviewUnsafeFailForward: OLM upgrades past failed installs/)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    document.body.innerHTML = "";
    container = await openDetails(find("Operator", "prometheus.operators"), OPERATOR);
    expect(view().getByRole("button", { name: "Open Subscription prometheus" })).toBeInTheDocument();
    expect(view().getByText("Succeeded=True")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("of OLM v1's ClusterExtension and ClusterCatalog", async () => {
    let container = await openDetails(find("ClusterExtension", "cert-manager"), CLUSTER_EXTENSION);
    expect(view().getByText("error upgrading from currently installed version: no bundles found")).toBeInTheDocument();
    expect(view().getByText("True (Retrying)")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
    document.body.innerHTML = "";
    container = await openDetails(find("ClusterCatalog", "operatorhubio"), CLUSTER_CATALOG);
    expect(view().getByText("True (Available)")).toBeInTheDocument();
    expect(view().getByText("quay.io/operatorhubio/catalog:latest")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
