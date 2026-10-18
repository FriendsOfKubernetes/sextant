// A namespace's Pod Security Admission labels (`pod-security.kubernetes.io/<mode>` and `<mode>-version`) and how the
// workloads in it compare: which of them each mode's level would reject (enforce), record (audit) or warn about
// (warn), read at the mode's pinned version. Pure.
import type { KubeObject } from "../../api";
import { evaluateObject, meets, minorOf, type Finding, type Posture } from "./pss";

export const PSA_MODES = ["enforce", "audit", "warn"] as const;
export type PsaMode = (typeof PSA_MODES)[number];
const LEVELS = new Set<Posture>(["privileged", "baseline", "restricted"]);
export const PSA_PREFIX = "pod-security.kubernetes.io/";

export interface ModeLabel {
  mode: PsaMode;
  /** The level the label names; an unknown value is left as `undefined` (`raw` holds it). */
  level: Posture | undefined;
  raw: string;
  /** `v1.N` or `latest` (the default). */
  version: string;
}

/** The PSA labels a namespace sets, in `PSA_MODES` order; `[]` without any. */
export function psaLabels(ns: KubeObject | undefined): ModeLabel[] {
  const labels = (ns?.metadata?.labels ?? {}) as Record<string, string>;
  const out: ModeLabel[] = [];
  for (const mode of PSA_MODES) {
    const raw = labels[`${PSA_PREFIX}${mode}`];
    if (raw === undefined) continue;
    out.push({
      mode,
      level: LEVELS.has(raw as Posture) ? (raw as Posture) : undefined,
      raw,
      version: labels[`${PSA_PREFIX}${mode}-version`] ?? "latest",
    });
  }
  return out;
}

/** One judged object: its kind and name, and its findings at the latest version. */
export interface Judged {
  kind: string;
  obj: KubeObject;
  findings: Finding[];
}

/** Whether the object meets `level` read at `version` (re-evaluated only when a version is pinned). */
export function meetsAt(judged: Judged, level: Posture, version: string): boolean {
  const minor = minorOf(version);
  // A pinned version re-reads the template; what live Pods added at admission still counts.
  const findings =
    minor === undefined
      ? judged.findings
      : [...evaluateObject(judged.kind, judged.obj, minor), ...judged.findings.filter((f) => f.admittedIn)];
  return meets(findings, level);
}

export interface ModeComparison {
  label: ModeLabel;
  /** The objects that do not meet the mode's level. */
  failing: Judged[];
}

/** For each PSA label of the namespace, the objects its level would reject, record or warn about. */
export function compareModes(labels: readonly ModeLabel[], judged: readonly Judged[]): ModeComparison[] {
  return labels.map((label) => ({
    label,
    failing: label.level ? judged.filter((j) => !meetsAt(j, label.level!, label.version)) : [],
  }));
}
