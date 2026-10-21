// How the coverage views say things (keys under `netpol:coverage`), built outside JSX.
import type { Tone } from "../../resources/status";
import type { CoverageCause, CoverageLevel, DirectionCoverage, DirectionSummary } from "./coverage";
import type { Tri } from "./model";
import { flavorText, policyName, triMark, unevaluatedText, unknownText, unreadableText, type T } from "./text";

export const LEVEL_TONE: Record<CoverageLevel, Tone> = {
  all: "success",
  some: "warning",
  none: "neutral",
  unknown: "warning",
  noPods: "muted",
};

/** "Some (2 of 5)", "All (3 of 3)", "Cannot tell", "No pods". */
export function levelText(t: T, s: DirectionSummary): string {
  const word = t(`netpol:coverage.level.${s.level}`);
  if (s.level === "unknown" || s.level === "noPods") return word;
  return t("netpol:coverage.levelCount", { level: word, isolated: s.isolated, total: s.isolated + s.notIsolated + s.unknown });
}

/** "Isolated", "Not isolated", "Host network: not subject", "Host network: cannot tell", "Cannot tell". */
export function stateText(t: T, c: DirectionCoverage): string {
  if (c.hostNetwork) return t(`netpol:coverage.state.${c.state === "unknown" ? "hostNetworkUnknown" : "hostNetwork"}`);
  return t(`netpol:coverage.state.${c.state}`);
}

/** "Ingress: Yes · Egress: Cannot tell" — the namespace's default deny per direction. */
export function defaultDenyText(t: T, ingress: Tri, egress: Tri): string {
  return t("netpol:coverage.directions", { ingress: triMark(t, ingress), egress: triMark(t, egress) });
}

export function causeText(t: T, c: CoverageCause): string {
  switch (c.type) {
    case "unreadable":
      return unreadableText(t, c);
    case "unevaluated":
      return unevaluatedText(t, c);
    case "maybeSelected":
      return t("netpol:coverage.maybeSelected", { flavor: flavorText(t, c.policy), policy: policyName(c.policy) });
    case "unmodelledPolicy":
      return unknownText(t, c);
    case "hostPolicy":
      return t("netpol:coverage.hostPolicy", { kind: c.kind, name: c.name });
  }
}

/** The causes of several pods, each said once. */
export function causeTexts(t: T, causes: readonly CoverageCause[]): string[] {
  return [...new Set(causes.map((c) => causeText(t, c)))];
}
