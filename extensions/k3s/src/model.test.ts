// The model and the manifest's declarative parts. The model is the former built-in view's (ADR-0123), ported, with
// its tests; the manifest's problem rules, the kinds' "Only problems", the Node section's condition and the columns are
// judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the
// type check stays inside the extension; `missing`, `related` and `relatedBy` lookups as
// src/extensions/problemsAcross.ts judges them) and compared with the model on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import en from "./locales/en.json";
import { HIDDEN, maskedSet, maskedValuesContent, nodeArgs, secretFlag } from "./mask";
import { sizeText } from "./dom";
import {
  addonOwnerOf,
  builtInProblems,
  CHART_TONE,
  chartFailureOf,
  chartInfoOf,
  chartStateOf,
  clusterDistributionOf,
  componentOfDeployment,
  componentsOf,
  FAILED_FOR_MS,
  jobOfChart,
  loadBalancerAddresses,
  nodeDistributionOf,
  RETRY_GRACE_MS,
  serviceLbOf,
  shownComponent,
  SNAPSHOT_TONE,
  snapshotOf,
  snapshotStateOf,
  UNAVAILABLE_GRACE_MS,
  type BuiltInInputs,
} from "./model";

const f = fixtures as unknown as Record<string, KubeObject>;
const copy = <T>(value: T): T => structuredClone(value);
const fx = (name: string): KubeObject => copy(f[name]!);
const jobs = () => [fx("jobTraefik"), fx("jobFailed"), fx("jobRetrying")];
const st = (o: KubeObject) => (o.status ??= {}) as Record<string, unknown>;
const spec = (o: KubeObject) => (o.spec ??= {}) as Record<string, unknown>;
const conditions = (o: KubeObject) => (st(o).conditions ??= []) as Record<string, unknown>[];
const node = (over: { version?: string; providerID?: string; labels?: Record<string, string>; annotations?: Record<string, string> }): KubeObject => ({
  apiVersion: "v1",
  kind: "Node",
  metadata: { name: "n", labels: over.labels ?? {}, annotations: over.annotations ?? {} },
  spec: over.providerID ? { providerID: over.providerID } : {},
  status: { nodeInfo: { kubeletVersion: over.version ?? "v1.33.4" } },
});
const ann = (obj: KubeObject, key: string): string => (obj.metadata.annotations as Record<string, string>)[key]!;
const SECRETS = ["plain-old-secret", "abc123", "hunter2", "k3s-pass", "s3cr3t-value", "dbpass", "inline-pass", "repo-pass"];

// ---------- The model (the built-in view's tests) ----------

describe("recognition", () => {
  it.each([
    ["the kubelet's +k3s suffix", node({ version: "v1.31.2+k3s2" }), "k3s", ["kubeletVersion"]],
    ["the kubelet's +rke2r suffix", node({ version: "v1.31.2+rke2r1" }), "rke2", ["kubeletVersion"]],
    ["the k3s.io annotations", node({ annotations: { "k3s.io/hostname": "a" } }), "k3s", ["annotations"]],
    ["the rke2 provider ID", node({ providerID: "rke2://n" }), "rke2", ["providerId"]],
    ["the instance-type label", node({ labels: { "node.kubernetes.io/instance-type": "k3s" } }), "k3s", ["instanceType"]],
    ["the kubelet before annotations of the other", node({ version: "v1.31.2+rke2r1", annotations: { "k3s.io/node-args": "[]" } }), "rke2", ["kubeletVersion"]],
    ["nothing on a kubeadm node", f.nodePlain!, undefined, []],
    ["not a look-alike suffix", node({ version: "v1.31.2+k3sx" }), undefined, []],
  ])("%s", (_, obj, distribution, signals) => {
    const d = nodeDistributionOf(obj);
    expect(d.distribution).toBe(distribution);
    expect(d.signals).toEqual(signals);
  });

  it("reads a node's version, roles, addresses and etcd member", () => {
    expect(nodeDistributionOf(f.nodeK3sServer!)).toMatchObject({
      distribution: "k3s",
      version: "v1.33.4+k3s1",
      signals: ["kubeletVersion", "annotations", "providerId", "instanceType"],
      roles: ["controlPlane", "etcd"],
      server: true,
      hostname: "k3s-server-1",
      internalIp: "10.0.0.11",
      etcdMember: "k3s-server-1-6d1f4a2b",
    });
    expect(nodeDistributionOf(f.nodeK3sAgent!)).toMatchObject({ server: false, roles: [], externalIp: "203.0.113.21" });
    expect(nodeDistributionOf(f.nodeRke2!)).toMatchObject({ distribution: "rke2", roles: ["controlPlane", "etcd", "master"], etcdMember: "rke2-server-1-2c4e6a8b" });
  });

  it("sums up the cluster", () => {
    expect(clusterDistributionOf([f.nodeK3sServer!, f.nodeK3sAgent!, f.nodePlain!])).toEqual({
      distribution: "k3s",
      versions: ["v1.33.4+k3s1"],
      recognised: 2,
      total: 3,
      servers: 1,
      agents: 1,
      embeddedEtcd: true,
    });
    expect(clusterDistributionOf([f.nodeK3sServer!, f.nodeRke2!]).distribution).toBe("mixed");
    expect(clusterDistributionOf([f.nodePlain!]).distribution).toBeUndefined();
  });
});

describe("node arguments", () => {
  it("hides every secret value, k3s's own mask included, and keeps the rest", () => {
    const args = nodeArgs(ann(f.nodeK3sServer!, "k3s.io/node-args"))!;
    expect(args).toEqual([
      { value: "server", hidden: false },
      { flag: "--cluster-init", hidden: false },
      { flag: "--disable", value: "traefik", hidden: false },
      { flag: "--token", hidden: true },
      { flag: "--etcd-s3-secret-key", hidden: true },
      { flag: "--kube-apiserver-arg", hidden: true },
      { flag: "--tls-san", value: "k3s.example.com", hidden: false },
      { flag: "--write-kubeconfig-mode", value: "0644", hidden: false },
    ]);
    const all = JSON.stringify([args, nodeArgs(ann(f.nodeK3sAgent!, "k3s.io/node-args")), nodeArgs(ann(f.nodeRke2!, "rke2.io/node-args"))]);
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    expect(nodeArgs(ann(f.nodeRke2!, "rke2.io/node-args"))).toContainEqual({ flag: "--datastore-endpoint", hidden: true });
    expect(nodeArgs("not json")).toBeNull();
    expect(nodeArgs("[1, 2]")).toBeNull();
    expect(nodeArgs(undefined)).toBeUndefined();
  });

  it.each([
    ["--token", undefined, true],
    ["-t", undefined, true],
    ["--agent-token", undefined, true],
    ["--datastore-endpoint", undefined, true],
    ["--etcd-s3-access-key", undefined, true],
    ["--etcd-s3-session-token", undefined, true],
    ["--vpn-auth", undefined, true],
    ["--kubelet-arg", "max-pods=110", false],
    ["--kube-apiserver-arg", "oidc-client-secret=x", true],
    ["--disable", "traefik", false],
    ["--node-taint", "a=b:NoSchedule", false],
  ])("%s %s → secret %s", (flag, value, secret) => {
    expect(secretFlag(flag, value)).toBe(secret);
  });
});

describe("what Sextant gives masked (src/resources/masking-cases.json, shared with Rust and the window)", () => {
  const cases = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../src/resources/masking-cases.json"), "utf8")) as {
    nodeArgs: { name: string; text: string; args: unknown; masked: string | null }[];
    set: { name: string; set: unknown; masked: Record<string, string> | null }[];
    values: { name: string; text: string; masked: unknown }[];
  };

  it("reads Sextant's masked node arguments as the arguments themselves", () => {
    for (const c of cases.nodeArgs) {
      expect(nodeArgs(c.text), c.name).toEqual(c.args);
      if (c.masked !== null) expect(nodeArgs(c.masked), c.name).toEqual(c.args);
    }
  });

  it("shows Sextant's masked set values as the values themselves", () => {
    for (const c of cases.set) expect(maskedSet(c.masked ?? undefined), c.name).toEqual(maskedSet(c.set));
  });

  it("shows Sextant's masked valuesContent as the text itself, and nothing where Sextant gives nothing", () => {
    for (const c of cases.values) {
      const shown = maskedValuesContent(c.text);
      if (c.masked === null) expect(shown, c.name).toBeUndefined();
      else if (c.masked === "") expect(shown, c.name).toBe("");
      else {
        expect(parseYaml(shown!), c.name).toEqual(c.masked);
        expect(maskedValuesContent(JSON.stringify(c.masked)), c.name).toBe(shown);
      }
    }
  });
});

describe("values", () => {
  it("hides secret-looking keys and cleans addresses; unreadable text is not shown", () => {
    const masked = maskedValuesContent(spec(f.chartFailed!).valuesContent as string)!;
    expect(masked).toContain("replicaCount: 2");
    expect(masked).toContain(`apiToken: ${HIDDEN}`);
    expect(masked).toContain(`password: ${HIDDEN}`);
    for (const secret of SECRETS) expect(masked).not.toContain(secret);
    expect(maskedValuesContent("a: [unclosed")).toBeUndefined();
    expect(maskedValuesContent("- a\n- b\n")).toBeUndefined();
    expect(maskedValuesContent("  \n")).toBe("");
    expect(maskedSet(spec(f.chartFailed!).set)).toEqual([`auth.password=${HIDDEN}`, "ingress.enabled=true"]);
  });
});

describe("HelmCharts", () => {
  it("reads what a chart installs and where, with credentials out of the repository address", () => {
    const info = chartInfoOf(f.chartFailed!);
    expect(info).toMatchObject({ chart: "my-app", version: "1.2.3", targetNamespace: "apps", backOffLimit: 5, jobName: "helm-install-my-app", createNamespace: true });
    expect(info.repo).not.toContain("repo-pass");
    expect(info.repo).not.toContain("token");
    expect(chartInfoOf(f.chartTraefik!)).toMatchObject({ targetNamespace: "kube-system", backOffLimit: 1000, failurePolicy: "retry" });
    const deleting = fx("chartTraefik");
    deleting.metadata.deletionTimestamp = "2026-10-01T12:00:00Z";
    delete st(deleting).jobName;
    expect(chartInfoOf(deleting).jobName).toBe("helm-delete-traefik");
    expect(addonOwnerOf(f.chartTraefik!)).toEqual({ name: "traefik", namespace: "kube-system" });
    expect(addonOwnerOf(f.chartFailed!)).toBeUndefined();
  });

  it("tells the state from helm-controller's conditions and the Job", () => {
    expect(chartStateOf(f.chartTraefik!, f.jobTraefik!)).toBe("deployed");
    expect(chartStateOf(f.chartTraefik!)).toBe("applied");
    expect(chartStateOf(f.chartFailed!)).toBe("failed");
    expect(chartStateOf(f.chartRetrying!, f.jobRetrying!)).toBe("retrying");
    const bare = fx("chartFailed");
    delete bare.status;
    expect(chartStateOf(bare)).toBe("unknown");
    expect(chartStateOf(bare, f.jobFailed!)).toBe("failed");
    expect(jobOfChart(f.chartFailed!, jobs())?.metadata.name).toBe("helm-install-my-app");
  });
});

describe("bundled components", () => {
  const inputs = {
    addons: [f.addonCoredns!, f.addonTraefik!],
    charts: [f.chartTraefik!, f.chartRetrying!],
    jobs: jobs(),
    deployments: [f.deployCoredns!, f.deployTraefik!, f.deployLocalPath!, f.deployOther!, f.deployRke2Coredns!],
    daemonSets: [f.dsSvclb!, f.dsOther!],
  };

  it("k3s: each component by its manifest's Deployment or its chart's Helm release", () => {
    const rows = Object.fromEntries(componentsOf("k3s", inputs).map((r) => [r.def.id, r]));
    expect(rows.coredns).toMatchObject({ state: "ready" });
    expect(rows.traefik).toMatchObject({ state: "notReady", chartState: "deployed" });
    expect(rows.traefik!.workloads.map((w) => w.name)).toEqual(["traefik"]);
    expect(rows.localPath).toMatchObject({ state: "ready" });
    expect(rows.metricsServer).toMatchObject({ state: "notFound" });
    expect(rows.serviceLb!.workloads.map((w) => w.name)).toEqual(["svclb-traefik-5d3e1c2a"]);
    expect(componentsOf("k3s", inputs).every(shownComponent)).toBe(true);
  });

  it("RKE2: only the charts present are listed", () => {
    const shown = componentsOf("rke2", inputs).filter(shownComponent);
    expect(shown.map((r) => [r.def.id, r.state])).toEqual([
      ["rke2Coredns", "ready"],
      ["rke2IngressNginx", "installing"],
    ]);
  });

  it("knows the component Deployments the problems judge, and only those", () => {
    expect(componentOfDeployment(f.deployTraefik!)?.id).toBe("traefik");
    expect(componentOfDeployment(f.deployRke2Coredns!)?.id).toBe("rke2Coredns");
    expect(componentOfDeployment(f.deployOther!)).toBeUndefined();
  });

  it("ServiceLB: the Service of each DaemonSet and its load-balancer addresses", () => {
    expect(serviceLbOf(f.dsSvclb!)).toMatchObject({ service: "traefik", serviceNamespace: "kube-system", program: "k3s", desired: 2, ready: 2 });
    expect(serviceLbOf(f.dsOther!)).toBeUndefined();
    expect(loadBalancerAddresses(f.svcTraefik!)).toEqual(["10.0.0.11", "10.0.0.21"]);
  });
});

describe("etcd snapshots", () => {
  it("reads the node, the storage and the state, without credentials", () => {
    expect(snapshotOf(f.snapshotLocal!)).toMatchObject({ node: "k3s-server-1", storage: "local", size: "12582944", readyToUse: true });
    expect(snapshotStateOf(snapshotOf(f.snapshotLocal!))).toBe("ready");
    const s3 = snapshotOf(f.snapshotS3Failed!);
    expect(s3).toMatchObject({ storage: "s3", bucket: "k3s-backups" });
    expect(snapshotStateOf(s3)).toBe("failed");
  });
});

// ---------- Sextant's window engine ----------

interface Lookup {
  group: string;
  kind: string;
  name: string;
  fact?: string;
  by?: [string, string][];
}
interface Detected {
  reason: string;
  group: string;
  rule: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
  lookups?: Lookup[];
  object?: { kind: { group: string; version: string; kind: string }; namespace: string | null; name: string };
  notifyAs?: string;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): { holds: boolean };
  detectRule(rule: unknown, obj: KubeObject): Detected[];
  valueAt(obj: unknown, path: string): unknown;
}
interface Problem extends Detected {
  key: string;
  notifyKey: string;
  category: string;
  uid: string;
  object: NonNullable<Detected["object"]>;
  firstSeen: number;
  activeAt: number;
}
type KindKey = (kind: { group: string; kind: string }) => string;
interface Rows {
  status: string;
  rows: Map<string, unknown>;
  truncated: boolean;
  namespaces: null;
}
interface Across {
  judgeAcross(
    problems: Problem[],
    context: { rows: undefined; target(def: unknown): Rows | undefined; problemUids(): Set<string> },
    rules: { rules: Map<string, unknown>; targets: unknown[]; served?: (kind: { group: string; kind: string }) => boolean; api: number },
  ): Problem[];
  rowOf(labels: string[], facts: unknown[], keepLabels: boolean, values: string[]): (obj: KubeObject) => unknown;
  factsOf(rules: unknown[], keyOf: KindKey): Map<string, unknown[]>;
  comparedPaths(rules: unknown[], keyOf: KindKey): Map<string, string[]>;
  lookedUp(condition: unknown): { group: string; kind: string }[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  filter?: { type: string; value(obj: KubeObject, ctx: { now: number }): unknown };
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let across: Across;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  across = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemsAcross.ts"))) as Across;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
const groupOf = (o: KubeObject) => ((o.apiVersion ?? "").includes("/") ? o.apiVersion!.split("/")[0]! : "");
const kindOfObj = (o: KubeObject) => ({ group: groupOf(o), kind: o.kind ?? "" });
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

const keyOf: KindKey = (k) => `${k.group}/${k.kind}`.toLowerCase();
const ADDON_KIND = { group: "k3s.cattle.io", kind: "Addon" };

interface Cluster {
  /** The Jobs not read yet (or not readable): their lookups cannot tell. */
  jobsUnread?: boolean;
  /** The cluster serves k3s Addons (a k3s or RKE2 server). */
  server?: boolean;
}

/**
 * The problems the manifest's rules find, judged as the window judges them: each rule on its objects
 * (`problemRules.ts`), then their lookups on the rows of the looked-up kinds (`problemsAcross.ts`'s `judgeAcross`),
 * first seen at `firstSeen`.
 */
function windowJudged(objects: KubeObject[], firstSeen: number, cluster: Cluster = {}): Problem[] {
  const facts = across.factsOf(rules, keyOf);
  const compared = across.comparedPaths(rules, keyOf);
  const looked = rules.flatMap((rule) => across.lookedUp(rule.when));
  const kinds = looked.filter((k, i) => looked.findIndex((o) => keyOf(o) === keyOf(k)) === i);
  const defs = new Map(kinds.map((k) => [keyOf(k), { kind: k }]));
  const targets = kinds.map((k) => ({ ...k, namespaced: true, def: defs.get(keyOf(k)) }));
  const rows = new Map(
    kinds.map((k) => {
      const of = objects.filter((o) => keyOf(kindOfObj(o)) === keyOf(k));
      const row = across.rowOf([], facts.get(keyOf(k)) ?? [], false, compared.get(keyOf(k)) ?? []);
      const unread = cluster.jobsUnread === true && k.kind === "Job";
      return [defs.get(keyOf(k)), { status: unread ? "loading" : "ready", rows: new Map(of.map((o) => [o.metadata.uid ?? o.metadata.name, row(o)])), truncated: false, namespaces: null }] as const;
    }),
  );
  const problems = objects.flatMap((obj) =>
    rules
      .filter((rule) => sameKind(rule.kind, kindOfObj(obj)))
      .flatMap((rule) =>
        engine.detectRule(rule, obj).map((d): Problem => {
          const start = d.since ? Date.parse(d.since) : firstSeen;
          return {
            ...d,
            key: `${obj.metadata.uid}|${d.reason}`,
            notifyKey: `${obj.metadata.uid}|${d.group}`,
            category: "ext:sextant.k3s",
            uid: obj.metadata.uid ?? obj.metadata.name,
            object: d.object ?? { kind: { ...kindOfObj(obj), version: "v1" }, namespace: obj.metadata.namespace ?? null, name: obj.metadata.name },
            firstSeen,
            // As the problems store dates a problem (`resolve`).
            activeAt: d.activeFrom ?? (d.graceMs ? start + d.graceMs : Math.min(start, firstSeen)),
          };
        }),
      ),
  );
  const served = (k: { group: string; kind: string }) => keyOf(k) !== keyOf(ADDON_KIND) || cluster.server !== false;
  return across.judgeAcross(
    problems,
    { rows: undefined, target: (def) => rows.get(def as { kind: { group: string; kind: string } }) as Rows | undefined, problemUids: () => new Set() },
    { rules: new Map(rules.map((r) => [r.id, r])), targets, served, api: manifest.sextantApi },
  );
}

interface Found {
  kind: string;
  name: string;
  reason: string;
  message: string;
  activeAt: number;
  until?: number;
}

/** The problems the manifest's rules find, as the window finds them, each about its object, first seen at `firstSeen`. */
function windowProblems(objects: KubeObject[], firstSeen: number, cluster: Cluster = {}): Found[] {
  return windowJudged(objects, firstSeen, cluster).map((p) => ({
    kind: p.object.kind.kind,
    name: p.object.name,
    reason: p.reason,
    message: p.message ?? "",
    activeAt: p.activeAt,
    ...(p.until !== undefined ? { until: p.until } : {}),
  }));
}

const sorted = <T extends { kind: string; name: string; reason: string }>(list: T[]) =>
  [...list].sort((a, b) => `${a.kind}/${a.name}/${a.reason}`.localeCompare(`${b.kind}/${b.name}/${b.reason}`));

const NOW = Date.parse("2026-10-01T12:00:00Z");

/** The built-in problems in the window's terms. */
function builtIn(input: BuiltInInputs): Found[] {
  return builtInProblems(input, NOW).map((p) => ({ kind: p.kind, name: p.name, reason: p.reason, message: p.message, activeAt: p.activeAt, ...(p.until !== undefined ? { until: p.until } : {}) }));
}

const ADDONS = () => [fx("addonCoredns"), fx("addonTraefik")];

/** Both judge the same objects alike: the charts, their Jobs, kube-system's Deployments (on a server: with Addons). */
function expectSame(input: { charts?: KubeObject[]; jobs?: KubeObject[]; deployments?: KubeObject[]; server?: boolean; jobsUnread?: boolean }, label: string) {
  const server = input.server ?? true;
  const full: BuiltInInputs = {
    charts: input.charts ?? [],
    // Not read in full: the built-in category judged the charts without their Jobs.
    jobs: input.jobsUnread ? undefined : (input.jobs ?? []),
    deployments: server ? (input.deployments ?? []) : undefined,
  };
  const objects = [...(input.charts ?? []), ...(input.jobs ?? []), ...(input.deployments ?? []), ...(server ? ADDONS() : [])];
  expect(sorted(windowProblems(objects, NOW, { server, jobsUnread: input.jobsUnread === true })), label).toEqual(sorted(builtIn(full)));
}

// ---------- The problem rules ----------

describe("the problem rules, against the built-in ones", () => {
  it("find what the built-in category found on its fixtures", () => {
    const input = { charts: [fx("chartTraefik"), fx("chartFailed"), fx("chartRetrying")], jobs: jobs(), deployments: [fx("deployCoredns"), fx("deployTraefik"), fx("deployOther"), fx("deployRke2Coredns")] };
    expectSame(input, "fixtures");
    const found = sorted(windowProblems([...input.charts, ...input.jobs, ...input.deployments, ...ADDONS()], NOW));
    expect(found.map((p) => `${p.kind}/${p.name}:${p.reason}`)).toEqual([
      "Deployment/traefik:ComponentUnavailable",
      "HelmChart/my-app:HelmChartFailed",
      "HelmChart/rke2-ingress-nginx:HelmChartRetrying",
    ]);
    const failedAt = Date.parse("2026-10-01T10:00:00Z");
    // helm-controller's own message, dated from its Job's failure, as the built-in category told it.
    expect(found[1]).toMatchObject({ activeAt: failedAt, until: failedAt + FAILED_FOR_MS, message: "Job has reached configured number of retries without succeeding" });
    expect(found[2]).toMatchObject({ activeAt: NOW + RETRY_GRACE_MS, message: "Job helm-install-rke2-ingress-nginx: failed Pods so far: 4; helm-controller keeps retrying." });
    expect(found[0]).toMatchObject({ activeAt: Date.parse("2026-10-01T09:00:00Z") + UNAVAILABLE_GRACE_MS, message: "Bundled component traefik: 0 of 1 replicas available." });
    // The values of a chart never reach a problem.
    for (const secret of SECRETS) expect(JSON.stringify(found)).not.toContain(secret);
  });

  it("judge a chart and its install Job in every combination as the built-in provider did", () => {
    const failedAt = "2026-10-01T10:00:00Z";
    const charts: [string, (c: KubeObject) => void][] = [
      ["failed with a message", () => undefined],
      ["failed with only a reason", (c) => delete conditions(c)[1]!.message],
      ["failed without a message", (c) => (delete conditions(c)[1]!.message, delete conditions(c)[1]!.reason)],
      ["failed with an empty message", (c) => ((conditions(c)[1]!.message = ""), delete conditions(c)[1]!.reason)],
      ["not failed", (c) => (conditions(c)[1]!.status = "False")],
      ["no Failed condition", (c) => conditions(c).splice(1, 1)],
      ["no status", (c) => delete c.status],
      ["being deleted", (c) => (c.metadata.deletionTimestamp = "2026-10-01T11:00:00Z")],
      ["naming another Job", (c) => (st(c).jobName = "helm-install-other")],
      ["naming no Job", (c) => delete st(c).jobName],
    ];
    const job = (change: (j: KubeObject) => void) => {
      const j = fx("jobFailed");
      change(j);
      return j;
    };
    const failed = (j: KubeObject) => conditions(j).find((c) => c.type === "Failed")!;
    const jobVariants: [string, KubeObject[]][] = [
      ["no Job", []],
      ["a failed Job", [job(() => undefined)]],
      ["a failed Job without a message", [job((j) => delete failed(j).message)]],
      ["a failed Job without a time", [job((j) => delete failed(j).lastTransitionTime)]],
      ["a Job failed over a day ago", [job((j) => (failed(j).lastTransitionTime = new Date(NOW - FAILED_FOR_MS - 60_000).toISOString()))]],
      ["a Job failed just now", [job((j) => (failed(j).lastTransitionTime = new Date(NOW - 60_000).toISOString()))]],
      ["a Job still running after 4 failed pods", [job((j) => (st(j).conditions = [], (st(j).active = 1), (st(j).failed = 4)))]],
      ["a Job running after 3 failed pods", [job((j) => (st(j).conditions = [], (st(j).active = 1), (st(j).failed = 3)))]],
      ["a Job running after 2 failed pods", [job((j) => (st(j).conditions = [], (st(j).active = 1), (st(j).failed = 2)))]],
      ["a Job pending after 4 failed pods", [job((j) => (st(j).conditions = [], (st(j).failed = 4)))]],
      ["a complete Job after 4 failed pods", [job((j) => ((st(j).conditions = [{ type: "Complete", status: "True" }]), (st(j).failed = 4)))]],
      ["a Job with a False Failed condition", [job((j) => ((failed(j).status = "False"), (st(j).active = 1)))]],
      // The one the chart names first, else the newest labelled for it (`jobOfChart`).
      [
        "the named Job failed, a newer one runs",
        [job(() => undefined), job((j) => ((j.metadata.name = "helm-install-my-app-2"), (j.metadata.uid = "j2"), (j.metadata.creationTimestamp = "2026-10-01T11:00:00Z"), (st(j).conditions = []), (st(j).active = 1)))],
      ],
      [
        "an older Job failed, a newer one runs, neither named",
        [
          job((j) => ((j.metadata.name = "helm-install-my-app-old"), (j.metadata.uid = "j1"))),
          job((j) => ((j.metadata.name = "helm-install-my-app-new"), (j.metadata.uid = "j2"), (j.metadata.creationTimestamp = "2026-10-01T11:00:00Z"), (st(j).conditions = []), (st(j).active = 1), (st(j).failed = 4))),
        ],
      ],
      ["a failed Job of another chart", [job((j) => (j.metadata.labels!["helmcharts.helm.cattle.io/chart"] = "other"))]],
    ];
    expect(failedAt).toBe(failed(fx("jobFailed")).lastTransitionTime);
    for (const [chartLabel, change] of charts) {
      for (const [jobLabel, list] of jobVariants) {
        const chart = fx("chartFailed");
        change(chart);
        expectSame({ charts: [chart], jobs: copy(list) }, `${chartLabel}, ${jobLabel}`);
        expectSame({ charts: [copy(chart)], jobs: copy(list), jobsUnread: true }, `${chartLabel}, ${jobLabel}, Jobs not read`);
      }
    }
  });

  it("find a Failed chart's Job as the built-in did when `status.jobName` names none: the newest labelled for it", () => {
    const chart = fx("chartFailed");
    delete st(chart).jobName;
    const failedAt = Date.parse("2026-10-01T10:00:00Z");
    expect(windowProblems([chart, fx("jobFailed")], NOW)).toEqual([
      { kind: "HelmChart", name: "my-app", reason: "HelmChartFailed", message: "Job has reached configured number of retries without succeeding", activeAt: failedAt, until: failedAt + FAILED_FOR_MS },
    ]);
    expectSame({ charts: [chart], jobs: [fx("jobFailed")] }, "no status.jobName");
  });

  it("judge a Failed chart by its own condition while its Jobs cannot be read, as the built-in did", () => {
    const found = windowProblems([fx("chartFailed"), fx("jobFailed")], NOW, { jobsUnread: true });
    expect(found).toEqual([{ kind: "HelmChart", name: "my-app", reason: "HelmChartFailed", message: "Job has reached configured number of retries without succeeding", activeAt: NOW }]);
    const plain = fx("chartFailed");
    delete conditions(plain)[1]!.message;
    delete conditions(plain)[1]!.reason;
    expect(windowProblems([plain], NOW, { jobsUnread: true })[0]?.message).toBe("The install Job  of this HelmChart failed.");
  });

  it("tell a chart's problems about the chart itself, notifying once for it, in the built-in groups", () => {
    const judged = windowJudged([fx("chartFailed"), fx("jobFailed"), fx("chartRetrying"), fx("jobRetrying")], NOW);
    expect(judged.map((p) => [p.object.name, p.object.kind.kind, p.notifyKey, p.group])).toEqual([
      ["my-app", "HelmChart", "c0ffee00-0000-4000-8000-000000000002|helm-chart-failed", "helm-chart-failed"],
      ["rke2-ingress-nginx", "HelmChart", "c0ffee00-0000-4000-8000-000000000003|helm-chart-retrying", "helm-chart-retrying"],
    ]);
    // A Job's problems need its chart: without one, nothing is said.
    expect(windowProblems([fx("jobFailed"), fx("jobRetrying")], NOW)).toEqual([]);
    // A chart's Job's time is its problem's.
    expect(judged[0]).toMatchObject({ since: "2026-10-01T10:00:00Z" });
  });

  it("judge kube-system's component Deployments, only on a server (where Addons are served), as the built-in did", () => {
    const deployment = (name: string, change: (d: KubeObject) => void = () => undefined) => {
      const d = fx(name);
      change(d);
      return d;
    };
    const variants: [string, KubeObject][] = [
      ["traefik unavailable", deployment("deployTraefik")],
      ["coredns ready", deployment("deployCoredns")],
      ["coredns 1 of 2", deployment("deployCoredns", (d) => (spec(d).replicas = 2))],
      ["coredns no available count", deployment("deployCoredns", (d) => delete st(d).availableReplicas)],
      ["coredns no replicas, none available", deployment("deployCoredns", (d) => (delete spec(d).replicas, delete st(d).availableReplicas))],
      ["coredns no replicas, one available", deployment("deployCoredns", (d) => delete spec(d).replicas)],
      ["coredns scaled to 0", deployment("deployCoredns", (d) => ((spec(d).replicas = 0), delete st(d).availableReplicas))],
      ["coredns Available False but all there", deployment("deployCoredns", (d) => Object.assign(conditions(d)[0]!, { status: "False", lastTransitionTime: "2026-10-01T11:00:00Z" }))],
      ["coredns Available False without a time", deployment("deployCoredns", (d) => (Object.assign(conditions(d)[0]!, { status: "False" }), delete conditions(d)[0]!.lastTransitionTime))],
      ["coredns being deleted", deployment("deployCoredns", (d) => ((spec(d).replicas = 2), (d.metadata.deletionTimestamp = "2026-10-01T11:00:00Z")))],
      ["local-path unready", deployment("deployLocalPath", (d) => (st(d).availableReplicas = 0))],
      ["metrics-server unready", deployment("deployLocalPath", (d) => ((d.metadata.name = "metrics-server"), (st(d).availableReplicas = 0)))],
      ["rke2-coredns unready", deployment("deployRke2Coredns", (d) => (st(d).availableReplicas = 1))],
      ["an RKE2 CNI chart's workload unready", deployment("deployRke2Coredns", (d) => ((d.metadata.annotations!["meta.helm.sh/release-name"] = "rke2-cilium"), (st(d).availableReplicas = 0)))],
      ["another release unready", deployment("deployRke2Coredns", (d) => ((d.metadata.annotations!["meta.helm.sh/release-name"] = "my-release"), (st(d).availableReplicas = 0)))],
      ["another Deployment unready", deployment("deployOther")],
    ];
    for (const [label, d] of variants) {
      expectSame({ deployments: [d] }, `server: ${label}`);
      expectSame({ deployments: [copy(d)], server: false }, `no server: ${label}`);
    }
  });

  it("count on the sections as the built-in counters did: charts on helm-controller's, components on k3s / RKE2's", () => {
    const [helm, k3s] = manifest.contributes.sectionBadges;
    expect(helm!.section).toBe("helmController");
    expect(new Set(helm!.rules)).toEqual(new Set(rules.filter((r) => r.kind.kind === "HelmChart").map((r) => r.id)));
    expect(k3s).toMatchObject({ section: "k3s", rules: ["component-unavailable"] });
    // Rules of one problem notify as one, as the built-in key `<uid>|<reason>` did.
    expect(new Set(rules.map((r) => `${r.reasonOr}:${r.group}`))).toEqual(
      new Set(["HelmChartFailed:helm-chart-failed", "HelmChartRetrying:helm-chart-retrying", "ComponentUnavailable:component-unavailable"]),
    );
  });
});

// ---------- "Only problems" and the Node section ----------

describe("the kinds' \"Only problems\" and the Node section's condition, against the built-in ones", () => {
  const kindOf = (name: string) => manifest.contributes.kinds.find((k) => k.kind === name)! as { problemWhen?: unknown; printerColumns: boolean };

  it("list the HelmCharts helm-controller says failed and the snapshots with an error", () => {
    const charts = [fx("chartTraefik"), fx("chartFailed"), fx("chartRetrying")];
    const deleting = fx("chartFailed");
    deleting.metadata.deletionTimestamp = "2026-10-01T11:00:00Z";
    const notFailed = fx("chartFailed");
    conditions(notFailed)[1]!.status = "False";
    for (const c of [...charts, deleting, notFailed]) expect(engine.evaluate(kindOf("HelmChart").problemWhen, c).holds, c.metadata.name).toBe(chartStateOf(c) === "failed");
    const emptyError = fx("snapshotS3Failed");
    (st(emptyError).error as Record<string, unknown>).message = "";
    for (const s of [fx("snapshotLocal"), fx("snapshotS3Failed"), emptyError])
      expect(engine.evaluate(kindOf("ETCDSnapshotFile").problemWhen, s).holds, s.metadata.name).toBe(snapshotStateOf(snapshotOf(s)) === "failed");
    expect(kindOf("HelmChartConfig").problemWhen).toBeUndefined();
    expect(kindOf("Addon").problemWhen).toBeUndefined();
    for (const k of manifest.contributes.kinds) expect(k.printerColumns).toBe(false);
  });

  it("show the Node section on every node that tells k3s or RKE2; the frame hides it on a look-alike", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "k3s-node")!;
    const nodes: [string, KubeObject][] = [
      ["k3s server", f.nodeK3sServer!],
      ["k3s agent", f.nodeK3sAgent!],
      ["RKE2", f.nodeRke2!],
      ["kubeadm", f.nodePlain!],
      ["kubelet suffix", node({ version: "v1.31.2+k3s2" })],
      ["RKE2 kubelet suffix", node({ version: "v1.31.2+rke2r1" })],
      ...["node-config-hash", "hostname", "internal-ip", "external-ip"].map((a) => [`k3s.io/${a}`, node({ annotations: { [`k3s.io/${a}`]: "x" } })] as [string, KubeObject]),
      ...["node-config-hash", "hostname", "internal-ip", "external-ip"].map((a) => [`rke2.io/${a}`, node({ annotations: { [`rke2.io/${a}`]: "x" } })] as [string, KubeObject]),
      ["k3s provider ID", node({ providerID: "k3s://n" })],
      ["RKE2 provider ID", node({ providerID: "rke2://n" })],
      ["instance type k3s", node({ labels: { "node.kubernetes.io/instance-type": "k3s" } })],
      ["instance type rke2", node({ labels: { "node.kubernetes.io/instance-type": "rke2" } })],
      ["other instance type", node({ labels: { "node.kubernetes.io/instance-type": "m5.large" } })],
    ];
    for (const [label, n] of nodes) expect(engine.evaluate(section.when, n).holds, label).toBe(nodeDistributionOf(n).distribution !== undefined);
    // A look-alike suffix is no sign, as the built-in pattern read it (`fits`: `*+k3s#`).
    for (const version of ["v1.31.2+k3sx", "v1.31.2+k3s", "v1.31.2+rke2r", "v1.31.2+k3s1-rc"]) {
      const lookAlike = node({ version });
      expect(engine.evaluate(section.when, lookAlike).holds, version).toBe(false);
      expect(nodeDistributionOf(lookAlike).distribution, version).toBeUndefined();
    }
    expect(section).toMatchObject({ order: 29, heading: false, startHidden: true });
  });

  it("show it on a node whose only sign is its node-args or node-env annotation, reading only that it is there", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "k3s-node")!;
    for (const key of ["k3s.io/node-args", "k3s.io/node-env", "rke2.io/node-args", "rke2.io/node-env"]) {
      // As Sextant gives the annotation to an extension (empty) and as the window has it.
      for (const value of ["", "[]", '{"K3S_TOKEN":"x"}']) {
        const only = node({ annotations: { [key]: value } });
        expect(nodeDistributionOf(only).distribution, key).toBe(key.split(".")[0]);
        expect(engine.evaluate(section.when, only).holds, `${key} ${value}`).toBe(true);
      }
    }
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.k3s:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? "";
function drawn(id: string, obj: KubeObject): { title?: string; tone?: string } {
  let n = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = n?.props?.title || undefined;
  if (n?.props?.title !== undefined) n = n!.props!.children as typeof n;
  return { title, tone: n?.props?.tone };
}

describe("the columns, against the built-in ones", () => {
  it("are placed in the built-in order and widths, with the CRDs' own columns left out", () => {
    expect(manifest.contributes.columns.map((c) => [c.kind.kind, c.afterColumn, c.id, windowColumn(c.id).width])).toEqual([
      ["HelmChart", "namespace", "chart-state", "120px"],
      ["HelmChart", "chart-state", "chart-chart", "minmax(140px, 2fr)"],
      ["HelmChart", "chart-chart", "chart-version", "minmax(80px, 1fr)"],
      ["HelmChart", "chart-version", "chart-target-namespace", "minmax(100px, 1fr)"],
      ["HelmChart", "chart-target-namespace", "chart-addon", "minmax(100px, 1fr)"],
      ["HelmChartConfig", "namespace", "config-chart", "minmax(140px, 1fr)"],
      ["Addon", "namespace", "addon-source", "minmax(200px, 3fr)"],
      ["Addon", "addon-source", "addon-checksum", "120px"],
      ["ETCDSnapshotFile", "name", "snapshot-node", "minmax(120px, 1fr)"],
      ["ETCDSnapshotFile", "snapshot-node", "snapshot-storage", "90px"],
      ["ETCDSnapshotFile", "snapshot-storage", "snapshot-size", "100px"],
      ["ETCDSnapshotFile", "snapshot-size", "snapshot-created", "110px"],
      ["ETCDSnapshotFile", "snapshot-created", "snapshot-state", "110px"],
    ]);
  });

  function chartVariants(): [string, KubeObject][] {
    const out: [string, KubeObject][] = [
      ["traefik", fx("chartTraefik")],
      ["failed", fx("chartFailed")],
      ["retrying", fx("chartRetrying")],
    ];
    const v = (label: string, change: (c: KubeObject) => void) => {
      const c = fx("chartFailed");
      change(c);
      out.push([label, c]);
    };
    v("only a reason", (c) => delete conditions(c)[1]!.message);
    v("an empty message", (c) => (conditions(c)[1]!.message = ""));
    v("nothing said", (c) => (delete conditions(c)[1]!.message, delete conditions(c)[1]!.reason));
    v("not failed", (c) => (conditions(c)[1]!.status = "False"));
    v("deleting", (c) => ((conditions(c)[1]!.status = "False"), (c.metadata.deletionTimestamp = "2026-10-01T11:00:00Z")));
    v("failed while deleting", (c) => (c.metadata.deletionTimestamp = "2026-10-01T11:00:00Z"));
    v("no status", (c) => delete c.status);
    v("no target namespace", (c) => delete spec(c).targetNamespace);
    v("an empty target namespace", (c) => (spec(c).targetNamespace = ""));
    v("a credential in the chart", (c) => (spec(c).chart = "https://user:pw@charts.example.com/my-app.tgz?sig=1"));
    v("owned by another kind", (c) => (c.metadata.annotations = { "objectset.rio.cattle.io/owner-gvk": "apps/v1, Kind=Deployment", "objectset.rio.cattle.io/owner-name": "x" }));
    v("an Addon without a name", (c) => (c.metadata.annotations = { "objectset.rio.cattle.io/owner-gvk": "k3s.cattle.io/v1, Kind=Addon", "objectset.rio.cattle.io/owner-name": "" }));
    return out;
  }

  it("say a HelmChart's state as the built-in column did, coloured, with helm-controller's message on hover", () => {
    const TONE = { failed: "danger", deleting: "muted", applied: "neutral", unknown: "muted" } as Record<string, string>;
    for (const [label, obj] of chartVariants()) {
      const state = chartStateOf(obj);
      expect(cell("chart-state", obj), label).toBe(en[`chartState.${state}` as keyof typeof en]);
      expect(drawn("chart-state", obj), label).toEqual({ title: chartFailureOf(obj), tone: CHART_TONE[state] });
      expect(TONE[state], label).toBe(CHART_TONE[state]);
      expect(windowColumn("chart-state").value(obj), label).toBe(state);
      expect(windowColumn("chart-state").filter!.value(obj, { now: NOW }), label).toBe(state);
    }
  });

  it("show what a chart installs, where, and the Addon that deployed it", () => {
    for (const [label, obj] of chartVariants()) {
      const info = chartInfoOf(obj);
      expect(cell("chart-chart", obj), label).toBe(info.chart ?? "");
      expect(cell("chart-version", obj), label).toBe(info.version ?? "");
      expect(cell("chart-target-namespace", obj), label).toBe(info.targetNamespace);
      expect(cell("chart-addon", obj), label).toBe(addonOwnerOf(obj)?.name ?? "");
    }
  });

  it("show a HelmChartConfig's HelmChart and an Addon's manifest", () => {
    for (const obj of [fx("chartConfigTraefik"), fx("chartConfigOrphan")]) expect(cell("config-chart", obj)).toBe(obj.metadata.name);
    for (const obj of [fx("addonCoredns"), fx("addonTraefik")]) expect(cell("addon-source", obj)).toBe(spec(obj).source);
  });

  it("cut an Addon's checksum to its first 12 characters, silently, as the built-in column did", () => {
    const sum = spec(f.addonCoredns!).checksum as string;
    expect(cell("addon-checksum", fx("addonCoredns"))).toBe(sum.slice(0, 12));
    const short = fx("addonCoredns");
    spec(short).checksum = "abc";
    expect(cell("addon-checksum", short)).toBe("abc");
    const none = fx("addonCoredns");
    delete spec(none).checksum;
    expect(cell("addon-checksum", none)).toBe("");
  });

  function snapshotVariants(): [string, KubeObject][] {
    const out: [string, KubeObject][] = [
      ["local", fx("snapshotLocal")],
      ["s3 failed", fx("snapshotS3Failed")],
    ];
    const v = (label: string, base: string, change: (s: KubeObject) => void) => {
      const s = fx(base);
      change(s);
      out.push([label, s]);
    };
    v("not ready", "snapshotLocal", (s) => (st(s).readyToUse = false));
    v("no status", "snapshotLocal", (s) => delete s.status);
    v("s3 by location only", "snapshotS3Failed", (s) => delete spec(s).s3);
    v("s3 ready", "snapshotS3Failed", (s) => (delete st(s).error, (st(s).readyToUse = true)));
    v("an empty error", "snapshotS3Failed", (s) => ((st(s).error as Record<string, unknown>).message = ""));
    v("a size in Mi", "snapshotLocal", (s) => (st(s).size = "12Mi"));
    v("a size as a number", "snapshotLocal", (s) => (st(s).size = 4096));
    return out;
  }

  it("show a snapshot's node, storage, size, creation and state as the built-in columns did", () => {
    const BYTES = (n: number) => `${(n / 2 ** 20).toFixed(1)}MiB`;
    for (const [label, obj] of snapshotVariants()) {
      const s = snapshotOf(obj);
      const state = snapshotStateOf(s);
      expect(cell("snapshot-node", obj), label).toBe(s.node ?? "");
      expect(cell("snapshot-storage", obj), label).toBe(en[`storage.${s.storage}` as keyof typeof en]);
      expect(windowColumn("snapshot-storage").value(obj), label).toBe(s.storage);
      expect(cell("snapshot-state", obj), label).toBe(en[`snapshotState.${state}` as keyof typeof en]);
      expect(drawn("snapshot-state", obj), label).toEqual({ title: s.error, tone: SNAPSHOT_TONE[state] });
      expect(windowColumn("snapshot-state").value(obj), label).toBe(state);
    }
    // Sextant's own byte format, as the built-in `formatBytes`.
    expect(cell("snapshot-size", fx("snapshotLocal"))).toBe(BYTES(12582944));
    expect(cell("snapshot-size", snapshotVariants().find(([l]) => l === "a size in Mi")![1])).toBe("12.0MiB");
    expect(cell("snapshot-size", snapshotVariants().find(([l]) => l === "a size as a number")![1])).toBe("4.00KiB");
    // A size that is no quantity as it is, and every size sorted by the text shown, as the built-in column (`sizeText`).
    for (const [label, obj] of snapshotVariants()) {
      const size = snapshotOf(obj).size;
      expect(cell("snapshot-size", obj), label).toBe(size === undefined ? "" : sizeText(size));
    }
    const odd = fx("snapshotLocal");
    st(odd).size = "about 12 MB";
    expect(cell("snapshot-size", odd)).toBe("about 12 MB");
    expect(windowColumn("snapshot-size").value(odd)).toBe("about 12 MB");
    expect(windowColumn("snapshot-size").value(fx("snapshotLocal"))).toBe(BYTES(12582944));
    expect(cell("snapshot-created", fx("snapshotLocal"))).not.toBe("");
  });
});
