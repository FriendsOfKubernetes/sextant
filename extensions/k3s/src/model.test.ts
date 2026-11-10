// The model and the manifest's declarative parts. The model is the former built-in view's (ADR-0123), ported, with
// its tests; the manifest's problem rules, the kinds' "Only problems", the Node section's condition and the columns are
// judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run time so the
// type check stays inside the extension; `missing`, `related` and `relatedBy` lookups as
// src/extensions/problemsAcross.ts judges them) and compared with the model on its fixtures and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import fixtures from "../fixtures/objects.json";
import en from "./locales/en.json";
import { HIDDEN, maskedSet, maskedValuesContent, nodeArgs, secretFlag } from "./mask";
import {
  addonOwnerOf,
  BUILT_IN_MESSAGES,
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
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

type Rule = (typeof manifest.contributes.problems)[number];
const rules = manifest.contributes.problems as Rule[];
const groupOf = (o: KubeObject) => ((o.apiVersion ?? "").includes("/") ? o.apiVersion!.split("/")[0]! : "");
const kindOfObj = (o: KubeObject) => ({ group: groupOf(o), kind: o.kind ?? "" });
const sameKind = (a: { group: string; kind: string }, b: { group: string; kind: string }) => a.group === b.group && a.kind === b.kind;

/** Whether the objects a problem looks up stand as the window's `judgeAcross` asks, in the judged object's namespace. */
function lookupsStand(d: Detected, judged: KubeObject, objects: KubeObject[]): boolean {
  const ns = judged.metadata.namespace ?? "";
  return (d.lookups ?? []).every((lookup) => {
    const there = objects.filter((o) => sameKind(kindOfObj(o), lookup) && (o.metadata.namespace ?? "") === ns);
    const holds = (o: KubeObject) => lookup.fact === undefined || engine.evaluate(JSON.parse(lookup.fact), o).holds;
    if (lookup.by) return there.some((o) => lookup.by!.every(([path, value]) => String(engine.valueAt(o, path)) === value) && holds(o));
    const found = there.find((o) => o.metadata.name === lookup.name);
    if (lookup.fact === undefined) return found === undefined;
    return found !== undefined && holds(found);
  });
}

function windowDetected(objects: KubeObject[]) {
  return objects.flatMap((obj) =>
    rules
      .filter((rule) => sameKind(rule.kind, kindOfObj(obj)))
      .flatMap((rule) => engine.detectRule(rule, obj).map((d) => ({ rule, d, obj })))
      .filter(({ d, obj: judged }) => lookupsStand(d, judged, objects)),
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
function windowProblems(objects: KubeObject[], firstSeen: number): Found[] {
  return windowDetected(objects).map(({ d, obj }) => {
    const start = d.since ? Date.parse(d.since) : firstSeen;
    return {
      kind: d.object?.kind.kind ?? obj.kind ?? "",
      name: d.object?.name ?? obj.metadata.name,
      reason: d.reason,
      message: d.message ?? "",
      activeAt: d.activeFrom ?? start + (d.graceMs ?? 0),
      ...(d.until !== undefined ? { until: d.until } : {}),
    };
  });
}

const sorted = <T extends { kind: string; name: string; reason: string }>(list: T[]) =>
  [...list].sort((a, b) => `${a.kind}/${a.name}/${a.reason}`.localeCompare(`${b.kind}/${b.name}/${b.reason}`));

const NOW = Date.parse("2026-10-01T12:00:00Z");

/**
 * The built-in problems in the window's terms, with the one difference the manifest cannot avoid: a chart whose own
 * Failed condition holds while its install Job failed is told by the Job's rule, so its message is the Job's (else
 * the plain text), not helm-controller's; and a Failed chart without a Job names the Job \`status.jobName\` names where the
 * built-in plain text left the name empty (README "Requirements and limits").
 */
function builtIn(input: BuiltInInputs): Found[] {
  const charts = [...input.charts];
  return builtInProblems(input, NOW).map((p) => {
    const out: Found = { kind: p.kind, name: p.name, reason: p.reason, message: p.message, activeAt: p.activeAt, ...(p.until !== undefined ? { until: p.until } : {}) };
    const chart = charts.find((c) => c.kind === p.kind && c.metadata.name === p.name && c.metadata.namespace === p.namespace);
    const job = chart && input.jobs ? jobOfChart(chart, input.jobs) : undefined;
    const jobFailed = job && (job.status?.conditions as { type: string; status: string }[] | undefined)?.some((c) => c.type === "Failed" && c.status === "True");
    if (p.reason === "HelmChartFailed" && chart && jobFailed && chartStateOf(chart) === "failed") {
      const message = chartFailureOf({ ...chart, status: { ...chart.status, conditions: [] } }, job);
      out.message = message ?? BUILT_IN_MESSAGES.k3sHelmChartFailed.replace("{{job}}", job.metadata.name);
    }
    // Without a Job, the built-in plain message left the Job's name out ("The install Job  of …"); the rule names the
    // one helm-controller wrote in `status.jobName`.
    if (p.reason === "HelmChartFailed" && chart && !job && p.message === BUILT_IN_MESSAGES.k3sHelmChartFailed.replace("{{job}}", "")) {
      out.message = BUILT_IN_MESSAGES.k3sHelmChartFailed.replace("{{job}}", String(chart.status?.jobName ?? ""));
    }
    return out;
  });
}

const ADDONS = () => [fx("addonCoredns"), fx("addonTraefik")];

/** Both judge the same objects alike: the charts, their Jobs, kube-system's Deployments (on a server: with Addons). */
function expectSame(input: { charts?: KubeObject[]; jobs?: KubeObject[]; deployments?: KubeObject[]; server?: boolean }, label: string) {
  const server = input.server ?? true;
  const full: BuiltInInputs = { charts: input.charts ?? [], jobs: input.jobs ?? [], deployments: server ? (input.deployments ?? []) : undefined };
  const objects = [...(input.charts ?? []), ...(input.jobs ?? []), ...(input.deployments ?? []), ...(server ? ADDONS() : [])];
  expect(sorted(windowProblems(objects, NOW)), label).toEqual(sorted(builtIn(full)));
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
    expect(found[1]).toMatchObject({ activeAt: failedAt, until: failedAt + FAILED_FOR_MS, message: "Job has reached the specified backoff limit" });
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
    ];
    expect(failedAt).toBe(failed(fx("jobFailed")).lastTransitionTime);
    for (const [chartLabel, change] of charts) {
      for (const [jobLabel, list] of jobVariants) {
        const chart = fx("chartFailed");
        change(chart);
        // The one place the window cannot follow: a Failed chart whose Job failed is told by the Job, see `builtIn`;
        // a Failed chart naming no Job (or another) keeps the chart's own reading, without the Job's day.
        if (chartLabel === "naming another Job" && chartStateOf(chart) === "failed" && list.length > 0) continue;
        expectSame({ charts: [chart], jobs: copy(list) }, `${chartLabel}, ${jobLabel}`);
      }
    }
  });

  it("leave a Failed chart without `status.jobName` to its own condition (the built-in found its Job by the name it would give it)", () => {
    const chart = fx("chartFailed");
    delete st(chart).jobName;
    const found = windowProblems([chart, fx("jobFailed")], NOW);
    expect(found).toEqual([{ kind: "HelmChart", name: "my-app", reason: "HelmChartFailed", message: "Job has reached configured number of retries without succeeding", activeAt: NOW }]);
    const failedAt = Date.parse("2026-10-01T10:00:00Z");
    expect(builtInProblems({ charts: [chart], jobs: [fx("jobFailed")], deployments: [] }, NOW)).toMatchObject([
      { ...found[0], since: "2026-10-01T10:00:00Z", activeAt: failedAt, until: failedAt + FAILED_FOR_MS },
    ]);
  });

  it("tell a Job's problem about its HelmChart, notifying once for the chart, in the built-in groups", () => {
    const detected = windowDetected([fx("chartFailed"), fx("jobFailed"), fx("chartRetrying"), fx("jobRetrying")]);
    expect(detected.map(({ obj, d }) => [obj.metadata.name, d.object, d.notifyAs, d.group])).toEqual([
      ["helm-install-my-app", { kind: { group: "helm.cattle.io", version: "v1", kind: "HelmChart" }, namespace: "kube-system", name: "my-app" }, "helm.cattle.io/HelmChart/kube-system/my-app", "helm-chart-failed"],
      [
        "helm-install-rke2-ingress-nginx",
        { kind: { group: "helm.cattle.io", version: "v1", kind: "HelmChart" }, namespace: "kube-system", name: "rke2-ingress-nginx" },
        "helm.cattle.io/HelmChart/kube-system/rke2-ingress-nginx",
        "helm-chart-retrying",
      ],
    ]);
    // Without the chart among the rows (not read yet), nothing is said.
    expect(windowProblems([fx("jobFailed"), fx("jobRetrying")], NOW)).toEqual([]);
  });

  it("judge kube-system's component Deployments, only on a server (where Addons are there), as the built-in did", () => {
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
    expect(new Set(helm!.rules)).toEqual(new Set(rules.filter((r) => r.kind.kind !== "Deployment").map((r) => r.id)));
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
    // A look-alike suffix passes the condition (no condition reads a pattern); the frame finds no distribution and hides.
    const lookAlike = node({ version: "v1.31.2+k3sx" });
    expect(engine.evaluate(section.when, lookAlike).holds).toBe(true);
    expect(nodeDistributionOf(lookAlike).distribution).toBeUndefined();
    expect(section).toMatchObject({ order: 29, heading: false, startHidden: true });
  });

  it("leave out a node whose only sign is its node-args or node-env annotation, which Sextant keeps from extensions", () => {
    const section = manifest.contributes.detailsSections.find((s) => s.id === "k3s-node")!;
    const only = node({ annotations: { "k3s.io/node-args": "[]" } });
    expect(nodeDistributionOf(only).distribution).toBe("k3s");
    expect(engine.evaluate(section.when, only).holds).toBe(false);
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

  it("cut an Addon's checksum to its first 12 characters, with \"…\" where the built-in column cut it silently", () => {
    const sum = spec(f.addonCoredns!).checksum as string;
    expect(cell("addon-checksum", fx("addonCoredns"))).toBe(`${sum.slice(0, 12)}…`);
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
    expect(cell("snapshot-created", fx("snapshotLocal"))).not.toBe("");
  });
});
