// Which objects are judged, and what their running Pods add. A workload is judged by its pod template; a Pod,
// ReplicaSet or Job only when no judged controller holds its template (`judgedOnItsOwn`). Pod Security Admission judges
// the Pods themselves, though, and admission can change them (a webhook injecting `istio-init` with NET_ADMIN): the
// violations a live Pod has and its owner's template does not are reported on the owner, marked `admittedIn`. Pure.
import type { KubeObject } from "../../api";
import { controllerOf } from "../../resources/status";
import type { Judged } from "./namespaces";
import { admittedFindings, judgedOnItsOwn, type Finding } from "./pss";

export interface KindList {
  kind: string;
  items: Iterable<KubeObject>;
}

const keyOf = (kind: string, namespace: string | undefined, name: string) => `${kind}|${namespace ?? ""}|${name}`;

/**
 * The judged objects of `lists` (Pods, ReplicaSets and Jobs included, to follow ownership), each with its findings and
 * those its live Pods add. `findingsOf` evaluates one object (cached by the caller).
 */
export function judgeObjects(lists: readonly KindList[], findingsOf: (kind: string, obj: KubeObject) => Finding[]): Judged[] {
  const index = new Map<string, { kind: string; obj: KubeObject }>();
  const judged = new Map<string, Judged>();
  const pods: KubeObject[] = [];
  for (const { kind, items } of lists) {
    for (const obj of items) {
      const key = keyOf(kind, obj.metadata?.namespace, obj.metadata?.name ?? "");
      index.set(key, { kind, obj });
      if (kind === "Pod") pods.push(obj);
      if (judgedOnItsOwn(kind, controllerOf(obj)?.kind)) judged.set(key, { kind, obj, findings: findingsOf(kind, obj) });
    }
  }

  /** The judged object holding a Pod's template, following ReplicaSet → Deployment and Job → CronJob. */
  const ownerOf = (pod: KubeObject): Judged | undefined => {
    const namespace = pod.metadata?.namespace;
    let ref = controllerOf(pod);
    for (let hops = 0; ref && hops < 3; hops++) {
      const key = keyOf(ref.kind, namespace, ref.name);
      const found = judged.get(key);
      if (found) return found;
      const next = index.get(key);
      if (!next) return undefined;
      ref = controllerOf(next.obj);
    }
    return undefined;
  };

  const podsByOwner = new Map<Judged, { name: string; findings: Finding[] }[]>();
  for (const pod of pods) {
    if (pod.metadata?.deletionTimestamp || judgedOnItsOwn("Pod", controllerOf(pod)?.kind)) continue;
    const owner = ownerOf(pod);
    if (!owner) continue;
    const list = podsByOwner.get(owner) ?? [];
    list.push({ name: pod.metadata?.name ?? "", findings: findingsOf("Pod", pod) });
    podsByOwner.set(owner, list);
  }

  return [...judged.values()].map((j) => {
    const live = podsByOwner.get(j);
    if (!live) return j;
    const added = admittedFindings(j.findings, live);
    return added.length === 0 ? j : { ...j, findings: [...j.findings, ...added] };
  });
}
