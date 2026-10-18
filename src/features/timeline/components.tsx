// Change timeline (#145): the list both the page and the "Changes" tab draw — one row per recorded change or entry of
// the partial history: when, what, who, the fields that changed and what went wrong soon after.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FieldManager, HistoryEntry, KindRef, ObjectRef } from "../../api";
import { useAppStore } from "../../app/store";
import { Badge, Icon } from "../../components";
import { formatDateTime, formatList } from "../../i18n/format";
import type { Correlation } from "./correlate";
import type { TimelineItem } from "./items";
import { friendlyManager, SEXTANT_MANAGER, type FieldChange, type Who } from "./model";
import type { ChangeEntry } from "./recorder";

type T = ReturnType<typeof useTranslation>["t"];

/** Rows a list shows before "Show more". */
export const SHOWN = 100;
/** Changed fields a row shows before "Show all changes". */
const FIELDS_SHOWN = 3;

/** A field manager as shown: the name people know, Sextant's own in the UI language, else the raw name. */
export function managerName(manager: string, t: T): string {
  if (manager === SEXTANT_MANAGER) return t("timeline:who.sextant");
  return friendlyManager(manager) ?? manager;
}

/** The "who" of a recorded change, as a whole line. */
function whoText(who: Who | null | undefined, t: T): string {
  if (who === undefined) return t("timeline:who.pending");
  if (who === null || who.managers.length === 0) return t("timeline:who.unknown");
  const names = formatList([...new Set(who.managers.map((m: FieldManager) => managerName(m.manager, t)))]);
  return who.exact ? t("timeline:who.by", { who: names }) : t("timeline:who.likely", { who: names });
}

export function changeText(change: FieldChange, t: T): string {
  const { path } = change;
  if (change.op === "removed") return t("timeline:change.removed", { path });
  if (change.op === "added") {
    return change.after === undefined ? t("timeline:change.addedHidden", { path }) : t("timeline:change.added", { path, value: change.after });
  }
  if (change.long) return t("timeline:change.changedLong", { path });
  if (change.before === undefined || change.after === undefined) return t("timeline:change.changedHidden", { path });
  return t("timeline:change.changed", { path, before: change.before, after: change.after });
}

export function correlationText(c: Correlation, t: T): string {
  const values = { reason: c.signal.reason, kind: c.signal.object.kind.kind, name: c.signal.object.name };
  const minutes = Math.round(c.delayMs / 60_000);
  if (minutes < 1) return t("timeline:correlation.sameTime", values);
  return t("timeline:correlation.after", { ...values, count: minutes });
}

function partialText(entry: HistoryEntry, t: T): string {
  switch (entry.source) {
    case "fieldManager":
      return t("timeline:source.fieldManager");
    case "revision":
      return entry.changeCause
        ? t("timeline:source.revisionCause", { revision: entry.revision ?? 0, cause: entry.changeCause })
        : t("timeline:source.revision", { revision: entry.revision ?? 0 });
    case "helmRevision":
      return entry.status
        ? t("timeline:source.helmStatus", { name: entry.object.name, revision: entry.revision ?? 0, status: entry.status })
        : t("timeline:source.helm", { name: entry.object.name, revision: entry.revision ?? 0 });
  }
}

function ObjectLink({ kind, namespace, name, t }: { kind: KindRef; namespace: string | null; name: string; t: T }) {
  const openDetails = useAppStore((s) => s.openDetails);
  const text = namespace ? t("timeline:objectInNamespace", { kind: kind.kind, namespace, name }) : t("timeline:object", { kind: kind.kind, name });
  // A Helm release is not a Kubernetes object: no details to open.
  if (kind.group === "helm.sh") return <span className="tl-row__object">{text}</span>;
  const ref: ObjectRef = { kind, namespace, name };
  return (
    <button type="button" className="rt-link tl-row__object" onClick={() => openDetails(ref)}>
      {text}
    </button>
  );
}

function Changes({ entry, t }: { entry: ChangeEntry; t: T }) {
  const [all, setAll] = useState(false);
  if (entry.summaryOnly) return <p className="tl-row__note">{t("timeline:change.summaryOnly")}</p>;
  if (entry.changes.length === 0) return null;
  const shown = all ? entry.changes : entry.changes.slice(0, FIELDS_SHOWN);
  const hidden = entry.changes.length - shown.length;
  return (
    <div className="tl-row__changes">
      <ul className="tl-fields">
        {shown.map((c, i) => (
          <li key={`${c.path}|${i}`} className={`tl-fields__item tl-fields__item--${c.op}`}>
            {changeText(c, t)}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" className="rt-link tl-row__toggle" onClick={() => setAll(true)}>
          {t("timeline:change.showAll", { count: entry.changes.length })}
        </button>
      )}
      {hidden === 0 && entry.more > 0 && <p className="tl-row__note">{t("timeline:change.more", { count: entry.more })}</p>}
      {all && entry.changes.length > FIELDS_SHOWN && (
        <button type="button" className="rt-link tl-row__toggle" onClick={() => setAll(false)}>
          {t("timeline:change.showLess")}
        </button>
      )}
    </div>
  );
}

function Correlations({ items, t }: { items: readonly Correlation[]; t: T }) {
  if (items.length === 0) return null;
  return (
    <ul className="tl-after" aria-label={t("timeline:correlation.label")}>
      {items.map((c) => (
        <li key={`${c.signal.object.kind.kind}|${c.signal.object.namespace ?? ""}|${c.signal.object.name}|${c.signal.reason}`} className={`tl-after__item tl-after__item--${c.signal.type}`}>
          <Icon name="warning" />
          <span>{correlationText(c, t)}</span>
        </li>
      ))}
    </ul>
  );
}

function Row({ item, showObject }: { item: TimelineItem; showObject: boolean }) {
  const { t } = useTranslation();
  const when = formatDateTime(item.at);
  if (item.type === "recorded") {
    const e = item.entry;
    return (
      <li className="tl-row" data-action={e.action}>
        <div className="tl-row__head">
          <time className="tl-row__time" dateTime={new Date(item.at).toISOString()}>
            {when}
          </time>
          <Badge tone={e.action === "deleted" ? "danger" : e.action === "created" ? "success" : "info"}>
            {t(`timeline:action.${e.action}`)}
          </Badge>
          {e.late && (
            <span title={t("timeline:lateTitle")}>
              <Badge tone="warning">{t("timeline:late")}</Badge>
            </span>
          )}
          {showObject && <ObjectLink kind={e.kind} namespace={e.namespace} name={e.name} t={t} />}
          {e.action !== "deleted" && (
            <span className="tl-row__who" title={e.who ? formatList(e.who.managers.map((m) => m.manager)) : undefined}>
              {whoText(e.who, t)}
            </span>
          )}
        </div>
        <Changes entry={e} t={t} />
        <Correlations items={item.correlations} t={t} />
      </li>
    );
  }
  const e = item.entry;
  const subject = e.source === "revision" && e.owner ? e.owner : e.object;
  return (
    <li className="tl-row tl-row--partial" data-source={e.source}>
      <div className="tl-row__head">
        <time className="tl-row__time" dateTime={new Date(item.at).toISOString()}>
          {when}
        </time>
        <span title={t("timeline:partialTitle")}>
          <Badge>{t("timeline:partialBadge")}</Badge>
        </span>
        {showObject && <ObjectLink kind={subject.kind} namespace={subject.namespace} name={subject.name} t={t} />}
        <span className="tl-row__what">{partialText(e, t)}</span>
        {e.manager && (
          <span className="tl-row__who" title={e.manager}>
            {t("timeline:who.by", { who: managerName(e.manager, t) })}
          </span>
        )}
      </div>
      <Correlations items={item.correlations} t={t} />
    </li>
  );
}

/** The rows, newest first, `SHOWN` at a time. */
export function TimelineList({ items, showObject, label }: { items: readonly TimelineItem[]; showObject: boolean; label: string }) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(SHOWN);
  const hidden = items.length - limit;
  return (
    <>
      <ol className="tl-list" aria-label={label}>
        {items.slice(0, limit).map((item) => (
          <Row key={item.key} item={item} showObject={showObject} />
        ))}
      </ol>
      {hidden > 0 && (
        <button type="button" className="rt-link tl-list__more" onClick={() => setLimit((n) => n + SHOWN)}>
          {t("timeline:showMore", { count: Math.min(hidden, SHOWN) })}
        </button>
      )}
    </>
  );
}
