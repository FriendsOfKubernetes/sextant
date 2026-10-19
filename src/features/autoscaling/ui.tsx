// Small pieces the autoscaling sections share: a phrase in its tone, a table of events, and the reasons of a
// scheduler (or Cluster Autoscaler) message. Texts are under `autoscaling:`; values are built outside JSX.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Age } from "../../components";
import { table, type ColumnWrap } from "../details";
import { newestEvents, type EventRow, type Phrase } from "./model";
import type { MessageReason } from "./scheduling";

/** Where the column widths of this file's tables are saved (`table` of `details/ui`). */
const TABLE_IDS = {
  autoscalingReasons: "autoscaling.reasons",
  eventsWithCause: "autoscaling.eventsWithCause",
  events: "autoscaling.events",
};

const EVENT_WRAP: readonly ColumnWrap[] = ["nowrap", undefined, "nowrap"];
const FIRST_WRAP: readonly ColumnWrap[] = ["nowrap"];
const REASON_WRAP: readonly ColumnWrap[] = ["nowrap", undefined];

/** Events listed per table at most (the newest). */
export const MAX_EVENTS = 10;

export function PhraseLine({ phrase }: { phrase: Phrase }) {
  const { t } = useTranslation();
  return <p className={`as-phrase as-phrase--${phrase.tone ?? "neutral"}`}>{t(`autoscaling:${phrase.key}`, phrase.params ?? {})}</p>;
}

export function Phrases({ phrases }: { phrases: readonly Phrase[] }) {
  if (phrases.length === 0) return null;
  return (
    <>
      {phrases.map((p, i) => (
        <PhraseLine key={`${p.key}:${i}`} phrase={p} />
      ))}
    </>
  );
}

/** A muted note under a block. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="as-note">{children}</p>;
}

/** The newest `MAX_EVENTS` of `events` as a table; `first` adds a leading column (the object, a cause). */
export function EventsTable({ events, first }: { events: readonly EventRow[]; first?: { header: string; cell: (e: EventRow) => ReactNode } }) {
  const { t } = useTranslation();
  const rows = newestEvents(events, MAX_EVENTS);
  if (rows.length === 0) return null;
  const headers = [
    ...(first ? [first.header] : []),
    t("autoscaling:events.reason"),
    t("autoscaling:events.message"),
    t("autoscaling:events.age"),
  ];
  return (
    <>
      {table(
        (first ? TABLE_IDS.eventsWithCause : TABLE_IDS.events),
        headers,
        rows.map((e) => [
          ...(first ? [first.cell(e)] : []),
          <span className={e.type === "Warning" ? "as-warning" : undefined}>{e.reason}</span>,
          e.message,
          <Age timestamp={e.time} />,
        ]),
        [...(first ? FIRST_WRAP : []), ...EVENT_WRAP],
      )}
    </>
  );
}

/** One reason of a scheduler or Cluster Autoscaler message in plain words (unknown ones as the cluster wrote them). */
export function useReasonText(): (r: MessageReason) => string {
  const { t } = useTranslation();
  return (r) => {
    if (r.code === "other") return r.text;
    if (r.code === "insufficient") return t("autoscaling:reason.insufficient", { resource: r.detail ?? "" });
    if (r.code === "taint" && r.detail !== undefined) return t("autoscaling:reason.taintNamed", { taint: r.detail });
    return t(`autoscaling:reason.${r.code}`);
  };
}

/** The reasons of a message with their node counts. */
export function ReasonsTable({ reasons, countHeader }: { reasons: readonly MessageReason[]; countHeader: string }) {
  const { t } = useTranslation();
  const text = useReasonText();
  if (reasons.length === 0) return null;
  return (
    <>
      {table(
        TABLE_IDS.autoscalingReasons,
        [countHeader, t("autoscaling:sched.reason")],
        reasons.map((r) => [r.count === undefined ? "" : String(r.count), <span title={r.text}>{text(r)}</span>]),
        REASON_WRAP,
      )}
    </>
  );
}
