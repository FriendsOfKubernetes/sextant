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
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { isCapped, uidOf, updateSettings, useWatch, type ClusterId, type KindRef, type KubeObject, type ResourceKind } from "../../api";
import { useCssLength } from "../../app/accessibility";
import { useAppStore, useClusterView } from "../../app/store";
import {
  actionLabel,
  getActionsFor,
  runAction,
  useActionsVersion,
  type RegisteredAction,
} from "../../features/actions/registry";
import { AddColumnDialog } from "../../features/custom-columns/AddColumnDialog";
import {
  columnDefOf,
  useShownColumns,
  withColumn,
  withoutColumn,
  type ShownColumn,
} from "../../features/custom-columns/model";
import { columnIdOf, type CustomColumnSpec } from "../../features/custom-columns/path";
import { listSeparator } from "../../i18n/format";
import { useObjectCount } from "../../resources/counts";
import { kindKey, refOf } from "../../resources/refs";
import { useResourceDef, type ActionId, type CellContext, type ColumnDef } from "../../resources/registry";
import { Badge } from "../Badge";
import { Button } from "../Button";
import { Checkbox } from "../Checkbox";
import { EmptyState } from "../EmptyState";
import { ErrorState } from "../ErrorState";
import { Icon, renderIcon } from "../icons";
import { pointRect, usePopupPosition, type PopupRect } from "../placePopup";
import { usePopup } from "../usePopup";
import { LoadingIndicator } from "../LoadingIndicator";
import {
  COUNT_WAIT_MS,
  SERVER_FILTER_DELAY_MS,
  TABLE_GUARD_OBJECTS,
  TABLE_MAX_OBJECTS,
  TABLE_WATCH_OPTIONS,
} from "./limits";
import { showCutText, useColumnWidths, type ColumnWidthMap } from "./columnWidths";
import { ResizeHandles } from "./ResizeHandle";
import { compileSearch, searchTerms } from "./search";
import { joinSelectors, serverSelectors } from "./selectors";
import "./table.css";

/**
 * A row's height at the default text size; the header row is as high. The table measures `--table-row-height`
 * (table.css, in rem, so rows grow with the interface text size) and uses this only where nothing is laid out.
 */
export const ROW_HEIGHT = 33;
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
  /** Rows kept besides the search (e.g. "Only problems"); the count then says "shown of total". */
  rowFilter?: (obj: KubeObject) => boolean;
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
  /**
   * When the table was asked for (`Date.now()`): the loading indicator of its first watch counts from it (default: its
   * first render); a later watch (other namespaces) counts from its own start.
   */
  loadingSince?: number;
  /**
   * The sort, controlled by the caller (a saved view, #149): `null` = the default sort. Used together with
   * `onSortChange`; without it the table keeps its own sort.
   */
  sort?: { column: string; desc: boolean } | null;
  onSortChange?: (sort: { column: string; desc: boolean } | null) => void;
  /** Column ids not shown. */
  hiddenColumns?: readonly string[];
  /** With it the header offers a "Columns" menu that shows or hides columns. */
  onHiddenColumnsChange?: (hidden: string[]) => void;
  /**
   * Id the column widths the user drags are saved under (`useColumnWidths`). Default: `kind:<group>/<Kind>`, shared
   * by every table of the kind; `null` = not saved.
   */
  widthsId?: string | null;
  /**
   * The user's own columns of the kind (#214): with it the table shows the custom columns stored for the kind in this
   * cluster and in every cluster, plus `viewColumns` (those of an opened saved view), and the Columns menu offers
   * "Add column…" and removing them. Values are read from the objects the table already watches.
   */
  customColumns?: CustomColumnsOptions;
}

export interface CustomColumnsOptions {
  /** Columns of the opened saved view (`TableState.viewColumns`). */
  viewColumns?: readonly CustomColumnSpec[];
  /** Removing or keeping a view column; without it they cannot be removed. */
  onViewColumnsChange?: (columns: CustomColumnSpec[]) => void;
  /** The table lists metadata only: only labels, annotations and `.metadata` paths are offered. */
  metadataOnly?: boolean;
}

/** Custom columns go before "age" when the table has it, else at the end. */
function withCustomColumns(columns: ColumnDef[], custom: ColumnDef[]): ColumnDef[] {
  if (custom.length === 0) return columns;
  const age = columns.findIndex((c) => c.id === "age");
  return age < 0 ? [...columns, ...custom] : [...columns.slice(0, age), ...custom, ...columns.slice(age)];
}

/** Each retry ("Retry" after an error) starts a fresh watch. */
export function ResourceTable(props: ResourceTableProps) {
  const [attempt, setAttempt] = useState(0);
  // A retry is a new wait: its indicator counts from the retry.
  const loadingSince = attempt === 0 ? props.loadingSince : undefined;
  return (
    <ResourceTableView key={attempt} {...props} loadingSince={loadingSince} onRetry={() => setAttempt((n) => n + 1)} />
  );
}

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
});

/** One collator for every comparison: `localeCompare` with options builds one per call (5× slower on 50k rows). */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Numbers numerically, text naturally ("pod-2" < "pod-10"), case-insensitive. */
export function compareCellValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return collator.compare(String(a), String(b));
}

/** `value`, but a change reaches the caller only after `ms` without another one (compared by value). */
function useDebouncedValue<T>(value: T, ms: number): T {
  const key = JSON.stringify(value);
  const [current, setCurrent] = useState(() => ({ key, value }));
  useEffect(() => {
    if (key === current.key) return;
    const timer = setTimeout(() => setCurrent({ key, value }), ms);
    return () => clearTimeout(timer);
    // `key` stands for `value`.
  }, [key, current.key, ms]);
  return current.value;
}

/** Delay before the row count is announced after the search or the filter changed (typing settles first). */
export const ANNOUNCE_DELAY_MS = 700;

/**
 * The text a live region says: `message` once `key` (the search and the filter) changed and stayed for
 * {@link ANNOUNCE_DELAY_MS}; empty before the first change, so opening a table announces nothing.
 */
function useSearchAnnouncement(key: string, message: string): string {
  const [said, setSaid] = useState({ key, text: "" });
  useEffect(() => {
    if (key === said.key) return;
    const timer = setTimeout(() => setSaid({ key, text: message }), ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, said.key, message]);
  return said.text;
}

/** Kinds the user chose to list in every namespace although they are many (cluster|group/Kind), for the session. */
const shownAnyway = new Set<string>();

const sortByValue: SortFn<typeof features, KubeObject> = (a, b, id) =>
  compareCellValues(a.getValue(id), b.getValue(id));

function ariaSortOf(sorted: false | "asc" | "desc"): "ascending" | "descending" | undefined {
  if (sorted === "asc") return "ascending";
  if (sorted === "desc") return "descending";
  return undefined;
}

/**
 * When the current watch began: `askedAt` for the first one (the table was asked for before it mounted), the moment
 * of the change for each later one (other namespaces, selectors or cluster) — a new watch is a new wait.
 */
function useWatchStart(watchKey: string, askedAt: number | undefined): number | undefined {
  const [start, setStart] = useState({ watchKey, since: askedAt });
  if (start.watchKey !== watchKey) {
    const next = { watchKey, since: Date.now() };
    setStart(next);
    return next.since;
  }
  return start.since;
}

interface MenuState {
  /** What the menu opens at: the "⋮" button, or the pointer / row for a context menu. */
  anchor: PopupRect;
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

  const customOptions = props.customColumns;
  const shownCustom = useShownColumns(
    customOptions ? clusterId : null,
    { group: kind.group, kind: kind.kind, metadataOnly: customOptions?.metadataOnly },
    customOptions?.viewColumns,
  );
  const customDefs = useMemo(() => shownCustom.map((c) => columnDefOf(c, listSeparator())), [shownCustom]);
  const baseColumns = props.columns ?? def.columns;
  const allColumns = useMemo(() => withCustomColumns(baseColumns, customDefs), [baseColumns, customDefs]);
  const { hiddenColumns } = props;
  const columns = useMemo(() => {
    if (!hiddenColumns || hiddenColumns.length === 0) return allColumns;
    const shown = allColumns.filter((c) => !hiddenColumns.includes(c.id));
    // A table never loses every column.
    return shown.length > 0 ? shown : allColumns;
  }, [allColumns, hiddenColumns]);
  const colWidths = useColumnWidths(props.widthsId !== undefined ? props.widthsId : `kind:${kindKey(kind)}`);
  const namespaced = props.resourceKind?.namespaced ?? def.namespaced ?? true;
  const namespaces = props.namespaces !== undefined ? props.namespaces : view.namespaces;
  const search = props.search ?? view.search;
  const actionIds = props.actions ?? def.actions;
  const title = props.title ?? (def.sidebar ? t(def.sidebar.labelKey) : (def.title ?? kind.kind));

  // The search's selector terms are sent to the API server (after a pause in typing), so the watch lists only what
  // they keep; the whole search still filters the rows here (#157).
  const kindId = kindKey(kind);
  const pushed = useDebouncedValue(
    useMemo(() => serverSelectors(searchTerms(search), kindId), [search, kindId]),
    SERVER_FILTER_DELAY_MS,
  );
  const spec = useMemo(
    () => ({
      kind,
      namespaces: namespaced && namespaces && namespaces.length > 0 ? namespaces : null,
      labelSelector: joinSelectors(props.labelSelector, pushed.labelSelector),
      fieldSelector: joinSelectors(props.fieldSelector, pushed.fieldSelector),
    }),
    [kind, namespaced, namespaces, props.labelSelector, props.fieldSelector, pushed],
  );
  // Before a namespaced kind is watched in every namespace with no selector, it is counted (one metadata request);
  // with more than TABLE_GUARD_OBJECTS objects the table asks first. A failed count does not hold the table back.
  const everywhere = namespaced && spec.namespaces === null && !spec.labelSelector && !spec.fieldSelector;
  const anywayKey = `${clusterId}|${kindId}`;
  const [anyway, setAnyway] = useState(() => shownAnyway.has(anywayKey));
  const counted = useObjectCount(everywhere && !anyway ? clusterId : null, kind, null, true);
  // A count that takes longer than COUNT_WAIT_MS does not hold the (capped) watch back either.
  const [countKey, setCountGaveUp] = useState<string | null>(null);
  const gaveUp = countKey === anywayKey;
  const counting = everywhere && !anyway && !gaveUp && counted.count === undefined && counted.error === undefined;
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => setCountGaveUp(anywayKey), COUNT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [counting, anywayKey]);
  const guarded = everywhere && !anyway && counted.count !== undefined && counted.count.count > TABLE_GUARD_OBJECTS;
  const watch = useWatch(clusterId, guarded || counting ? null : spec, TABLE_WATCH_OPTIONS);
  const watchKey = JSON.stringify([clusterId, spec]);
  const loadingSince = useWatchStart(watchKey, props.loadingSince);

  // While a narrower (or wider) watch of the same list starts, the rows of the previous one stay, filtered by the
  // search here, instead of a loading indicator at every keystroke that changes a selector term.
  const listKey = JSON.stringify([clusterId, kind, spec.namespaces, props.labelSelector ?? null, props.fieldSelector ?? null]);
  // Kept in a ref, not state: noting the rows of each batch must not cost another render.
  const lastReady = useRef<{ listKey: string; items: Map<string, KubeObject> } | null>(null);
  useEffect(() => {
    if (watch.status === "ready") lastReady.current = { listKey, items: watch.items };
  }, [watch.status, watch.items, listKey]);
  const previous = watch.status === "loading" && watch.items.size === 0 ? lastReady.current : null;
  const stale = previous?.listKey === listKey;
  const items = stale && previous ? previous.items : watch.items;

  const { rowFilter } = props;
  const data = useMemo(() => {
    // Plain search words also match the text of the custom columns (#214).
    const customText =
      customDefs.length > 0
        ? (obj: KubeObject) => customDefs.map((c) => c.value(obj)).filter((v) => v !== undefined && v !== null).map(String)
        : undefined;
    const matches = compileSearch(search, kindId, customText);
    return [...items.values()].filter((obj) => matches(obj) && (!rowFilter || rowFilter(obj)));
  }, [items, search, kindId, rowFilter, customDefs]);
  const filtered = Boolean(search.trim()) || rowFilter !== undefined;

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
  const [ownSorting, setOwnSorting] = useState<SortingState>(() =>
    initialSort && columns.some((c) => c.id === initialSort.id)
      ? [{ id: initialSort.id, desc: initialSort.desc ?? false }]
      : [],
  );
  const { onSortChange } = props;
  const controlledSort = props.sort;
  const sorting: SortingState = useMemo(() => {
    if (!onSortChange) return ownSorting;
    if (controlledSort && columns.some((c) => c.id === controlledSort.column))
      return [{ id: controlledSort.column, desc: controlledSort.desc }];
    return initialSort && columns.some((c) => c.id === initialSort.id)
      ? [{ id: initialSort.id, desc: initialSort.desc ?? false }]
      : [];
  }, [onSortChange, ownSorting, controlledSort, columns, initialSort]);
  const setSorting = (updater: SortingState | ((old: SortingState) => SortingState)) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    if (!onSortChange) {
      setOwnSorting(next);
      return;
    }
    const first = next[0];
    onSortChange(first ? { column: first.id, desc: first.desc } : null);
  };
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
      if (ids.length === 0) return current;
      const shown = new Set(data.map(uidOf));
      const kept = ids.filter((id) => shown.has(id));
      if (kept.length === ids.length) return current;
      return Object.fromEntries(kept.map((id) => [id, true]));
    });
  }, [data]);

  const selected = rows.filter((r) => r.getIsSelected()).map((r) => r.original);

  const now = useNow(AGE_TICK_MS);
  const cellContext: CellContext = useMemo(() => ({ clusterId, kind, now }), [clusterId, kind, now]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const dropViewColumn = (id: string) =>
    customOptions?.onViewColumnsChange?.(
      (customOptions.viewColumns ?? []).filter((c) => columnIdOf(c.source, c.path) !== id),
    );
  const removeCustom = (column: ShownColumn) => {
    if (column.scope === "view") {
      dropViewColumn(column.id);
      return;
    }
    const cluster = column.scope === "cluster" ? clusterId : null;
    void updateSettings((current) => withoutColumn(current, cluster, kind, column.id)).catch(() => undefined);
  };
  // A saved view's column kept for this cluster: stored, then no longer the view's.
  const keepCustom = (column: ShownColumn) => {
    void updateSettings((current) => {
      const next = withColumn(current, clusterId, kind, column.spec);
      return "problem" in next ? current : next;
    }).then(
      () => dropViewColumn(column.id),
      () => undefined,
    );
  };
  const openMenu = (obj: KubeObject, anchor: PopupRect) => {
    const uid = uidOf(obj);
    const inSelection = rowSelection[uid] && selected.length > 1;
    setMenu({ anchor, objects: inSelection ? selected : [obj] });
  };

  // Keyboard: the row in the tab order and a row to focus once it is drawn (after a scroll to it), by object uid, so
  // an update of the watch that moves rows keeps the same object.
  const sectionRef = useRef<HTMLElement>(null);
  const [focusUid, setFocusUid] = useState<string | null>(null);
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const uid = pendingFocus.current;
    if (uid === null) return;
    const drawnRows = sectionRef.current?.querySelectorAll<HTMLElement>(".rt__body [role='row']") ?? [];
    const el = [...drawnRows].find((row) => row.dataset.uid === uid);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });
  const onRowsKey = (e: KeyboardEvent<HTMLDivElement>, virtualizer: Virtualizer<HTMLDivElement, Element>) => {
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "row" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const from = Number(target.dataset.index ?? 0);
    const view = virtualizer.scrollElement?.clientHeight ?? 0;
    const rowHeight = virtualizer.options.estimateSize(from);
    const page = Math.max(1, Math.floor((view - virtualizer.options.scrollMargin) / rowHeight) - 1);
    const last = rows.length - 1;
    const next = rowKeyTarget(e.key, from, last, page);
    if (next === null) return;
    const uid = rows[next]?.id;
    if (uid === undefined) return;
    e.preventDefault();
    setFocusUid(uid);
    pendingFocus.current = uid;
    virtualizer.scrollToIndex(next, { align: "auto" });
  };

  const templateOf = (widths: ColumnWidthMap) =>
    `32px ${columns.map((c) => (widths[c.id] !== undefined ? `${widths[c.id]}px` : (c.width ?? "minmax(80px, 1fr)"))).join(" ")} 32px`;
  const gridStyle = { "--rt-columns": templateOf(colWidths.widths) } as CSSProperties;
  // A drag moves the columns through the grid's CSS variable (once per frame), not through a render of the rows.
  const gridRef = useRef<HTMLDivElement>(null);
  const previewWidth = (column: string, px: number) =>
    gridRef.current?.style.setProperty("--rt-columns", templateOf({ ...colWidths.widths, [column]: px }));
  const total = items.size;
  const listing = watch.status === "loading" && items.size > 0;

  const countText =
    filtered && data.length !== total
      ? t("resources:table.countFiltered", { shown: data.length, total })
      : t("resources:table.count", { count: total });
  const announced = useSearchAnnouncement(`${search.trim()}|${rowFilter ? 1 : 0}`, countText);

  const header = (
    <header className="rt__header">
      <h2 className="rt__title">{title}</h2>
      <span className="rt__count" data-testid="rt-count">
        {countText}
      </span>
      {/* Screen readers hear the count after the search or the filter changes, not on every update of the watch. */}
      <span className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="rt-announce">
        {announced}
      </span>
      {watch.status === "reconnecting" && (
        <span role="status" className="rt__reconnecting">
          <Badge tone="warning">{t("resources:table.reconnecting")}</Badge>
        </span>
      )}
      {listing && (
        <span role="status" className="rt__listing" data-testid="rt-listing">
          <Badge tone="neutral">
            {stale ? t("scale:table.updating") : t("scale:table.loadingMore", { count: total })}
          </Badge>
        </span>
      )}
      {isCapped(watch) && (
        <span className="rt__capped" data-testid="rt-capped">
          <Badge tone="warning">
            {t("scale:table.capped", { count: watch.total, shown: watch.items.size })}
          </Badge>
        </span>
      )}
      {watch.forbidden && watch.forbidden.length > 0 && watch.status !== "error" && (
        <span className="rt__forbidden" data-testid="rt-forbidden" title={watch.forbidden.join("\n")}>
          <Badge tone="warning">{t("resources:table.forbiddenIn", { namespaces: watch.forbidden.join(", ") })}</Badge>
        </span>
      )}
      {selected.length > 0 && (
        <span className="rt__selected">{t("resources:table.selected", { count: selected.length })}</span>
      )}
      <div className="rt__toolbar">
        {props.toolbar}
        {(props.onHiddenColumnsChange || colWidths.customized || customOptions) && (
          <ColumnsMenu
            columns={allColumns}
            hidden={hiddenColumns ?? []}
            onChange={props.onHiddenColumnsChange}
            widthsCustomized={colWidths.customized}
            onResetWidths={colWidths.reset}
            custom={customOptions ? shownCustom : undefined}
            onAddCustom={customOptions ? () => setAddingColumn(true) : undefined}
            onRemoveCustom={removeCustom}
            onKeepCustom={keepCustom}
            canRemoveView={Boolean(customOptions?.onViewColumnsChange)}
          />
        )}
      </div>
    </header>
  );

  // Instead of the rows: an error, the loading indicator or "nothing here" — inside the same scroll container.
  let state: ReactNode = null;
  if (guarded && counted.count) {
    state = (
      <div className="rt__guard" role="status">
        <p className="rt__guard-title">
          {counted.count.exact
            ? t("scale:guard.title", { count: counted.count.count, kind: title })
            : t("scale:guard.titleAtLeast", { count: counted.count.count, kind: title })}
        </p>
        <p className="rt__guard-text">{t("scale:guard.text", { max: TABLE_MAX_OBJECTS })}</p>
        <Button
          onClick={() => {
            shownAnyway.add(anywayKey);
            setAnyway(true);
          }}
        >
          {t("scale:guard.showAnyway")}
        </Button>
      </div>
    );
  } else if (watch.status === "error") {
    const forbidden = watch.error?.code === "forbidden";
    state = (
      <ErrorState
        error={watch.error}
        title={forbidden ? t("resources:table.forbidden", { kind: title }) : undefined}
        onRetry={forbidden ? undefined : onRetry}
      />
    );
  } else if (watch.status === "loading" && items.size === 0) {
    state = (
      <LoadingIndicator
        className="rt__loading"
        text={t("resources:loading.kind", { kind: title })}
        since={loadingSince}
      />
    );
  } else if (rows.length === 0) {
    state = (
      <EmptyState
        title={
          search.trim() && total > 0
            ? t("resources:table.noMatches", { search: search.trim() })
            : rowFilter && total > 0
              ? t("resources:table.noFilterMatches")
            : namespaced
              ? t("resources:table.empty")
              : t("resources:table.emptyClusterScoped")
        }
      />
    );
  }

  const renderGrid = (virtualizer: Virtualizer<HTMLDivElement, Element>) => {
    const allSelected = table.getIsAllRowsSelected();
    const drawn = virtualizer.getVirtualItems();
    const tabUid = drawn.some((i) => rows[i.index]?.id === focusUid) ? focusUid : rows[drawn[0]?.index ?? 0]?.id;
    return (
      // The handles that resize the columns lie over the header in a grid of their own with the same columns (inside
      // a header cell they would become part of its name), before the table in the tab order.
      <div ref={gridRef} className="rt__frame" style={gridStyle}>
      <ResizeHandles
        className="rt__resizers"
        slotClassName="rt__resizer"
        leading={<div />}
        columns={columns.map((c) => ({
          key: c.id,
          name: c.titleKey ? t(c.titleKey) : (c.title ?? c.id),
          width: colWidths.widths[c.id],
        }))}
        onPreview={previewWidth}
        onCommit={colWidths.setWidth}
      />
      <div
        className="rt__grid"
        role="table"
        aria-label={title}
        aria-rowcount={rows.length + 1}
        onKeyDown={(e) => onRowsKey(e, virtualizer)}
        onMouseOver={showCutText}
      >
        <div className="rt__head" role="rowgroup">
          <div className="rt__row rt__row--head" role="row" aria-rowindex={1}>
            <div className="rt__cell rt__cell--check" role="columnheader">
              <Checkbox
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
                      <span className="rt__sort-label">{label}</span>
                      {/* Only the sorted column has the icon: an empty slot cut narrow headers ("Repl…"). */}
                      {sorted && (
                        <span className="rt__sort-icon" aria-hidden>
                          <Icon name={sorted === "asc" ? "sortAsc" : "sortDesc"} size={12} />
                        </span>
                      )}
                    </button>
                  ) : (
                    <span className="rt__head-label">{label}</span>
                  )}
                </div>
              );
            })}
            <div className="rt__cell rt__cell--menu" role="columnheader">
              <span className="visually-hidden">{t("resources:table.actions")}</span>
            </div>
          </div>
        </div>
        <div className="rt__body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            const obj = row.original;
            const isSelected = row.getIsSelected();
            // One row is in the tab order (the last focused one, or the first drawn); arrows move between rows, and
            // the row's own controls are tab stops only in that row.
            const current = row.id === tabUid;
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
                data-index={item.index}
                tabIndex={current ? 0 : -1}
                onFocus={(e) => {
                  if (e.target === e.currentTarget) setFocusUid(row.id);
                }}
                style={{ transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }}
                onClick={() => (props.onRowClick ? props.onRowClick(obj) : openDetails(refOf(obj, kind)))}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter") {
                    if (props.onRowClick) props.onRowClick(obj);
                    else openDetails(refOf(obj, kind));
                  } else if (e.key === " ") {
                    e.preventDefault();
                    row.toggleSelected();
                  } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    openMenu(obj, pointRect(rect.left + 32, rect.bottom));
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(obj, pointRect(e.clientX, e.clientY));
                }}
              >
                <div className="rt__cell rt__cell--check" role="cell" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    aria-label={t("resources:table.selectRow", { name: obj.metadata?.name ?? "" })}
                    tabIndex={current ? 0 : -1}
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
                    tabIndex={current ? 0 : -1}
                    aria-label={t("resources:table.actionsFor", { name: obj.metadata?.name ?? "" })}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      const { left, top, right, bottom } = e.currentTarget.getBoundingClientRect();
                      openMenu(obj, { left, top, right, bottom });
                    }}
                  >
                    <Icon name="more" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      </div>
    );
  };

  return (
    <section
      ref={sectionRef}
      className="rt"
      aria-label={title}
      aria-busy={watch.status === "loading" || undefined}
      data-kind={kind.kind}
    >
      {header}
      {/* A new set of rows (cluster, namespaces, selectors, search) gets a new scroller, from its first row. */}
      <RowsScroller
        key={JSON.stringify([watchKey, search])}
        count={rows.length}
        getItemKey={(index) => rows[index]?.id ?? index}
      >
        {(virtualizer) => state ?? renderGrid(virtualizer)}
      </RowsScroller>
      {addingColumn && (
        <AddColumnDialog
          clusterId={clusterId}
          target={{ group: kind.group, kind: kind.kind, metadataOnly: customOptions?.metadataOnly }}
          objects={items}
          onClose={() => setAddingColumn(false)}
        />
      )}
      {menu && (
        <ActionMenu
          anchor={menu.anchor}
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

/**
 * The scroll container of the table and its virtual list of rows. It stays mounted while its set of rows loads, is
 * empty or fails, so the list never meets a new container; the table gives it a `key` per set of rows (issue #37:
 * a list that outlived its container kept the old scroll offset — an empty band under the header and only the tail
 * of the new rows). A new snapshot of the same set keeps the user's scroll position.
 */
function RowsScroller({
  count,
  getItemKey,
  children,
}: {
  count: number;
  getItemKey: (index: number) => string | number;
  children: (virtualizer: Virtualizer<HTMLDivElement, Element>) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Rows and the header are `--table-row-height` high, measured again when the interface text size changes.
  const rowHeight = useCssLength("--table-row-height", ROW_HEIGHT);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey,
    overscan: 10,
    scrollMargin: rowHeight,
  });
  // The rows were placed at the old height: place them again.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);
  return (
    <div className="rt__scroll" ref={scrollRef}>
      {children(virtualizer)}
    </div>
  );
}

/** The row a navigation key moves to (ARIA practices for rows: ↑ ↓, Home, End, Page Up/Down), `null` for any other key. */
export function rowKeyTarget(key: string, from: number, last: number, page: number): number | null {
  if (last < 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(last, from + 1);
    case "ArrowUp":
      return Math.max(0, from - 1);
    case "Home":
      return 0;
    case "End":
      return last;
    case "PageDown":
      return Math.min(last, from + page);
    case "PageUp":
      return Math.max(0, from - page);
    default:
      return null;
  }
}

function formatValue(value: ReturnType<ColumnDef["value"]>): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function ActionMenu({
  anchor,
  actions,
  onClose,
  onRun,
}: {
  anchor: PopupRect;
  actions: RegisteredAction[];
  onClose: () => void;
  onRun: (action: RegisteredAction) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  usePopup(ref, onClose);
  // Under the "⋮" button (or the pointer), flipped or shifted to stay inside the window (#176).
  usePopupPosition(ref, anchor);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, []);
  return (
    <div ref={ref} className="rt-menu" role="menu" aria-label={t("resources:table.actions")}>
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
              {renderIcon(action.icon)}
            </span>
            {actionLabel(action, t)}
          </button>
        ))
      )}
    </div>
  );
}

/**
 * The "Columns" button of the header: a checkbox per column (when the caller lets columns be hidden; the last shown
 * column cannot be hidden) and "Reset column widths".
 */
function ColumnsMenu({
  columns,
  hidden,
  onChange,
  widthsCustomized,
  onResetWidths,
  custom,
  onAddCustom,
  onRemoveCustom,
  onKeepCustom,
  canRemoveView,
}: {
  columns: ColumnDef[];
  hidden: readonly string[];
  onChange?: (hidden: string[]) => void;
  widthsCustomized: boolean;
  onResetWidths: () => void;
  /** Custom columns shown (#214); with `onAddCustom` the menu offers "Add column…". */
  custom?: readonly ShownColumn[];
  onAddCustom?: () => void;
  onRemoveCustom?: (column: ShownColumn) => void;
  onKeepCustom?: (column: ShownColumn) => void;
  /** Whether a saved view's columns can be removed (or kept) here. */
  canRemoveView?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  usePopup(ref, () => setOpen(false), open);
  // Under the button, lined up with its right edge; flipped or shifted to stay inside the window.
  usePopupPosition(menuRef, buttonRef, { open, align: "end", gap: 4 });
  const shownCount = columns.filter((c) => !hidden.includes(c.id)).length;
  const label = t("views:table.columns");
  return (
    <div className="rt-columns" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="columns" />
      </button>
      {open && (
        <div ref={menuRef} className="rt-menu rt-columns__menu" role="menu" aria-label={label}>
          {onChange && columns.map((c) => {
            const shown = !hidden.includes(c.id);
            const name = c.titleKey ? t(c.titleKey) : (c.title ?? c.id);
            return (
              <label key={c.id} className="rt-menu__item rt-columns__item" role="menuitemcheckbox" aria-checked={shown}>
                <Checkbox
                  checked={shown}
                  disabled={shown && shownCount <= 1}
                  onChange={() =>
                    onChange(shown ? [...hidden, c.id] : hidden.filter((id) => id !== c.id))
                  }
                />
                {name}
              </label>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className={`rt-menu__item${onChange ? " rt-columns__reset" : ""}`}
            disabled={!widthsCustomized}
            onClick={() => {
              onResetWidths();
              setOpen(false);
            }}
          >
            {t("resources:table.resetWidths")}
          </button>
          {custom && custom.length > 0 && (
            <div className="rt-columns__custom" role="group" aria-label={t("customcolumns:menu.custom")}>
              <div className="rt-columns__heading" aria-hidden>
                {t("customcolumns:menu.custom")}
              </div>
              {custom.map((column) => {
                const name = column.spec.title || column.spec.path;
                const removable = column.scope !== "view" || canRemoveView;
                return (
                  <div key={column.id} className="rt-columns__custom-row">
                    <span className="rt-columns__custom-name" title={column.spec.path}>
                      {name}
                    </span>
                    <span className="rt-columns__custom-scope">{t(`customcolumns:menu.${SCOPE_KEYS[column.scope]}`)}</span>
                    {column.scope === "view" && canRemoveView && onKeepCustom && (
                      <button
                        type="button"
                        role="menuitem"
                        className="icon-btn icon-btn--small"
                        aria-label={t("customcolumns:menu.keep", { name })}
                        title={t("customcolumns:menu.keep", { name })}
                        onClick={() => onKeepCustom(column)}
                      >
                        <Icon name="pin" size={12} />
                      </button>
                    )}
                    {removable && onRemoveCustom && (
                      <button
                        type="button"
                        role="menuitem"
                        className="icon-btn icon-btn--small"
                        aria-label={t("customcolumns:menu.remove", { name })}
                        title={t("customcolumns:menu.remove", { name })}
                        onClick={() => onRemoveCustom(column)}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {onAddCustom && (
            <button
              type="button"
              role="menuitem"
              className={`rt-menu__item${custom && custom.length > 0 ? "" : " rt-columns__reset"}`}
              onClick={() => {
                setOpen(false);
                onAddCustom();
              }}
            >
              <span className="rt-menu__icon" aria-hidden>
                <Icon name="add" size={14} />
              </span>
              {t("customcolumns:menu.add")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SCOPE_KEYS = { cluster: "scopeCluster", all: "scopeAll", view: "scopeView" } as const;

/** Current time, refreshed every `ms` (ages in the table tick). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
