// The ceph commands of the manifest (`contributes.commands`, sextantApi 3, ADR-0147, ADR-0150): each runs by its id in
// Rook's toolbox (`app=rook-ceph-tools`, container `rook-ceph-tools`) of a CephCluster's namespace, with only the values
// of its typed parameters; the words are the manifest's, agreed to at install. A command that changes something
// (`changes: true`) is confirmed by Sextant every time it runs, with the words filled in.
import { isSextantError, type ExecResult, type Sextant } from "@sextant/extension-sdk";

/** The commands that only read, in the order the "Ceph commands" tab offers them. */
export const READ_COMMANDS = ["status", "health-detail", "osd-tree", "osd-df", "df", "pg-stat", "versions", "crash-ls-new"] as const;
export type ReadCommand = (typeof READ_COMMANDS)[number];

/** The cluster-wide OSD flags the tab sets and unsets (the `flag` values of `osd-set`/`osd-unset`). */
export const FLAGS = ["noout", "norebalance", "nobackfill", "norecover", "noscrub", "nodeep-scrub"] as const;
export type Flag = (typeof FLAGS)[number];

/** The weights `osd-reweight` takes, as Ceph reads them (1 is a full share). */
export const WEIGHTS = ["1.0", "0.95", "0.9", "0.85", "0.8", "0.75", "0.7", "0.6", "0.5", "0.4", "0.3", "0.2", "0.1"] as const;

export type CommandId =
  | ReadCommand
  | "osd-dump"
  | "osd-ok-to-stop"
  | "osd-safe-to-destroy"
  | "osd-out"
  | "osd-in"
  | "osd-reweight"
  | "osd-set"
  | "osd-unset"
  | "crash-archive-all";

/** What a run gave: the result, or the toolbox is not there (no ready pod with its labels), or a refusal. */
export type Outcome = { kind: "ran"; result: ExecResult } | { kind: "noToolbox" } | { kind: "failed"; error: unknown };

/** Runs one command of the manifest in the toolbox of `namespace`. */
export async function run(sextant: Sextant, namespace: string, id: CommandId, params?: Record<string, string>): Promise<Outcome> {
  try {
    return { kind: "ran", result: await sextant.exec.run({ id, namespace, ...(params ? { params } : {}) }) };
  } catch (error) {
    if (isSextantError(error, "notFound")) return { kind: "noToolbox" };
    return { kind: "failed", error };
  }
}

/** Ceph answered 0: the command did what it says (for the checks below: it is safe). */
export const succeeded = (result: ExecResult): boolean => result.exitCode === 0 && !result.timedOut;

/** What the run printed: stdout, then stderr (Ceph writes some answers there), trimmed. */
export function outputOf(result: ExecResult): string {
  return [result.stdout, result.stderr].map((s) => s.trimEnd()).filter((s) => s !== "").join("\n");
}

/**
 * The flags of the OSD map from `ceph osd dump --format json` (its `flags`, a comma-separated text, or the newer
 * `flags_set` list); `null` when the answer cannot be read (cut, or not JSON).
 */
export function flagsOf(result: ExecResult): Set<string> | null {
  if (!succeeded(result) || result.truncated) return null;
  try {
    const dump = JSON.parse(result.stdout) as { flags?: unknown; flags_set?: unknown };
    if (Array.isArray(dump.flags_set)) return new Set(dump.flags_set.filter((f): f is string => typeof f === "string"));
    if (typeof dump.flags === "string") return new Set(dump.flags.split(",").map((f) => f.trim()).filter((f) => f !== ""));
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether Ceph says an OSD may be stopped (`ok-to-stop`) or destroyed (`safe-to-destroy`): `true` on exit 0, `false`
 * when Ceph answered otherwise, `null` when it cannot be told (no toolbox, a refusal, a timeout).
 */
export function verdictOf(outcome: Outcome): boolean | null {
  if (outcome.kind !== "ran" || outcome.result.timedOut || outcome.result.exitCode === null) return null;
  return outcome.result.exitCode === 0;
}
