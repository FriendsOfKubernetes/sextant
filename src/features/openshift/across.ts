// Failed Builds judged across the Builds of their BuildConfig: a failure a later build of the same BuildConfig
// followed (a retry started by hand, a new commit, a new base image) no longer says anything about it — that later
// build does. Only the latest failed build of a BuildConfig stays a problem (a build of no BuildConfig always stays).
// The rows are the problems store's tap of its Build watch (`SourceDef.across`), so nothing more is watched.
import type { KubeObject } from "../../api";
import type { Problem } from "../problems/model";
import type { AcrossDef } from "../problems/sources";
import { buildConfigOf, buildNumber } from "./model";

/** Rows the tap keeps at most (the source's own cap). */
export const MAX_BUILD_ROWS = 5000;

export interface BuildRow {
  namespace: string;
  config?: string;
  number?: number;
}

export const buildRow = (obj: KubeObject): BuildRow => ({
  namespace: obj.metadata?.namespace ?? "",
  config: buildConfigOf(obj),
  number: buildNumber(obj),
});

/** The problems less the failed builds a later build of the same BuildConfig followed. */
export function latestFailuresOnly(problems: readonly Problem[], rows: ReadonlyMap<string, BuildRow>): Problem[] {
  if (problems.length === 0) return [];
  const latest = new Map<string, number>();
  for (const row of rows.values()) {
    if (!row.config || row.number === undefined) continue;
    const key = `${row.namespace}/${row.config}`;
    latest.set(key, Math.max(latest.get(key) ?? -Infinity, row.number));
  }
  return problems.filter((p) => {
    const row = rows.get(p.uid);
    if (!row?.config || row.number === undefined) return true;
    return (latest.get(`${row.namespace}/${row.config}`) ?? row.number) <= row.number;
  });
}

export const BUILD_ACROSS: AcrossDef = {
  tap: { id: "openshift:builds", toRow: buildRow, max: MAX_BUILD_ROWS },
  keep: (problems, rows) => latestFailuresOnly(problems, rows as ReadonlyMap<string, BuildRow>),
};
