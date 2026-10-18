// Version skew checks for an upgrade (#142), per the Kubernetes version skew policy
// (https://kubernetes.io/releases/version-skew-policy/):
//   - the control plane moves one minor version at a time;
//   - kube-apiserver instances of an HA control plane are at most one minor apart;
//   - a kubelet is never newer than kube-apiserver and at most three minors older (a kubelet before 1.25: two);
//   - kube-proxy likewise against kube-apiserver, and at most three minors older or newer than the kubelet beside it
//     (a kube-proxy before 1.25: two); nodes that do not report it (the field is deprecated) are not checked;
//   - kube-controller-manager, kube-scheduler and cloud-controller-manager are never newer than kube-apiserver and at
//     most one minor older.
// Control-plane components are visible only as kubeadm-style static pods; a managed control plane shows none, and
// then only the node rules can be checked.
import type { ComponentVersion, NodeVersion } from "../../api";
import { parseMinor, type Minor } from "./table";

export type SkewIssue =
  /** The target is more than one minor ahead: the control plane has to go through each release in between. */
  | { type: "stepwise"; from: Minor; to: Minor; steps: Minor[] }
  /** Kubelets (kube-proxies) newer than kube-apiserver now. */
  | { type: "kubeletNewer" | "kubeProxyNewer"; nodes: string[]; apiserver: Minor }
  /** Kubelets (kube-proxies) further behind kube-apiserver than allowed now. */
  | { type: "kubeletTooOld" | "kubeProxyTooOld"; nodes: string[]; oldest: Minor }
  /** Kubelets (kube-proxies) that will be too old once the control plane reaches the target: upgrade them first. */
  | { type: "kubeletTooOldForTarget" | "kubeProxyTooOldForTarget"; nodes: string[]; oldest: Minor; target: Minor }
  /** kube-proxy further from the kubelet on the same node than allowed. */
  | { type: "kubeProxyKubeletSkew"; nodes: string[] }
  /** kube-apiserver instances more than one minor apart. */
  | { type: "apiserverSkew"; versions: string[] }
  /** A controller-manager or scheduler newer than kube-apiserver or more than one minor behind. */
  | { type: "componentSkew"; component: string; pod: string; version: string; apiserver: Minor };

/** How many minors a kubelet or kube-proxy of version `minor` may be behind kube-apiserver: three, two before 1.25. */
export function nodeSkew(minor: Minor): number {
  return minor >= 25 ? 3 : 2;
}

interface NodeMinor {
  name: string;
  minor: Minor;
}

/** The rules a kubelet or a kube-proxy follows against kube-apiserver, now and at the target. */
function agentIssues(agent: "kubelet" | "kubeProxy", agents: NodeMinor[], current: Minor | null, target: Minor): SkewIssue[] {
  const issues: SkewIssue[] = [];
  const names = (list: NodeMinor[]) => list.map((n) => n.name);
  const oldest = (list: NodeMinor[]) => Math.min(...list.map((n) => n.minor));
  const tooOldAt = (n: NodeMinor, apiserver: Minor) => apiserver - n.minor > nodeSkew(n.minor);
  if (current !== null) {
    const newer = agents.filter((n) => n.minor > current);
    if (newer.length > 0) issues.push({ type: `${agent}Newer`, nodes: names(newer), apiserver: current });
    const tooOld = agents.filter((n) => tooOldAt(n, current));
    if (tooOld.length > 0) issues.push({ type: `${agent}TooOld`, nodes: names(tooOld), oldest: oldest(tooOld) });
  }
  if (current === null || target > current) {
    const behind = agents.filter((n) => tooOldAt(n, target) && (current === null || !tooOldAt(n, current)));
    if (behind.length > 0) {
      issues.push({ type: `${agent}TooOldForTarget`, nodes: names(behind), oldest: oldest(behind), target });
    }
  }
  return issues;
}

const SKEWED_COMPONENTS = new Set(["kube-controller-manager", "kube-scheduler", "cloud-controller-manager"]);

export function skewIssues(
  current: Minor | null,
  target: Minor,
  nodes: readonly NodeVersion[],
  components: readonly ComponentVersion[],
): SkewIssue[] {
  const issues: SkewIssue[] = [];
  if (current !== null && target - current > 1) {
    const steps: Minor[] = [];
    for (let m = current + 1; m <= target; m++) steps.push(m);
    issues.push({ type: "stepwise", from: current, to: target, steps });
  }

  const minorOf = (name: string, version: string): NodeMinor | null => {
    const minor = parseMinor(version);
    return minor === null ? null : { name, minor };
  };
  const kubelets = nodes.map((n) => minorOf(n.name, n.kubeletVersion)).filter((n): n is NodeMinor => n !== null);
  const proxies = nodes.map((n) => minorOf(n.name, n.kubeProxyVersion)).filter((n): n is NodeMinor => n !== null);
  issues.push(...agentIssues("kubelet", kubelets, current, target), ...agentIssues("kubeProxy", proxies, current, target));
  const kubeletOf = new Map(kubelets.map((n) => [n.name, n.minor]));
  const apart = proxies.filter((p) => {
    const kubelet = kubeletOf.get(p.name);
    return kubelet !== undefined && Math.abs(p.minor - kubelet) > nodeSkew(p.minor);
  });
  if (apart.length > 0) issues.push({ type: "kubeProxyKubeletSkew", nodes: apart.map((n) => n.name) });

  const apiservers = components.filter((c) => c.component === "kube-apiserver");
  const apiMinors = apiservers.map((c) => parseMinor(c.version)).filter((m): m is Minor => m !== null);
  if (apiMinors.length > 1 && Math.max(...apiMinors) - Math.min(...apiMinors) > 1) {
    issues.push({ type: "apiserverSkew", versions: [...new Set(apiservers.map((c) => c.version))].sort() });
  }
  const apiserver = apiMinors.length > 0 ? Math.min(...apiMinors) : current;
  if (apiserver !== null) {
    for (const c of components) {
      if (!SKEWED_COMPONENTS.has(c.component)) continue;
      const minor = parseMinor(c.version);
      if (minor === null) continue;
      if (minor > apiserver || minor < apiserver - 1) {
        issues.push({ type: "componentSkew", component: c.component, pod: c.pod, version: c.version, apiserver });
      }
    }
  }
  return issues;
}

/** Kubelet versions and how many nodes run each, newest first. */
export function kubeletVersions(nodes: readonly NodeVersion[]): { version: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const v = n.kubeletVersion || "";
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
}
