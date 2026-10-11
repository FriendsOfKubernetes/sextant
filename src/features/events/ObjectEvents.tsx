// Details section with the events of the opened object (every kind but Event itself), newest first, live.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KubeObject, type WatchSpec } from "../../api";
import { Age, ErrorState } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { byNewest, EVENT_KIND, eventCount, eventSelectorFor, eventSource, eventTimestamp, isWarning } from "./model";
import "./events.css";

export function ObjectEventsSection({ clusterId, obj, objectRef }: DetailsSectionProps) {
  const selector = obj ? eventSelectorFor(obj, objectRef.kind.kind) : null;
  if (!selector) return null;
  return <ObjectEvents clusterId={clusterId} selector={selector} namespace={objectRef.namespace ?? null} />;
}

function ObjectEvents({ clusterId, selector, namespace }: { clusterId: ClusterId; selector: string; namespace: string | null }) {
  const { t } = useTranslation();
  const spec = useMemo<WatchSpec>(
    () => ({ kind: EVENT_KIND, namespaces: namespace ? [namespace] : null, labelSelector: null, fieldSelector: selector }),
    [selector, namespace],
  );
  const watch = useWatch(clusterId, spec);
  const events = useMemo(() => [...watch.items.values()].sort(byNewest), [watch.items]);

  let body;
  if (watch.status === "error") body = <ErrorState error={watch.error} />;
  else if (watch.status === "loading") body = <div className="events-empty">{t("events:loading")}</div>;
  else if (events.length === 0) body = <div className="events-empty">{t("events:none")}</div>;
  else
    body = (
      <ul className="events-list">
        {events.map((e) => (
          <EventItem key={e.metadata?.uid ?? e.metadata?.name} event={e} />
        ))}
      </ul>
    );

  return (
    <div className="events-section">
      <h3 className="events-section__title">{t("events:title")}</h3>
      {body}
    </div>
  );
}

function EventItem({ event }: { event: KubeObject }) {
  const { t } = useTranslation();
  const warning = isWarning(event);
  const count = eventCount(event);
  const source = eventSource(event);
  return (
    <li className={warning ? "events-item events-warning" : "events-item"}>
      <div className="events-item__head">
        <span className="events-item__reason">{String(event.reason ?? "")}</span>
        {count > 1 && <span className="events-item__meta">{t("events:count", { count })}</span>}
        <span className="events-item__meta">
          <Age timestamp={eventTimestamp(event)} />
        </span>
      </div>
      <div className="events-item__message">{String(event.message ?? "")}</div>
      {source && <div className="events-item__meta">{t("events:from", { source })}</div>}
    </li>
  );
}
