// The problems of the opt-in category `policies` (#213): an object that fails Kyverno policy rules, from the
// PolicyReports and ClusterPolicyReports (`detect` in src/features/problems/model.ts calls this). Opt-in because a
// failing policy result is a lasting state of an object, not an incident, and an Audit policy can fail on hundreds of
// objects at once: they would only add noise unless asked for. The problem is about the object the report names
// (`scope`); a report without one (an older aggregated report) is told about itself.
import type { KindRef, KubeObject } from "../../api";
import type { Detected } from "../problems/model";
import { REPORT_GROUP, reportResults, reportScope } from "./model";

export function policyProblems(kind: Pick<KindRef, "group" | "kind">, report: KubeObject): Detected[] {
  // reports.kyverno.io's ephemeral reports are Kyverno's intermediate results: they end up in these reports.
  if (kind.group !== REPORT_GROUP) return [];
  const results = reportResults(kind, report);
  const object = reportScope(kind, report);
  const found: Detected[] = [];
  const add = (result: "fail" | "error", reason: string, messageKey: string, notify: boolean) => {
    const matching = results.filter((r) => r.result === result);
    if (matching.length === 0) return;
    const times = matching.map((r) => r.time).filter((t): t is string => Boolean(t)).sort();
    found.push({
      reason,
      group: "policies",
      messageKey,
      messageParams: { count: matching.length },
      messageLists: { policies: [...new Set(matching.map((r) => r.policy))].sort() },
      since: times[0],
      notify,
      ...(object ? { object } : {}),
    });
  };
  add("fail", "PolicyViolation", "messages.policyFailures", true);
  // `error`: the rule could not be evaluated (a variable that does not resolve, an API call that fails). Kyverno counts
  // it as unsuccessful (`EngineResponse.IsSuccessful`, the CLI exits 1) but apart from a violation, and it is about the
  // policy rather than the object: listed on the screen, not notified.
  add("error", "PolicyError", "messages.policyErrors", false);
  return found;
}
