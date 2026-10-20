// How the diagnosis view says things: phrases (with nested phrases and lists) as translated text, and the connectivity
// engine's deciding rules in the connectivity view's own words.
import { formatList } from "../../i18n";
import type { SideResult } from "../netpol/engine";
import { matchText, policyName, unknownText, type T } from "../netpol/text";
import type { Param, Phrase, Status } from "./model";

function paramText(t: T, value: Param): string | number {
  if (typeof value === "string" || typeof value === "number") return value;
  if (Array.isArray(value)) return formatList(value as readonly string[]);
  return phraseText(t, value as Phrase);
}

export function phraseText(t: T, p: Phrase): string {
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.params ?? {})) params[k] = paramText(t, v);
  return t(p.key, params);
}

export const statusText = (t: T, status: Status) => t(`diagnose:status.${status}`);

export const STATUS_TONE = { ok: "success", warn: "warning", broken: "danger", unknown: "neutral" } as const;

/** The rules that decided, and what kept the answer open, one line each without repeats. */
export function policyLines(t: T, sides: readonly SideResult[]): string[] {
  const lines = new Set<string>();
  for (const side of sides) {
    for (const m of side.deniedBy) lines.add(t("diagnose:policies.deniedBy", { policy: policyName(m.policy), rule: matchText(t, m.rule, m.peer, m.port) }));
    for (const m of side.allowedBy) lines.add(t("diagnose:policies.allowedBy", { policy: policyName(m.policy), rule: matchText(t, m.rule, m.peer, m.port) }));
    if (side.why === "noRuleMatches") {
      const names = [...new Set(side.policies.filter((p) => p.policy.isolates.ingress && p.selected !== "no").map((p) => policyName(p.policy.ref)))];
      if (names.length > 0) lines.add(t("diagnose:policies.isolatedBy", { policies: formatList(names) }));
    }
    for (const u of side.unknown) lines.add(unknownText(t, u));
  }
  return [...lines];
}
