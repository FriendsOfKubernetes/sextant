// Events page (sidebar section "Events"): every event of the selected namespaces, newest first; warnings are
// highlighted and each row links to the object it is about.
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { Age } from "../../components";
import { ResourceTable } from "../../components/Table";
import type { PageProps } from "../../layout/pages";
import { ObjectLink, type ColumnDef } from "../../resources";
import { NamespaceFilter, useSelectedNamespaces } from "../namespaces";
import { EVENT_KIND, eventCount, eventSource, eventTime, eventTimestamp, involvedObject, isWarning } from "./model";
import "./events.css";

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `events:columns.${id}`,
  value,
  ...options,
});

export function EventType({ event }: { event: KubeObject }) {
  const type = typeof event.type === "string" ? event.type : "";
  return <span className={isWarning(event) ? "events-type events-warning" : "events-type"}>{type}</span>;
}

export function InvolvedObjectLink({ event }: { event: KubeObject }) {
  const target = involvedObject(event);
  if (!target) return null;
  return (
    <ObjectLink target={target} namespace={target.namespace}>
      {`${target.kind}: ${target.name}`}
    </ObjectLink>
  );
}

export const EVENT_COLUMNS: ColumnDef[] = [
  col("type", (e) => (typeof e.type === "string" ? e.type : undefined), {
    width: "80px",
    render: (e) => <EventType event={e} />,
  }),
  col("reason", (e) => (typeof e.reason === "string" ? e.reason : undefined), { width: "minmax(100px, 1fr)" }),
  col("message", (e) => (typeof e.message === "string" ? e.message : undefined), {
    width: "minmax(220px, 4fr)",
    render: (e) => (
      <span className={isWarning(e) ? "events-message events-warning" : "events-message"} title={String(e.message ?? "")}>
        {String(e.message ?? "")}
      </span>
    ),
  }),
  col("namespace", (e) => e.metadata?.namespace, { width: "minmax(100px, 1fr)" }),
  col(
    "involvedObject",
    (e) => {
      const o = involvedObject(e);
      return o ? `${o.kind}/${o.name}` : undefined;
    },
    { width: "minmax(160px, 2fr)", render: (e) => <InvolvedObjectLink event={e} /> },
  ),
  col("source", eventSource, { width: "minmax(100px, 1fr)" }),
  col("count", eventCount, { width: "60px" }),
  col(
    "lastSeen",
    (e) => {
      const t = eventTime(e);
      return t === undefined ? undefined : -t;
    },
    { width: "80px", render: (e, ctx) => <Age timestamp={eventTimestamp(e)} now={ctx.now} /> },
  ),
];

/** "Last seen" holds the negated time, so ascending is newest first. */
const NEWEST_FIRST = { id: "lastSeen", desc: false };
const NO_ACTIONS: [] = [];

export function EventsPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const namespaces = useSelectedNamespaces(clusterId);
  const search = useClusterView(clusterId).search;
  const setSearch = useAppStore((s) => s.setSearch);
  if (namespaces === undefined) {
    return (
      <div className="rt__loading" role="status">
        {t("events:loading")}
      </div>
    );
  }
  return (
    <ResourceTable
      clusterId={clusterId}
      kind={EVENT_KIND}
      columns={EVENT_COLUMNS}
      namespaces={namespaces}
      search={search}
      title={t("events:title")}
      actions={NO_ACTIONS}
      defaultSort={NEWEST_FIRST}
      toolbar={
        <>
          <NamespaceFilter clusterId={clusterId} />
          <input
            className="main__search"
            type="search"
            value={search}
            placeholder={t("events:searchPlaceholder")}
            aria-label={t("events:search")}
            onChange={(e) => setSearch(clusterId, e.target.value)}
          />
        </>
      }
    />
  );
}
