// The text of Loki's lines in a logs tab, as the live lines are shown: the kubelet's timestamp in front with
// "Timestamps" on, the cut marker after a piece of a long line, and without the lines the live view already shows.
import { useMemo } from "react";
import type { LokiEntry } from "../../../api";
import type { IndexedLines } from "../search";
import { isoOfNs, liveKeys, withoutLive } from "./model";

/** Only the oldest live lines can repeat a Loki line (a read ends where the shown run began). */
export const DEDUPE_WINDOW = 2000;

const NO_LINES: IndexedLines = { length: 0, at: () => undefined };

/** The texts of `entries`, oldest first, without those `live` (read with timestamps) already shows. */
export function lokiTexts(entries: readonly LokiEntry[], live: IndexedLines, timestamps: boolean, cutMarker: string): string[] {
  let shown: readonly LokiEntry[] = entries;
  if (timestamps && entries.length > 0 && live.length > 0) {
    const oldest: string[] = [];
    for (let i = 0; i < Math.min(live.length, DEDUPE_WINDOW); i++) oldest.push(live.at(i) ?? "");
    shown = withoutLive(entries, liveKeys(oldest));
  }
  return shown.map((e) => {
    const text = timestamps ? `${isoOfNs(e.ts)} ${e.line}` : e.line;
    return e.cut ? `${text}${cutMarker}` : text;
  });
}

export function useLokiLines(entries: readonly LokiEntry[], live: IndexedLines, timestamps: boolean, cutMarker: string): string[] {
  // The live lines matter only while there is something to compare them with.
  const compared = entries.length > 0 && timestamps ? live : null;
  return useMemo(() => lokiTexts(entries, compared ?? NO_LINES, timestamps, cutMarker), [entries, compared, timestamps, cutMarker]);
}
