// The live table of one kind (interfaces.md §3: `ResourceTable({ clusterId, kind, columns })`).
//
//   <ResourceTable clusterId={id} kind={{ group: "", version: "v1", kind: "Pod" }} />
//
// It watches the kind itself (`useWatch`) in the cluster's selected namespaces, filters by the cluster's search
// text (name, namespace, labels, `app=web`), sorts by any column, renders only the visible rows (5 000 rows
// scroll smoothly), supports selecting several rows, opens the details panel on a row click and offers the
// registered actions of the kind in a context menu (right click or the "⋮" button). Everything has a default
// from the resource registry and the store; the optional props override it (e.g. the Events page passes its own
// columns, a details section passes a field selector and fixed namespaces).
import {
  createSortedRowModel,
  rowSelectionFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type RowSelectionState,
  type SortFn,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { uidOf, useWatch, type ClusterId, type KindRef, type KubeObject, type ResourceKind } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { getActionsFor, runAction, useActionsVersion, type RegisteredAction } from "../../features/actions/registry";
import { refOf } from "../../resources/refs";
import { useResourceDef, type ActionId, type CellContext, type ColumnDef } from "../../resources/registry";
import { Badge } from "../Badge";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { matchesSearch } from "./search";
import "./table.css";

export const ROW_HEIGHT = 33;
const HEADER_HEIGHT = 33;
const AGE_TICK_MS = 10_000;

export interface ResourceTableProps {
  clusterId: ClusterId;
  kind: KindRef;
  /** Default: the kind's columns from the resource registry (with `extendColumns` additions). */
  columns?: ColumnDef[];
  /** Namespaces to watch, `null` = all. Default: the cluster's namespace filter from the store. */
  namespaces?: string[] | null;
  /** Search text. Default: the cluster's search text from the store. */
  search?: string;
  labelSelector?: string | null;
  fieldSelector?: string | null;
  /** Already translated title. Default: the kind's sidebar label (or the kind name for custom resources). */
  title?: string;
  /** Actions of the context menu. Default: the kind's `ResourceDef.actions`. */
  actions?: readonly ActionId[];
  /** Default: `openDetails` of the clicked object. */
  onRowClick?: (obj: KubeObject) => void;
  /** Extra controls in the header (namespace filter, search box). */
  toolbar?: ReactNode;
  /** Initial sort; default by name. `null` keeps the watch order. */
  defaultSort?: { id: string; desc?: boolean } | null;
  /** Discovery entry of the kind (printer columns and scope of custom resources). */
  resourceKind?: ResourceKind | null;
}

/** Each retry ("Retry" after an error) starts a fresh watch. */
export function ResourceTable(props: ResourceTableProps) {
  const [attempt, setAttempt] = useState(0);
  return <ResourceTableView key={attempt} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
});

/** Numbers numerically, text naturally ("pod-2" < "pod-10"), case-insensitive. */
export function compareCellValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

const sortByValue: SortFn<typeof features, KubeObject> = (a, b, id) =>
  compareCellValues(a.getValue(id), b.getValue(id));

function ariaSortOf(sorted: false | "asc" | "desc"): "ascending" | "descending" | undefined {
  if (sorted === "asc") return "ascending";
  if (sorted === "desc") return "descending";
  return undefined;
}

interface MenuState {
  x: number;
  y: number;
  objects: KubeObject[];
}

function ResourceTableView(props: ResourceTableProps & { onRetry: () => void }) {
  const { clusterId, kind, onRetry } = props;
  const { t } = useTranslation();
  const def = useResourceDef(kind, props.resourceKind);
  const view = useClusterView(clusterId);
  const openDetails = useAppStore((s) => s.openDetails);
  const details = useAppStore((s) => s.details);
  useActionsVersion();

  const columns = props.columns ?? def.columns;
  const namespaced = props.resourceKind?.namespaced ?? def.namespaced ?? true;
  const namespaces = props.namespaces !== undefined ? props.namespaces : view.namespaces;
  const search = props.search ?? view.search;
  const actionIds = props.actions ?? def.actions;
  const title = props.title ?? (def.sidebar ? t(def.sidebar.labelKey) : (def.title ?? kind.kind));

  const spec = useMemo(
    () => ({
      kind,
      namespaces: namespaced && namespaces && namespaces.length > 0 ? namespaces : null,
      labelSelector: props.labelSelector ?? null,
      fieldSelector: props.fieldSelector ?? null,
    }),
    [kind, namespaced, namespaces, props.labelSelector, props.fieldSelector],
  );
  const watch = useWatch(clusterId, spec);

  const data = useMemo(
    () => [...watch.items.values()].filter((obj) => matchesSearch(obj, search)),
    [watch.items, search],
  );

  const tableColumns = useMemo(
    () =>
      columns.map((c) => ({
        id: c.id,
        accessorFn: (obj: KubeObject) => c.value(obj),
        enableSorting: c.sortable !== false,
        sortFn: sortByValue,
        sortUndefined: "last" as const,
        // The first click sorts ascending for every column (numbers would start descending).
        sortDescFirst: false,
      })),
    [columns],
  );

  const initialSort = props.defaultSort === undefined ? { id: "name", desc: false } : props.defaultSort;
  const [sorting, setSorting] = useState<SortingState>(() =>
    initialSort && columns.some((c) => c.id === initialSort.id)
      ? [{ id: initialSort.id, desc: initialSort.desc ?? false }]
      : [],
  );
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const table = useTable({
    features,
    columns: tableColumns,
    data,
    getRowId: (obj: KubeObject) => uidOf(obj),
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableSortingRemoval: false,
  });
  const rows = table.getRowModel().rows;

  // Selection of rows that are gone (deleted, filtered out) is dropped.
  useEffect(() => {
    setRowSelection((current) => {
      const ids = Object.keys(current).filter((id) => current[id]);
      const kept = ids.filter((id) => watch.items.has(id) && data.some((o) => uidOf(o) === id));
      if (kept.length === ids.length) return current;
      return Object.fromEntries(kept.map((id) => [id, true]));
    });
  }, [watch.items, data]);

  const selected = rows.filter((r) => r.getIsSelected()).map((r) => r.original);

  const now = useNow(AGE_TICK_MS);
  const cellContext: CellContext = useMemo(() => ({ clusterId, kind, now }), [clusterId, kind, now]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 10,
    scrollMargin: HEADER_HEIGHT,
  });

  const [menu, setMenu] = useState<MenuState | null>(null);
  const openMenu = (obj: KubeObject, x: number, y: number) => {
    const uid = uidOf(obj);
    const inSelection = rowSelection[uid] && selected.length > 1;
    setMenu({ x, y, objects: inSelection ? selected : [obj] });
  };

  const template = `32px ${columns.map((c) => c.width ?? "minmax(80px, 1fr)").join(" ")} 32px`;
  const gridStyle = { "--rt-columns": template } as CSSProperties;
  const total = watch.items.size;

  const header = (
    <header className="rt__header">
      <h2 className="rt__title">{title}</h2>
      <span className="rt__count" data-testid="rt-count">
        {search.trim() && data.length !== total
          ? t("resources:table.countFiltered", { shown: data.length, total })
          : t("resources:table.count", { count: total })}
      </span>
      {watch.status === "reconnecting" && (
        <span role="status" className="rt__reconnecting">
          <Badge tone="warning">{t("resources:table.reconnecting")}</Badge>
        </span>
      )}
      {selected.length > 0 && (
        <span className="rt__selected">{t("resources:table.selected", { count: selected.length })}</span>
      )}
      <div className="rt__toolbar">{props.toolbar}</div>
    </header>
  );

  let body: ReactNode;
  if (watch.status === "error") {
    const forbidden = watch.error?.code === "forbidden";
    body = (
      <ErrorState
        error={watch.error}
        title={forbidden ? t("resources:table.forbidden", { kind: title }) : undefined}
        onRetry={forbidden ? undefined : onRetry}
      />
    );
  } else if (watch.status === "loading") {
    body = (
      <div className="rt__loading" role="status">
        {t("resources:table.loading")}
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        title={
          search.trim() && total > 0
            ? t("resources:table.noMatches", { search: search.trim() })
            : namespaced
              ? t("resources:table.empty", { kind: title })
              : t("resources:table.emptyClusterScoped", { kind: title })
        }
      />
    );
  } else {
    const allSelected = table.getIsAllRowsSelected();
    body = (
      <div className="rt__scroll" ref={scrollRef}>
        <div
          className="rt__grid"
          role="table"
          aria-label={title}
          aria-rowcount={rows.length + 1}
          aria-multiselectable
          style={gridStyle}
        >
          <div className="rt__head" role="rowgroup">
            <div className="rt__row rt__row--head" role="row" aria-rowindex={1}>
              <div className="rt__cell rt__cell--check" role="columnheader">
                <input
                  type="checkbox"
                  aria-label={t("resources:table.selectAll")}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && table.getIsSomeRowsSelected();
                  }}
                  onChange={() => table.toggleAllRowsSelected(!allSelected)}
                />
              </div>
              {columns.map((c) => {
                const column = table.getColumn(c.id);
                const sorted = column?.getIsSorted() ?? false;
                const ariaSort = ariaSortOf(sorted);
                const label = c.titleKey ? t(c.titleKey) : (c.title ?? c.id);
                return (
                  <div key={c.id} className="rt__cell rt__cell--head" role="columnheader" aria-sort={ariaSort}>
                    {column?.getCanSort() ? (
                      <button type="button" className="rt__sort" onClick={() => column.toggleSorting()}>
                        {label}
                        <span className="rt__sort-icon" aria-hidden>
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}
                        </span>
                      </button>
                    ) : (
                      label
                    )}
                  </div>
                );
              })}
              <div className="rt__cell rt__cell--menu" role="columnheader" />
            </div>
          </div>
          <div className="rt__body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const obj = row.original;
              const isSelected = row.getIsSelected();
              const active =
                details !== null &&
                details.kind.kind === kind.kind &&
                details.kind.group === kind.group &&
                details.name === obj.metadata?.name &&
                (details.namespace ?? null) === (obj.metadata?.namespace ?? null);
              return (
                <div
                  key={row.id}
                  className={`rt__row${isSelected ? " rt__row--selected" : ""}${active ? " rt__row--active" : ""}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={isSelected}
                  data-uid={row.id}
                  tabIndex={0}
                  style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
                  onClick={() => (props.onRowClick ? props.onRowClick(obj) : openDetails(refOf(obj, kind)))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      if (props.onRowClick) props.onRowClick(obj);
                      else openDetails(refOf(obj, kind));
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(obj, e.clientX, e.clientY);
                  }}
                >
                  <div className="rt__cell rt__cell--check" role="cell" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={t("resources:table.selectRow", { name: obj.metadata?.name ?? "" })}
                      checked={isSelected}
                      onChange={() => undefined}
                      onClick={row.getToggleSelectedHandler()}
                    />
                  </div>
                  {columns.map((c) => (
                    <div key={c.id} className="rt__cell" role="cell">
                      {c.render ? c.render(obj, cellContext) : formatValue(c.value(obj))}
                    </div>
                  ))}
                  <div className="rt__cell rt__cell--menu" role="cell">
                    <button
                      type="button"
                      className="icon-btn icon-btn--small"
                      aria-label={t("resources:table.actionsFor", { name: obj.metadata?.name ?? "" })}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = e.currentTarget.getBoundingClientRect();
                        openMenu(obj, rect.left, rect.bottom);
                      }}
                    >
                      ⋮
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="rt" aria-label={title} data-kind={kind.kind}>
      {header}
      {body}
      {menu && (
        <ActionMenu
          x={menu.x}
          y={menu.y}
          actions={getActionsFor(menu.objects, kind, actionIds)}
          onClose={() => setMenu(null)}
          onRun={(action) => {
            setMenu(null);
            void runAction(action, clusterId, kind, menu.objects);
          }}
        />
      )}
    </section>
  );
}

function formatValue(value: ReturnType<ColumnDef["value"]>): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function ActionMenu({
  x,
  y,
  actions,
  onClose,
  onRun,
}: {
  x: number;
  y: number;
  actions: RegisteredAction[];
  onClose: () => void;
  onRun: (action: RegisteredAction) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="rt-menu" role="menu" aria-label={t("resources:table.actions")} style={{ left: x, top: y }}>
      {actions.length === 0 ? (
        <div className="rt-menu__empty">{t("resources:table.noActions")}</div>
      ) : (
        actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className={`rt-menu__item${action.danger ? " rt-menu__item--danger" : ""}`}
            onClick={() => onRun(action)}
          >
            <span className="rt-menu__icon" aria-hidden>
              {action.icon}
            </span>
            {t(action.labelKey)}
          </button>
        ))
      )}
    </div>
  );
}

/** Current time, refreshed every `ms` (ages in the table tick). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
