// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view (ADR-0121), ported unchanged — on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  CATALOG_GRACE_MS,
  CATALOG_SOURCE,
  catalogInfo,
  CLUSTER_CATALOG,
  CLUSTER_EXTENSION,
  componentsOf,
  conditionOf,
  conditionText,
  copiedFrom,
  crdsOf,
  CSV,
  CSV_FAILED_GRACE_MS,
  csvInfo,
  deploymentSelector,
  DETAILS,
  extensionInfo,
  catalogV1Info,
  INSTALL_PLAN,
  installModesOf,
  installPlanInfo,
  isCopy,
  isKind,
  isProblem,
  MAX_STEPS,
  NOT_COPIED_SELECTOR,
  olmProblems,
  OPERATOR,
  OPERATOR_GROUP,
  operatorGroupInfo,
  phaseTone,
  PLAN_STUCK_MS,
  RESOLUTION_GRACE_MS,
  requirementsOf,
  STATE_CONDITION,
  stepsOf,
  strategyDeployments,
  SUBSCRIPTION,
  SUBSCRIPTION_TONE,
  subscriptionInfo,
  subscriptionState,
  unmetRequirements,
  upgradePending,
  type Found,
  type KindOf,
} from "./model";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string, namespace?: string): KubeObject =>
  copy(objects.find((o) => o.kind === kind && o.metadata.name === name && (namespace === undefined || o.metadata.namespace === namespace))!);
const sub = (name: string) => find("Subscription", name);
const csv = (name: string, namespace = "operators") => find("ClusterServiceVersion", name, namespace);
const plan = (name: string) => find("InstallPlan", name);
const catalog = (name: string) => find("CatalogSource", name);
const st = (o: KubeObject) => o.status as Record<string, unknown>;
const at = (iso: string) => Date.parse(iso);
const ofKind = (kind: string) => objects.filter((o) => o.kind === kind).map(copy);

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
  object?: { kind: { group: string; version: string; kind: string }; namespace: string | null; name: string };
  notifyAs?: string;
  stamp?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
/** Sextant's table comparison (src/components/Table/ResourceTable.tsx): how a column's values sort. */
let compareCellValues: (a: unknown, b: unknown) => number;
let startI18n: (language: string) => Promise<unknown>;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  // Sextant's own texts, so lists join as in the window (`common:list.separator`).
  ({ startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n: typeof startI18n });
  await startI18n("en");
  ({ compareCellValues } = (await import(/* @vite-ignore */ join(here, "../../../src/components/Table/ResourceTable.tsx"))) as {
    compareCellValues: typeof compareCellValues;
  });
});

const holdsNow = (condition: unknown, obj: KubeObject, now: number) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** The problems the manifest's rules find in `obj`, as the window finds them. */
const windowProblems = (kind: KindOf, obj: KubeObject): Detected[] =>
  manifest.contributes.problems.filter((r) => sameKind(r.kind, kind)).flatMap((rule) => engine.detectRule(rule, obj));

/** The English text of a built-in problem's message (`messages.olmPlanStuck`, `messages.olmCatalogState`). */
function messageOf(d: Found): string {
  if (d.reason === "InstallPlanStuck") return `The Subscription's InstallPlan has been in phase ${d.messageParams!.phase} for more than 30 minutes.`;
  if (d.reason === "CatalogSourceNotReady") return `The catalog's registry connection is ${d.messageParams!.state}: Subscriptions cannot resolve from it.`;
  return d.message ?? "";
}

/** The built-in notification groups (a problem without one was grouped by its reason), as the rules' groups. */
const BUILT_IN_GROUPS: Record<string, string> = {
  failed: "failed",
  resolutionFailed: "resolution-failed",
  installPlanFailed: "install-plan-failed",
  InstallPlanStuck: "install-plan-stuck",
  CatalogSourceNotReady: "catalog-not-ready",
};

function expectSameProblems(kind: KindOf, obj: KubeObject): void {
  const expected = olmProblems(kind, obj).map((d) => ({
    reason: d.reason,
    message: messageOf(d),
    // A start that is no time counted as none (the problems store's `time(since) ?? firstSeen`): the window leaves it out.
    since: d.since && !Number.isNaN(Date.parse(d.since)) ? d.since : undefined,
    graceMs: d.graceMs,
    group: BUILT_IN_GROUPS[d.group ?? d.reason],
    // The InstallPlan the problem is about, in the window's shape, its version that of Sextant's own kind.
    object: d.about && { kind: { ...d.about.kind }, namespace: d.about.namespace, name: d.about.name },
    // The built-in progress was the plan's phase: the rule's stamp holds the same value.
    stamp: d.stamp === undefined ? undefined : JSON.stringify([d.stamp]),
  }));
  const found = windowProblems(kind, obj).map((d) => ({
    reason: d.reason,
    message: d.message,
    since: d.since,
    graceMs: d.graceMs,
    group: d.group,
    object: d.object,
    stamp: d.stamp,
  }));
  expect(found, `${kind.kind} ${obj.metadata.namespace}/${obj.metadata.name}`).toEqual(expected);
  // Notifications stay one per Subscription (by its uid), as the built-in identity, even about its InstallPlan.
  for (const d of windowProblems(kind, obj)) {
    if (d.object && obj.metadata.uid) expect(d.notifyAs).toBe(`${kind.group}/${kind.kind}/${obj.metadata.namespace}/${obj.metadata.uid}`);
  }
  // Every rule may notify, as every built-in one did (`notify` is left at its default, true).
  for (const rule of manifest.contributes.problems) expect((rule as { notify?: boolean }).notify).toBeUndefined();
}

const kindEntry = (kind: KindOf) => manifest.contributes.kinds.find((k) => sameKind(k, kind))!;

/** Variants of the fixtures the rules, filters and columns are compared on. */
function subscriptions(): KubeObject[] {
  const moving = sub("etcd");
  st(moving).conditions = [];
  delete (moving.spec as Record<string, unknown>).installPlanApproval;
  const fresh = sub("prometheus");
  delete (fresh as { status?: unknown }).status;
  const installing = sub("etcd");
  st(installing).conditions = [{ type: "InstallPlanPending", status: "True", reason: "Installing", lastTransitionTime: "2026-10-21T09:00:00Z" }];
  const planning = sub("etcd");
  st(planning).conditions = [{ type: "InstallPlanPending", status: "True", reason: "Planning" }];
  const unnamed = sub("strimzi-kafka-operator");
  for (const c of st(unnamed).conditions as Record<string, unknown>[]) delete c.reason;
  const planUnnamed = sub("broken-operator");
  for (const c of st(planUnnamed).conditions as Record<string, unknown>[]) c.reason = "";
  const upgradeFailed = sub("prometheus");
  st(upgradeFailed).state = "UpgradeFailed";
  const available = sub("prometheus");
  st(available).state = "UpgradeAvailable";
  const deleting = sub("strimzi-kafka-operator");
  deleting.metadata.deletionTimestamp = "2026-10-21T08:30:00Z";
  // A Subscription naming its plan only in the deprecated `status.installplan`, and one naming none.
  const oldRef = sub("broken-operator");
  delete st(oldRef).installPlanRef;
  st(oldRef).installplan = { apiVersion: "operators.coreos.com/v1alpha1", kind: "InstallPlan", name: "install-z3v8b", uuid: "ip-broken" };
  const oldRefStuck = sub("etcd");
  delete st(oldRefStuck).installPlanRef;
  st(oldRefStuck).conditions = [{ type: "InstallPlanPending", status: "True", reason: "Installing", lastTransitionTime: "2026-10-21T09:00:00Z" }];
  const noRef = sub("broken-operator");
  delete st(noRef).installPlanRef;
  // Condition times that do not read as times: the built-in filter counted them at once.
  const garbled = sub("strimzi-kafka-operator");
  for (const c of st(garbled).conditions as Record<string, unknown>[]) c.lastTransitionTime = "yesterday";
  const blank = sub("strimzi-kafka-operator");
  for (const c of st(blank).conditions as Record<string, unknown>[]) c.lastTransitionTime = "";
  const garbledPlan = sub("etcd");
  st(garbledPlan).conditions = [{ type: "InstallPlanPending", status: "True", reason: "Planning", lastTransitionTime: 1761037200 }];
  return [
    ...ofKind("Subscription"),
    moving,
    fresh,
    installing,
    planning,
    unnamed,
    planUnnamed,
    upgradeFailed,
    available,
    deleting,
    oldRef,
    oldRefStuck,
    noRef,
    garbled,
    blank,
    garbledPlan,
  ];
}

function csvs(): KubeObject[] {
  const byReason = csv("etcdoperator.v0.9.2");
  st(byReason).reason = "Copied";
  const byAnnotation = csv("etcdoperator.v0.9.2");
  byAnnotation.metadata.namespace = "team-b";
  const failedByAnnotation = csv("broken-operator.v1.0.0");
  failedByAnnotation.metadata.namespace = "team-b";
  // A copy an older OLM marked by its reason only: the selector lets it through, the rules still skip it.
  const leaked = csv("broken-operator.v1.0.0", "default");
  delete leaked.metadata.labels;
  const unnamed = csv("broken-operator.v1.0.0");
  delete st(unnamed).reason;
  const timeless = csv("broken-operator.v1.0.0");
  delete st(timeless).lastTransitionTime;
  const deleting = csv("broken-operator.v1.0.0");
  deleting.metadata.deletionTimestamp = "2026-10-20T11:02:00Z";
  const replacing = csv("prometheusoperator.0.70.0");
  st(replacing).phase = "Installing";
  delete st(replacing).reason;
  const garbled = csv("broken-operator.v1.0.0");
  st(garbled).lastTransitionTime = "not a time";
  const blank = csv("broken-operator.v1.0.0");
  st(blank).lastTransitionTime = "";
  const emptyReason = csv("broken-operator.v1.0.0");
  st(emptyReason).reason = "";
  const replaced = csv("prometheusoperator.0.70.0");
  st(replaced).phase = "Replacing";
  const removing = csv("etcdoperator.v0.9.2");
  st(removing).phase = "Deleting";
  return [
    ...ofKind("ClusterServiceVersion"),
    byReason,
    byAnnotation,
    failedByAnnotation,
    leaked,
    unnamed,
    timeless,
    deleting,
    replacing,
    garbled,
    blank,
    emptyReason,
    replaced,
    removing,
  ];
}

function catalogs(): KubeObject[] {
  const idle = catalog("operatorhubio-catalog");
  (st(idle).connectionState as Record<string, unknown>).lastObservedState = "IDLE";
  const connecting = catalog("broken-catalog");
  (st(connecting).connectionState as Record<string, unknown>).lastObservedState = "CONNECTING";
  const plain = catalog("broken-catalog");
  delete st(plain).connectionState;
  const deleting = catalog("broken-catalog");
  deleting.metadata.deletionTimestamp = "2026-10-21T08:30:00Z";
  return [...ofKind("CatalogSource"), idle, connecting, plain, deleting];
}

function installPlans(): KubeObject[] {
  const names = (n: number) => {
    const p = plan("install-p7x2k");
    (p.spec as Record<string, unknown>).clusterServiceVersionNames = Array.from({ length: n }, (_, i) => `operator-${String.fromCharCode(97 + ((i * 7) % 26))}.v${i}`);
    (p.spec as Record<string, unknown>).approved = n % 2 === 0;
    return p;
  };
  return [...ofKind("InstallPlan"), names(0), names(2), names(3), names(4), names(5), names(6)];
}

function operatorGroups(): KubeObject[] {
  const unreconciled = find("OperatorGroup", "team-a");
  delete st(unreconciled).namespaces;
  // An empty list in the status: the built-in view fell back to the requested namespaces.
  const empty = find("OperatorGroup", "team-a");
  st(empty).namespaces = [];
  (empty.spec as Record<string, unknown>).targetNamespaces = ["team-c", "team-b"];
  const several = find("OperatorGroup", "team-a");
  st(several).namespaces = ["team-a", "team-d"];
  return [...ofKind("OperatorGroup"), unreconciled, empty, several];
}

function extensions(): KubeObject[] {
  const out = ofKind("ClusterExtension");
  for (const base of ofKind("ClusterExtension")) {
    for (const [status, reason] of [
      ["True", "Succeeded"],
      ["False", "Succeeded"],
      ["True", "Retrying"],
      ["True", "Blocked"],
      ["False", "Failed"],
      ["True", "InvalidConfiguration"],
      ["True", "ProgressDeadlineExceeded"],
      ["Unknown", "Succeeded"],
      ["True", "RollingOut"],
      ["False", "Aborted"],
      ["True", undefined],
      ["False", undefined],
    ] as const) {
      const e = copy(base);
      for (const c of st(e).conditions as Record<string, unknown>[]) {
        c.status = status;
        if (c.type !== "Progressing") continue;
        if (reason === undefined) delete c.reason;
        else c.reason = reason;
      }
      out.push(e);
    }
  }
  return out;
}

// ---------- The model ----------

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
    const old = sub("prometheus");
    delete st(old).installPlanRef;
    expect(subscriptionInfo(old).installPlan).toEqual({ name: "install-p7x2k", namespace: "operators" });
  });

  it("tells a copy of a CSV from its original, as OLM's IsCopied does", () => {
    expect(isCopy(csv("prometheusoperator.0.70.0"))).toBe(false);
    const copied = csv("prometheusoperator.0.70.0", "default");
    expect(isCopy(copied)).toBe(true);
    expect(copiedFrom(copied)).toBe("operators");
    const [byReason, byAnnotation] = csvs().slice(-13);
    expect(isCopy(byReason!)).toBe(true);
    expect(isCopy(byAnnotation!)).toBe(true);
    expect(copiedFrom(byAnnotation!)).toBe("operators");
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
    expect(strategyDeployments(csv("broken-operator.v1.0.0"))).toEqual(["broken-operator", "broken-webhook"]);
    expect(installModesOf(prom).filter((m) => !m.supported).map((m) => m.type)).toEqual(["MultiNamespace"]);
    expect(deploymentSelector(prom)).toBe("olm.owner=prometheusoperator.0.70.0,olm.owner.kind=ClusterServiceVersion");
    const long = csv("etcdoperator.v0.9.2");
    long.metadata.name = "x".repeat(64);
    expect(deploymentSelector(long)).toBeUndefined();
  });

  it("reads an InstallPlan's approval, failure and steps, never a step's manifest", () => {
    expect(installPlanInfo(plan("install-q9w4m"))).toMatchObject({ phase: "RequiresApproval", approval: "Manual", approved: false });
    expect(installPlanInfo(plan("install-z3v8b")).failure).toMatchObject({ reason: "InstallComponentFailed" });
    const { steps, total } = stepsOf(plan("install-q9w4m"));
    expect(total).toBe(3);
    expect(JSON.stringify(steps)).not.toContain("manifest");
    const big = plan("install-q9w4m");
    st(big).plan = Array.from({ length: MAX_STEPS + 5 }, (_, i) => ({ resolving: "x", resource: { kind: "ConfigMap", name: `c${i}` }, status: "Created" }));
    expect(stepsOf(big).steps).toHaveLength(MAX_STEPS);
  });

  it("reads a CatalogSource, an OperatorGroup and OLM v1's conditions", () => {
    expect(catalogInfo(catalog("operatorhubio-catalog"))).toMatchObject({ sourceType: "grpc", pollInterval: "60m", state: "READY" });
    expect(operatorGroupInfo(find("OperatorGroup", "global-operators"))).toMatchObject({ allNamespaces: true, namespaces: [], upgradeStrategy: "Default" });
    expect(conditionText(find("ClusterExtension", "cert-manager"), "Progressing")).toMatchObject({ text: "True (Retrying)", tone: "warning" });
    expect(conditionText(find("ClusterCatalog", "operatorhubio"), "Serving")).toMatchObject({ text: "True (Available)", tone: "success" });
  });
});

// ---------- The manifest's problem rules ----------

describe("the problem rules, against the built-in category olm", () => {
  it("find what the built-in detector found, with its reason, message, start and grace", () => {
    for (const obj of subscriptions()) expectSameProblems(SUBSCRIPTION, obj);
    for (const obj of csvs()) expectSameProblems(CSV, obj);
    for (const obj of catalogs()) expectSameProblems(CATALOG_SOURCE, obj);
    // Nothing judges InstallPlans, OperatorGroups, Operators or OLM v1 (ADR-0121).
    const judged = new Set(manifest.contributes.problems.map((r) => r.kind.kind));
    expect([...judged].sort()).toEqual(["CatalogSource", "ClusterServiceVersion", "Subscription"]);
  });

  it("a failed CSV counts after five minutes; its copies never, listed without them by the API server", () => {
    const [failed] = windowProblems(CSV, csv("broken-operator.v1.0.0"));
    expect(failed).toMatchObject({ reason: "InstallCheckFailed", message: "install timeout", since: "2026-10-20T11:00:00Z", graceMs: CSV_FAILED_GRACE_MS });
    expect(windowProblems(CSV, csv("broken-operator.v1.0.0", "default"))).toEqual([]);
    for (const rule of manifest.contributes.problems.filter((r) => r.kind.kind === "ClusterServiceVersion")) {
      expect(rule.source).toEqual({ labelSelector: NOT_COPIED_SELECTOR });
    }
  });

  it("a Subscription: resolution after ten minutes, its InstallPlan failed at once, stuck after half an hour; waiting for approval never", () => {
    expect(windowProblems(SUBSCRIPTION, sub("strimzi-kafka-operator"))).toMatchObject([{ reason: "ConstraintsNotSatisfiable", graceMs: RESOLUTION_GRACE_MS }]);
    expect(windowProblems(SUBSCRIPTION, sub("broken-operator"))).toMatchObject([{ reason: "InstallComponentFailed", since: "2026-10-21T08:10:00Z" }]);
    expect(windowProblems(SUBSCRIPTION, sub("broken-operator"))[0]!.graceMs).toBeUndefined();
    expect(windowProblems(SUBSCRIPTION, sub("etcd"))).toEqual([]);
    const [stuck] = windowProblems(SUBSCRIPTION, subscriptions()[6]!);
    expect(stuck).toMatchObject({ reason: "InstallPlanStuck", graceMs: PLAN_STUCK_MS, message: "The Subscription's InstallPlan has been in phase Installing for more than 30 minutes." });
  });

  it("an InstallPlan's failure or stall is about the plan, notified once per Subscription; the stall's grace restarts with the phase", () => {
    const failedOn = (o: KubeObject) => windowProblems(SUBSCRIPTION, o).find((d) => d.group === "install-plan-failed")!;
    const planRef = { kind: { group: "operators.coreos.com", version: "v1alpha1", kind: "InstallPlan" }, namespace: "operators", name: "install-z3v8b" };
    expect(failedOn(sub("broken-operator"))).toMatchObject({ object: planRef, notifyAs: "operators.coreos.com/Subscription/operators/sub-broken" });
    const [, , , , , , , , , , oldRef, oldRefStuck, noRef] = subscriptions().slice(-16);
    expect(failedOn(oldRef!).object).toEqual(planRef);
    // Naming no plan, the problem is about the Subscription itself.
    expect(failedOn(noRef!).object).toBeUndefined();
    const stuck = (o: KubeObject) => windowProblems(SUBSCRIPTION, o).find((d) => d.group === "install-plan-stuck")!;
    expect(stuck(oldRefStuck!).object).toMatchObject({ name: "install-q9w4m" });
    const [installing, planning] = [subscriptions()[6]!, subscriptions()[7]!];
    expect(stuck(installing).stamp).not.toBe(stuck(planning).stamp);
    expect(stuck(installing).stamp).toBe(stuck(copy(installing)).stamp);
    // One rule per finding: the reason falls back to the built-in word when OLM gives none (`reasonOr`).
    expect(manifest.contributes.problems.map((r) => r.id)).toEqual([
      "csv-failed",
      "resolution-failed",
      "install-plan-failed",
      "install-plan-failed-old-ref",
      "install-plan-stuck",
      "install-plan-stuck-old-ref",
      "catalog-not-ready",
    ]);
    expect(windowProblems(SUBSCRIPTION, subscriptions()[8]!)).toMatchObject([{ reason: "ResolutionFailed" }]);
    expect(windowProblems(SUBSCRIPTION, subscriptions()[9]!)).toMatchObject([{ reason: "InstallPlanFailed" }]);
  });

  it("a catalog not READY (nor IDLE) for ten minutes from when it was first seen", () => {
    const [broken] = windowProblems(CATALOG_SOURCE, catalog("broken-catalog"));
    expect(broken).toMatchObject({ reason: "CatalogSourceNotReady", graceMs: CATALOG_GRACE_MS });
    expect(broken!.since).toBeUndefined();
  });
});

// ---------- "Only problems" ----------

describe("each kind's Only problems, against the built-in filter", () => {
  const times = ["2026-10-20T11:01:00Z", "2026-10-20T11:06:00Z", "2026-10-21T08:05:00Z", "2026-10-21T08:15:00Z", "2026-10-21T09:20:00Z", "2026-10-21T09:40:00Z", "2030-01-01T00:00:00Z"].map(at);
  const cases: [KindOf, KubeObject[]][] = [
    [SUBSCRIPTION, subscriptions()],
    [CSV, csvs()],
    [CATALOG_SOURCE, catalogs()],
    [INSTALL_PLAN, ofKind("InstallPlan")],
  ];
  it("shows the same objects at every time", () => {
    for (const [kind, list] of cases) {
      const when = kindEntry(kind).problemWhen;
      for (const obj of list) {
        for (const now of times) {
          expect(holdsNow(when, obj, now), `${kind.kind} ${obj.metadata.namespace}/${obj.metadata.name} at ${new Date(now).toISOString()}`).toBe(isProblem(obj, kind, now));
        }
      }
    }
    // The waiting InstallPlan is not one; the failed one is.
    expect(holdsNow(kindEntry(INSTALL_PLAN).problemWhen, plan("install-q9w4m"), times[0]!)).toBe(false);
    expect(holdsNow(kindEntry(INSTALL_PLAN).problemWhen, plan("install-z3v8b"), times[0]!)).toBe(true);
    for (const kind of [OPERATOR_GROUP, OPERATOR, CLUSTER_EXTENSION, CLUSTER_CATALOG]) expect(kindEntry(kind).problemWhen).toBeUndefined();
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.olm:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-21T10:00:00Z");
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}
const subState = (o: KubeObject) => en[`subscriptionState.${subscriptionState(o)}` as keyof typeof en];

describe("the columns, against the built-in ones", () => {
  it("are placed after the name or namespace, in the built-in order, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const ids = (k: string) => manifest.contributes.columns.filter((c) => c.kind.kind === k).map((c) => [c.afterColumn, c.id]);
    expect(ids("Subscription")).toEqual([
      ["namespace", "subscription-package"],
      ["subscription-package", "subscription-channel"],
      ["subscription-channel", "subscription-source"],
      ["subscription-source", "subscription-approval"],
      ["subscription-approval", "subscription-installed"],
      ["subscription-installed", "subscription-state"],
    ]);
    expect(ids("Operator")).toEqual([["name", "operator-components"]]);
  });

  it("of Subscriptions: package, channel, catalog, approval, installed CSV and the state with the failing condition's message", () => {
    for (const o of subscriptions()) {
      const info = subscriptionInfo(o);
      expect(cell("subscription-package", o)).toBe(info.packageName);
      expect(cell("subscription-channel", o)).toBe(info.channel);
      expect(cell("subscription-source", o)).toBe(info.source);
      expect(cell("subscription-approval", o)).toBe(info.approval);
      expect(cell("subscription-installed", o)).toBe(info.installedCSV);
      const state = subscriptionState(o);
      expect(cell("subscription-state", o), o.metadata.name).toBe(subState(o));
      const type = STATE_CONDITION[state];
      const message = type ? (st(o)?.conditions as { type: string; message?: string }[] | undefined)?.find((c) => c.type === type)?.message : undefined;
      expect(drawn("subscription-state", o), o.metadata.name).toEqual({ title: message || undefined, tone: SUBSCRIPTION_TONE[state] });
    }
  });

  it("of CSVs: display name, version, the phase toned with its reason and message, the original's namespace of a copy", () => {
    for (const o of csvs()) {
      const info = csvInfo(o);
      expect(cell("csv-display-name", o)).toBe(info.displayName);
      expect(cell("csv-version", o)).toBe(info.version);
      expect(cell("csv-phase", o)).toBe(info.phase);
      const title = [info.reason, info.message].filter(Boolean).join(": ");
      expect(drawn("csv-phase", o)).toEqual({ title: title || undefined, tone: phaseTone(info.phase) });
      expect(cell("csv-copied-from", o), `${o.metadata.namespace}/${o.metadata.name}`).toBe(copiedFrom(o));
    }
  });

  it("of InstallPlans: CSVs, approval, approved and the phase", () => {
    for (const o of installPlans()) {
      const info = installPlanInfo(o);
      expect(cell("install-plan-csvs", o)).toBe(info.csvNames.join(", ") || undefined);
      expect(cell("install-plan-approval", o)).toBe(info.approval);
      expect(cell("install-plan-approved", o)).toBe(info.approved ? "Yes" : "No");
      expect(cell("install-plan-phase", o)).toBe(info.phase);
    }
    expect(drawn("install-plan-phase", plan("install-z3v8b")).tone).toBe("danger");
    expect(drawn("install-plan-phase", plan("install-q9w4m")).tone).toBe("warning");
    expect(drawn("install-plan-phase", plan("install-p7x2k")).tone).toBe("success");
  });

  it("of CatalogSources, OperatorGroups and Operators", () => {
    for (const o of catalogs()) {
      const info = catalogInfo(o);
      expect(cell("catalog-source-display-name", o)).toBe(info.displayName);
      expect(cell("catalog-source-type", o)).toBe(info.sourceType);
      expect(cell("catalog-source-publisher", o)).toBe(info.publisher);
      expect(cell("catalog-source-connection", o)).toBe(info.state);
    }
    expect(drawn("catalog-source-connection", catalog("broken-catalog")).tone).toBe("danger");
    expect(drawn("catalog-source-connection", catalog("operatorhubio-catalog")).tone).toBe("success");
    expect(cell("operator-group-targets", find("OperatorGroup", "global-operators"))).toBe("All namespaces");
    expect(cell("operator-group-targets", find("OperatorGroup", "team-a"))).toBe("team-a");
    for (const o of operatorGroups()) {
      const info = operatorGroupInfo(o);
      const shown = info.allNamespaces ? "All namespaces" : (info.namespaces.length > 0 ? info.namespaces : info.targetNamespaces).join(", ");
      expect(cell("operator-group-targets", o), o.metadata.name).toBe(shown);
    }
    for (const o of ofKind("OperatorGroup")) expect(cell("operator-group-upgrade-strategy", o)).toBe(operatorGroupInfo(o).upgradeStrategy);
    const op = find("Operator", "prometheus.operators");
    expect(cell("operator-components", op)).toBe(String(componentsOf(op).total));
    delete st(op).components;
    expect(cell("operator-components", op)).toBe("0");
  });

  it("of OLM v1: package, version and conditions as the built-in conditionText, the catalog's image and unpack age", () => {
    for (const o of ofKind("ClusterExtension")) {
      expect(cell("cluster-extension-package", o)).toBe(extensionInfo(o).packageName);
      expect(cell("cluster-extension-installed-version", o)).toBe(extensionInfo(o).installedVersion);
      for (const [id, type] of [
        ["cluster-extension-installed", "Installed"],
        ["cluster-extension-progressing", "Progressing"],
      ] as const) {
        const c = conditionText(o, type)!;
        expect(cell(id, o)).toBe(c.text);
        expect(drawn(id, o)).toEqual({ title: c.title, tone: c.tone });
      }
    }
    // A condition without a reason, and one of another status.
    const bare = find("ClusterExtension", "argocd");
    for (const c of st(bare).conditions as Record<string, unknown>[]) {
      delete c.reason;
      c.status = "Unknown";
    }
    for (const [id, type] of [
      ["cluster-extension-installed", "Installed"],
      ["cluster-extension-progressing", "Progressing"],
    ] as const) {
      expect(cell(id, bare)).toBe(conditionText(bare, type)!.text);
      expect(drawn(id, bare).tone).toBe(conditionText(bare, type)!.tone);
    }
    const cat = find("ClusterCatalog", "operatorhubio");
    expect(cell("cluster-catalog-image", cat)).toBe(catalogV1Info(cat).image);
    expect(cell("cluster-catalog-serving", cat)).toBe("True (Available)");
    expect(drawn("cluster-catalog-serving", cat).tone).toBe("success");
    expect(cell("cluster-catalog-last-unpacked", cat)).toBe("common:age.hours:1");
  });
});

/** Sorted as the table sorts (values missing last in either direction), by `value`; the names in that order. */
function sortedBy(list: KubeObject[], value: (o: KubeObject) => unknown, descending = false): string[] {
  const rows = list.map((o, i) => ({ key: `${i}:${o.metadata.name}`, value: value(o) }));
  rows.sort((a, b) => {
    if (a.value === undefined || b.value === undefined) return a.value === undefined ? (b.value === undefined ? (a.key < b.key ? -1 : 1) : 1) : -1;
    return (descending ? -1 : 1) * compareCellValues(a.value, b.value) || (a.key < b.key ? -1 : 1);
  });
  return rows.map((r) => r.key);
}

describe("the columns' widths and order, against the built-in ones", () => {
  it("have the built-in widths", () => {
    const widths = Object.fromEntries(manifest.contributes.columns.map((c) => [c.id, (c as { width?: string }).width]));
    expect(widths).toEqual({
      "subscription-package": undefined,
      "subscription-channel": "minmax(80px, 1fr)",
      "subscription-source": undefined,
      "subscription-approval": "100px",
      "subscription-installed": "minmax(140px, 2fr)",
      "subscription-state": "150px",
      "csv-display-name": undefined,
      "csv-version": "100px",
      "csv-phase": "120px",
      "csv-copied-from": "minmax(100px, 1fr)",
      "install-plan-csvs": "minmax(160px, 3fr)",
      "install-plan-approval": "100px",
      "install-plan-approved": "90px",
      "install-plan-phase": "140px",
      "catalog-source-display-name": undefined,
      "catalog-source-type": "100px",
      "catalog-source-publisher": undefined,
      "catalog-source-connection": "160px",
      "operator-group-targets": "minmax(160px, 3fr)",
      "operator-group-upgrade-strategy": "140px",
      "operator-components": "110px",
      "cluster-extension-package": undefined,
      "cluster-extension-installed-version": "120px",
      "cluster-extension-installed": "140px",
      "cluster-extension-progressing": "180px",
      "cluster-catalog-image": "minmax(180px, 3fr)",
      "cluster-catalog-serving": "160px",
      "cluster-catalog-last-unpacked": "110px",
    });
  });

  it("sort the State, Approved, CSVs, targets and components as the built-in values did", () => {
    const value = (id: string) => (o: KubeObject) => windowColumn(id).value(o);
    const subs = subscriptions();
    expect(sortedBy(subs, value("subscription-state"))).toEqual(sortedBy(subs, subscriptionState));
    const plans = installPlans();
    expect(sortedBy(plans, value("install-plan-approved"))).toEqual(sortedBy(plans, (o) => installPlanInfo(o).approved));
    expect(sortedBy(plans, value("install-plan-csvs"))).toEqual(sortedBy(plans, (o) => installPlanInfo(o).csvNames.join(", ") || undefined));
    const groups = operatorGroups();
    const targets = (o: KubeObject) => {
      const info = operatorGroupInfo(o);
      return info.allNamespaces ? "*" : (info.namespaces.length > 0 ? info.namespaces : info.targetNamespaces).join(", ") || undefined;
    };
    expect(sortedBy(groups, value("operator-group-targets"))).toEqual(sortedBy(groups, targets));
    const ops = ofKind("Operator");
    const bare = copy(ops[0]!);
    delete st(bare).components;
    expect(sortedBy([...ops, bare], value("operator-components"))).toEqual(sortedBy([...ops, bare], (o) => componentsOf(o).total));
  });

  it("join an InstallPlan's CSVs with commas in every language, as the built-in column", async () => {
    await startI18n("ja");
    try {
      for (const o of installPlans()) {
        const names = installPlanInfo(o).csvNames;
        expect(cell("install-plan-csvs", o), `${names.length}`).toBe(names.join(", ") || undefined);
      }
      // An OperatorGroup's targets were the UI language's list in the built-in column, sorted by the names with commas.
      const several = operatorGroups().at(-1)!;
      expect(cell("operator-group-targets", several)).toBe("team-a、team-d");
      expect(windowColumn("operator-group-targets").value(several)).toBe("team-a, team-d");
    } finally {
      await startI18n("en");
    }
  });

  it("sort OLM v1's conditions by status, and Progressing by OLM's reasons, as the built-in values did", () => {
    const value = (id: string) => (o: KubeObject) => windowColumn(id).value(o);
    const exts = extensions();
    expect(sortedBy(exts, value("cluster-extension-installed"))).toEqual(sortedBy(exts, (o) => conditionOf(o, "Installed")?.status));
    // Progressing by its reason, any reason; one without a reason last in either direction, as the built-in column.
    const progressing = (o: KubeObject) => conditionOf(o, "Progressing")?.reason;
    expect(exts.filter((o) => progressing(o) === undefined && conditionOf(o, "Progressing")).length).toBeGreaterThan(1);
    for (const descending of [false, true]) {
      expect(sortedBy(exts, value("cluster-extension-progressing"), descending)).toEqual(sortedBy(exts, progressing, descending));
    }
    for (const o of exts.filter((e) => progressing(e) === undefined && conditionOf(e, "Progressing"))) {
      expect(windowColumn("cluster-extension-progressing").value(o)).toBeUndefined();
      expect(cell("cluster-extension-progressing", o)).toBe(conditionText(o, "Progressing")!.text);
    }
    const cats = ofKind("ClusterCatalog").flatMap((o) =>
      ["True", "False", "Unknown"].map((status) => {
        const c = copy(o);
        for (const x of st(c).conditions as Record<string, unknown>[]) if (x.type === "Serving") x.status = status;
        return c;
      }),
    );
    expect(sortedBy(cats, value("cluster-catalog-serving"))).toEqual(sortedBy(cats, (o) => conditionOf(o, "Serving")?.status));
    for (const o of cats) expect(cell("cluster-catalog-serving", o)).toBe(conditionText(o, "Serving")!.text);
  });
});

describe("the manifest", () => {
  it("lists the eight kinds in the section olm, each with a details section of its own", () => {
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.section, k.order])).toEqual([
      ["Subscription", "olm", 10],
      ["ClusterServiceVersion", "olm", 20],
      ["InstallPlan", "olm", 30],
      ["CatalogSource", "olm", 40],
      ["OperatorGroup", "olm", 50],
      ["Operator", "olm", 60],
      ["ClusterExtension", "olm", 70],
      ["ClusterCatalog", "olm", 80],
    ]);
    expect(manifest.contributes.sections).toEqual([{ section: "olm", title: "Operators (OLM)", icon: "olm", after: "kserve" }]);
    for (const section of manifest.contributes.detailsSections) {
      const kind = DETAILS[section.id]!;
      expect(section.kinds).toEqual([{ group: kind.group, kind: kind.kind }]);
      expect(section.order).toBe(20);
      // Untitled, as the built-in section: the kind's name stays its accessible name.
      expect(section.heading).toBe(false);
    }
  });

  it("asks to read only, with no action of its own: nothing approves an InstallPlan", () => {
    expect(manifest.permissions.rules.map((r) => r.actions)).toEqual([["read"]]);
    expect("actions" in manifest.contributes).toBe(false);
    const read = manifest.permissions.rules[0]!.kinds.kinds!;
    for (const kind of manifest.contributes.kinds) expect(read.some((k) => isKind(k, { ...kind, version: "" }))).toBe(true);
    expect(read).toContainEqual({ group: "apps", kind: "Deployment" });
    // No path of a rule or a column reads an InstallPlan step (its manifest is inline secret material).
    expect(JSON.stringify(manifest.contributes)).not.toContain(".status.plan");
  });
});
