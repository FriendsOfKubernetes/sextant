// The problems of the Contour category (#233), for the problems screen, the counters and the notifications (`detect`
// in src/features/problems/model.ts calls these). Watched: HTTPProxies. An invalid proxy is a problem, named by the
// first error Contour reports (DuplicateVhost, IncludeNotFound, ServiceUnresolvedReference…); so is an orphaned one —
// a proxy without a virtual host that no root includes, which Contour ignores. A proxy Contour has not processed yet
// (NotReconciled) is not: no Contour may be meant to serve it.
import type { KindRef, KubeObject } from "../../api";
import type { Detected } from "../problems/model";
import { description, firstError, HTTP_PROXY, proxyState, sameKind, validCondition } from "./model";

/** A proxy and the include that names it are often applied a moment apart: a short state passes quietly. */
export const CONTOUR_GRACE_MS = 2 * 60_000;

export function contourProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!sameKind(kind, HTTP_PROXY)) return [];
  const state = proxyState(obj);
  if (state !== "invalid" && state !== "orphaned") return [];
  const error = firstError(obj);
  return [
    {
      reason: state === "orphaned" ? "Orphaned" : (error?.reason ?? "Invalid"),
      group: state,
      message: error?.message ?? description(obj),
      since: validCondition(obj)?.lastTransitionTime,
      graceMs: CONTOUR_GRACE_MS,
      notify: true,
    },
  ];
}
