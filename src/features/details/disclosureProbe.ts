import { useCallback, useEffect, useState } from "react";
import { useDetailsDisclosure } from "../../layout/details/disclosure";
import { isCapped, type WatchState } from "../../api";

export type DisclosureProbeResult = "present" | "absent" | "unknown";
/** An unreadable/incomplete source without a concrete transport error still cannot establish absence. */
export const UNKNOWN_DETAILS_SOURCE = { code: "other" } as const;

/** A closed conditional section may check once. Keep its answer when disabling clears the source's snapshot. */
export function useDisclosureProbe(id: string, active?: boolean) {
  const disclosure = useDetailsDisclosure(id);
  const open = disclosure?.open ?? true;
  const ready = disclosure?.ready ?? true;
  const [result, setResult] = useState<DisclosureProbeResult | null>(null);
  const settle = useCallback((next: DisclosureProbeResult) => setResult(next), []);
  return { open, enabled: ready && ((active ?? open) || result === null), result, settle };
}

/** A settled header survives disabled/cleared snapshots and a fresh response still loading on reopen. */
export function useDisclosureProbeResult(probe: ReturnType<typeof useDisclosureProbe>, answer: DisclosureProbeResult | null) {
  const { enabled, result: previous, settle } = probe;
  useEffect(() => { if (enabled && answer) settle(answer); }, [enabled, answer, settle]);
  const result = enabled || previous === null ? answer ?? previous : previous;
  return { result, visible: result === "present" || result === "unknown" };
}

/** An incomplete/forbidden/capped list cannot prove absence. Undefined means a required list has not started. */
export function watchProbeResult(found: boolean, states: readonly (WatchState | undefined)[]): DisclosureProbeResult | null {
  if (found) return "present";
  if (states.some(state => state && (state.status !== "loading" && state.status !== "ready" || (state.forbidden?.length ?? 0) > 0 || isCapped(state)))) return "unknown";
  if (states.some(state => !state || state.status === "loading")) return null;
  return "absent";
}
