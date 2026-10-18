import i18n from "i18next";
import { describe, expect, it } from "vitest";
import type { ApiUsage, UpgradeScan } from "../../api";
import { countByStatus, defaultTarget, evaluate, filterFindings, servedFindings, targetChoices } from "./evaluate";
import { csvReport, markdownReport } from "./report";
import { nodeSkew, skewIssues } from "./skew";
import { splitApiVersion } from "./table";

const usage = (apiVersion: string, kind: string, namespace: string | null, name: string, origin: ApiUsage["origin"]): ApiUsage => {
  return { api: { ...splitApiVersion(apiVersion), kind }, namespace, name, origin };
};

function scanOf(partial: Partial<UpgradeScan> = {}): UpgradeScan {
  return {
    version: { gitVersion: "v1.24.6", major: "1", minor: "24", platform: "linux/amd64" },
    served: [],
    usages: [],
    usagesTruncated: false,
    nodes: [],
    components: [],
    sources: [],
    ...partial,
  };
}

const scan = scanOf({
  served: [
    { group: "policy", version: "v1beta1", kind: "PodDisruptionBudget" },
    { group: "autoscaling", version: "v2beta2", kind: "HorizontalPodAutoscaler" },
  ],
  usages: [
    usage("batch/v1beta1", "CronJob", "shop", "nightly", { type: "helm", release: "shop", namespace: "shop", revision: 3 }),
    usage("batch/v1beta1", "CronJob", "shop", "nightly", { type: "managedFields", manager: "helm" }),
    usage("autoscaling/v2beta2", "HorizontalPodAutoscaler", "web", "api", { type: "argoCd", application: "web", namespace: "argocd" }),
    usage("extensions/v1beta1", "Ingress", "web", "old", { type: "managedFields", manager: "kubectl" }),
    usage("policy/v1beta1", "PodSecurityPolicy", null, "restricted", { type: "flux", kustomization: "infra", namespace: "flux-system" }),
    usage("apps/v1", "Deployment", "web", "api", { type: "lastApplied" }),
  ],
});

describe("evaluating a scan for a target version", () => {
  it("lists what is removed or deprecated at the target, one row per object with every source", () => {
    const findings = evaluate(scan, 24, 25);
    expect(findings.map((f) => [f.status, f.apiVersion, f.kind, f.name])).toEqual([
      ["removed", "extensions/v1beta1", "Ingress", "old"],
      ["removed", "batch/v1beta1", "CronJob", "nightly"],
      ["removed", "policy/v1beta1", "PodSecurityPolicy", "restricted"],
      ["deprecated", "autoscaling/v2beta2", "HorizontalPodAutoscaler", "api"],
    ]);
    const cron = findings[1]!;
    expect(cron.sources).toEqual(["helm", "live"]);
    expect(cron.origins).toHaveLength(2);
    expect(cron.replacement).toBe("batch/v1");
    expect(findings[2]).toMatchObject({ replacement: null, note: "podSecurityAdmission", namespace: null });
    // Removed before 1.24 and only in field managers: a trace of an old write.
    expect(findings[0]).toMatchObject({ alreadyRemoved: true, historyOnly: true });
    expect(countByStatus(findings)).toEqual({ removed: 3, deprecated: 1 });
  });

  it("shows only what is deprecated by an earlier target, and nothing where all of it is still fine", () => {
    expect(evaluate(scan, 20, 20).map((f) => f.kind)).toEqual(["Ingress"]);
    expect(evaluate(scan, 20, 21).map((f) => [f.status, f.kind])).toEqual([
      ["deprecated", "Ingress"],
      ["deprecated", "CronJob"],
      ["deprecated", "PodSecurityPolicy"],
    ]);
    expect(evaluate(scan, 13, 13)).toEqual([]);
  });

  it("filters by source, namespace and history", () => {
    const findings = evaluate(scan, 24, 26);
    const all = new Set(["live", "helm", "argoCd", "flux"] as const);
    expect(filterFindings(findings, { sources: all, namespaces: null, history: false }).map((f) => f.name)).toEqual([
      "nightly",
      "restricted",
      "api",
    ]);
    expect(filterFindings(findings, { sources: all, namespaces: null, history: true })).toHaveLength(4);
    expect(filterFindings(findings, { sources: new Set(["helm"]), namespaces: null, history: true }).map((f) => f.name)).toEqual([
      "nightly",
    ]);
    // A cluster-scoped finding stays with any namespace filter.
    expect(filterFindings(findings, { sources: all, namespaces: ["web"], history: false }).map((f) => f.name)).toEqual([
      "restricted",
      "api",
    ]);
  });

  it("lists the deprecated versions the cluster serves", () => {
    expect(servedFindings(scan, 25).map((s) => [s.status, s.apiVersion])).toEqual([
      ["removed", "policy/v1beta1"],
      ["deprecated", "autoscaling/v2beta2"],
    ]);
    expect(servedFindings(scan, 26).map((s) => s.status)).toEqual(["removed", "removed"]);
  });

  it("offers target versions from the cluster's on, the next one by default", () => {
    expect(defaultTarget(31, 35)).toBe(32);
    expect(defaultTarget(null, 35)).toBe(35);
    expect(targetChoices(31, 35)).toEqual([31, 32, 33, 34, 35, 36]);
    expect(targetChoices(24, 35)).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
  });
});

describe("version skew", () => {
  const node = (name: string, kubeletVersion: string) => ({ name, kubeletVersion, kubeProxyVersion: "", controlPlane: false });

  it("allows kubelets and kube-proxies three minors behind, two before 1.25", () => {
    expect(nodeSkew(25)).toBe(3);
    expect(nodeSkew(24)).toBe(2);
  });

  it("checks kube-proxy against kube-apiserver and against the kubelet beside it", () => {
    const issues = skewIssues(30, 31, [
      { name: "a", kubeletVersion: "v1.30.0", kubeProxyVersion: "v1.26.0", controlPlane: false },
      { name: "b", kubeletVersion: "v1.30.0", kubeProxyVersion: "v1.27.3", controlPlane: false },
      { name: "c", kubeletVersion: "v1.30.0", kubeProxyVersion: "", controlPlane: false },
    ], []);
    expect(issues).toEqual([
      { type: "kubeProxyTooOld", nodes: ["a"], oldest: 26 },
      { type: "kubeProxyTooOldForTarget", nodes: ["b"], oldest: 27, target: 31 },
      { type: "kubeProxyKubeletSkew", nodes: ["a"] },
    ]);
  });

  it("asks for one minor at a time and for old kubelets to go first", () => {
    const issues = skewIssues(30, 32, [node("a", "v1.30.2"), node("b", "v1.28.9"), node("c", "v1.26.0"), node("d", "v1.31.0")], []);
    expect(issues).toEqual([
      { type: "stepwise", from: 30, to: 32, steps: [31, 32] },
      { type: "kubeletNewer", nodes: ["d"], apiserver: 30 },
      { type: "kubeletTooOld", nodes: ["c"], oldest: 26 },
      { type: "kubeletTooOldForTarget", nodes: ["b"], oldest: 28, target: 32 },
    ]);
  });

  it("checks control-plane components against kube-apiserver", () => {
    const c = (component: string, version: string, pod = `${component}-cp`) => ({ component, pod, node: "cp", version });
    const issues = skewIssues(30, 31, [], [
      c("kube-apiserver", "v1.30.1", "kube-apiserver-1"),
      c("kube-apiserver", "v1.28.0", "kube-apiserver-2"),
      c("kube-scheduler", "v1.29.0"),
      c("kube-controller-manager", "v1.26.0"),
      c("etcd", "3.5.9-0"),
    ]);
    expect(issues).toEqual([
      { type: "apiserverSkew", versions: ["v1.28.0", "v1.30.1"] },
      { type: "componentSkew", component: "kube-scheduler", pod: "kube-scheduler-cp", version: "v1.29.0", apiserver: 28 },
      { type: "componentSkew", component: "kube-controller-manager", pod: "kube-controller-manager-cp", version: "v1.26.0", apiserver: 28 },
    ]);
  });
});

describe("the report", () => {
  it("is Markdown with every section and CSV that a spreadsheet cannot run", () => {
    const t = i18n.t.bind(i18n);
    const findings = evaluate(scan, 24, 25);
    const md = markdownReport(t, {
      clusterVersion: "v1.24.6",
      target: 25,
      findings,
      served: servedFindings(scan, 25),
      skew: skewIssues(24, 25, [], []),
    });
    expect(md).toContain("# Upgrade readiness: v1.24.6 → 1.25");
    expect(md).toContain("| Removed | CronJob | shop | nightly | batch/v1beta1 | 1.21 | 1.25 | batch/v1 | Helm release shop/shop (revision 3), Written by field manager helm |");
    expect(md).toContain("- policy/v1beta1 PodDisruptionBudget: Removed in 1.25. Use instead: policy/v1");
    expect(md).toContain("No version skew problems found.");

    const evil = evaluate(
      scanOf({
        usages: [
          usage("batch/v1beta1", "CronJob", "x", "=cmd|calc", { type: "managedFields", manager: 'a,"b"' }),
          usage("batch/v1beta1", "CronJob", "x", "\tTAB", { type: "lastApplied" }),
        ],
      }),
      24,
      25,
    );
    const csv = csvReport(t, evil);
    expect(csv.split("\r\n")[0]).toBe("Status,Kind,Namespace,Name,API version,Deprecated in,Removed in,Use instead,Source");
    expect(csv).toContain(`'=cmd|calc`);
    expect(csv).toContain(`"Written by field manager a,""b"""`);
    expect(csv).toContain(`,'\tTAB,`);
  });
});
