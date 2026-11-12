// The problem judges of the extension's backend (ADR-0168, #341): Sextant sends the objects each judge reads, with the
// declared fields only, and turns the facts answered here into the manifest's rules' problems. `traffic` tells where a
// canary's traffic really goes (./traffic.ts) and `safety` how its checks are set up (./safety.ts); both are the same
// code the agent tool runs. An object of a `partial` read that was not read in a namespace is "cannot tell", never "not
// there". Pure.
import type { KubeObject } from "@sextant/extension-sdk";
import { ROLLOUT, SERVICE, ANALYSIS_TEMPLATE, CLUSTER_ANALYSIS_TEMPLATE } from "./model";
import { rolloutFindings, templateFindings } from "./safety";
import { trafficFindings, type Found, type TrafficCode } from "./traffic";
import { DESTINATION_RULE, VIRTUAL_SERVICE } from "./diagnose";

/** An object as a judge gets it (the SDK's backend `JudgedObject`; declared here so the frame's code needs no backend). */
export interface JudgedObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; uid: string; creationTimestamp?: string };
  values: Record<string, unknown>;
}

/** What the finding rests on: one object (`name`), a namespace's objects of `kind`, or (neither) every namespace's. */
export interface JudgedNeed {
  kind: Kind;
  namespace?: string;
  name?: string;
}

export interface JudgedFact {
  uid: string;
  fact: string;
  values?: Record<string, string>;
  needs?: JudgedNeed[];
}

export const JUDGE_IDS = ["traffic", "safety"] as const;
export type JudgeId = (typeof JUDGE_IDS)[number];

type Kind = { group: string; kind: string };
export type IsRead = (kind: Kind, namespace: string | null) => boolean;

/** The facts of the traffic judge: the problems of ./traffic.ts (its warnings and "normal" are the agent tool's only). */
export const TRAFFIC_FACTS: readonly TrafficCode[] = [
  "virtual-service-missing",
  "route-missing",
  "route-not-chosen",
  "route-without-canary",
  "route-without-stable",
  "destination-rule-missing",
  "subset-missing",
  "same-hash",
];

/** The object a judged one stands for: its metadata and each declared path's value put back where it was read. */
export function rebuild(o: JudgedObject): KubeObject {
  const out: Record<string, unknown> = { apiVersion: o.apiVersion, kind: o.kind, metadata: { ...o.metadata } };
  for (const [path, value] of Object.entries(o.values ?? {})) {
    const steps = path.split(".").filter(Boolean);
    let at = out;
    steps.forEach((step, i) => {
      if (i === steps.length - 1) at[step] = value;
      else at = (at[step] ??= {}) as Record<string, unknown>;
    });
  }
  return out as unknown as KubeObject;
}

const groupOf = (apiVersion: string): string => (apiVersion.includes("/") ? apiVersion.split("/")[0]! : "");
const same = (o: JudgedObject, kind: Kind) => o.kind === kind.kind && groupOf(o.apiVersion) === kind.group;

export function judge(id: JudgeId, objects: JudgedObject[], isRead: IsRead): JudgedFact[] {
  return id === "traffic" ? judgeTraffic(objects, isRead) : judgeSafety(objects);
}

function judgeTraffic(objects: JudgedObject[], isRead: IsRead): JudgedFact[] {
  const index = new Map<string, KubeObject>();
  const key = (kind: Kind, namespace: string, name: string) => `${kind.group}/${kind.kind}/${namespace}/${name}`;
  for (const o of objects) {
    for (const kind of [VIRTUAL_SERVICE, DESTINATION_RULE, SERVICE]) {
      if (same(o, kind)) index.set(key(kind, o.metadata.namespace ?? "", o.metadata.name), rebuild(o));
    }
  }
  const find = (kind: Kind, namespace: string, name: string): Found =>
    index.get(key(kind, namespace, name)) ?? (isRead(kind, namespace) ? null : undefined);
  const facts: JudgedFact[] = [];
  for (const o of objects) {
    if (!same(o, ROLLOUT)) continue;
    const ro = rebuild(o);
    const ns = o.metadata.namespace ?? "";
    const findings = trafficFindings(ro, {
      virtualService: (namespace, name) => find(VIRTUAL_SERVICE, namespace, name),
      destinationRule: (namespace, name) => find(DESTINATION_RULE, namespace, name),
      service: (namespace, name) => find(SERVICE, namespace, name),
    });
    for (const f of findings) {
      if (f.level !== "problem" || !TRAFFIC_FACTS.includes(f.code)) continue;
      facts.push({ uid: o.metadata.uid, fact: f.code, values: f.values, needs: needsOf(f.code, f.values, ns) });
    }
  }
  return facts;
}

/** What a traffic fact rests on, so that an agent that may read it (and only then) is told. */
function needsOf(code: TrafficCode, v: Record<string, string>, namespace: string): JudgedNeed[] | undefined {
  const named = (kind: Kind, ns: string, name: string | undefined): JudgedNeed => (name ? { kind, namespace: ns, name } : { kind, namespace: ns });
  switch (code) {
    case "virtual-service-missing":
      return [named(VIRTUAL_SERVICE, v.namespace ?? namespace, v.name)];
    case "route-missing":
    case "route-not-chosen":
    case "route-without-canary":
    case "route-without-stable":
      // The VirtualService is the one the finding names; its namespace is the Rollout's or the one its reference gives.
      return [{ kind: VIRTUAL_SERVICE }];
    case "destination-rule-missing":
      return [named(DESTINATION_RULE, namespace, v.name)];
    case "subset-missing":
      return [named(DESTINATION_RULE, namespace, v.destinationRule)];
    case "same-hash":
      return v.via === "subsets" ? [{ kind: DESTINATION_RULE, namespace }] : [{ kind: SERVICE, namespace }];
    default:
      return undefined;
  }
}

function judgeSafety(objects: JudgedObject[]): JudgedFact[] {
  const facts: JudgedFact[] = [];
  for (const o of objects) {
    const obj = rebuild(o) as unknown as Record<string, unknown>;
    const found = same(o, ROLLOUT)
      ? rolloutFindings(obj.spec)
      : same(o, ANALYSIS_TEMPLATE) || same(o, CLUSTER_ANALYSIS_TEMPLATE)
        ? templateFindings(obj.spec)
        : [];
    for (const f of found) facts.push({ uid: o.metadata.uid, fact: f.code, values: f.values });
  }
  return facts;
}
