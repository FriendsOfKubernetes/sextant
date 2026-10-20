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
  const failed = reportResults(kind, report).filter((r) => r.result === "fail");
  if (failed.length === 0) return [];
  const times = failed.map((r) => r.time).filter((t): t is string => Boolean(t)).sort();
  const object = reportScope(kind, report);
  return [
    {
      reason: "PolicyViolation",
      group: "policies",
      messageKey: "messages.policyFailures",
      messageParams: { count: failed.length },
      messageLists: { policies: [...new Set(failed.map((r) => r.policy))].sort() },
      since: times[0],
      notify: true,
      ...(object ? { object } : {}),
    },
  ];
}
