// Column builders shared by the kind descriptions (src/resources/kinds/*) and the generic CR description.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../api";
import { useAppStore } from "../app/store";
import { Age, ageParts } from "../components";
import { kindFromApiVersion } from "./refs";
import type { ColumnDef } from "./registry";
import { createdAt, labelPairs, sortStatuses, statusTone, type OwnerRef, type Tone } from "./status";

/** A column with an i18n header `resources:columns.<id>`. */
export function column(
  id: string,
  value: ColumnDef["value"],
  options: Partial<Omit<ColumnDef, "id" | "value">> = {},
): ColumnDef {
  return { id, titleKey: `resources:columns.${id}`, value, ...options };
}

export const nameColumn: ColumnDef = column("name", (o) => o.metadata?.name, {
  width: "minmax(180px, 3fr)",
  render: (o) => <span className="rt-name">{o.metadata?.name}</span>,
});

export const namespaceColumn: ColumnDef = column("namespace", (o) => o.metadata?.namespace, {
  width: "minmax(110px, 1.2fr)",
});

/** Sorting ascending puts the youngest first, like Lens. */
export const ageColumn: ColumnDef = column(
  "age",
  (o) => {
    const t = createdAt(o);
    return t === undefined ? undefined : -t;
  },
  {
    width: "70px",
    render: (o, ctx) => <Age timestamp={o.metadata?.creationTimestamp as string | undefined} now={ctx.now} />,
    // The search matches the age as the cell shows it ("5m"), as of the table's clock.
    searchText: (o, ctx) => {
      const t = createdAt(o);
      if (t === undefined) return undefined;
      const { unit, count } = ageParts(ctx.now - t);
      return ctx.t(`common:age.${unit}`, { count });
    },
    searchTextTimed: true,
  },
);

/**
 * `searchText` of a column that draws the time `at(obj)` as an age ("5m", as the age column does): the search matches
 * the age as shown, as of the table's clock. Spread into the column's options.
 */
export function ageSearchText(
  at: (obj: KubeObject) => string | undefined,
): Pick<ColumnDef, "searchText" | "searchTextTimed"> {
  return {
    searchText: (o, ctx) => {
      const time = at(o);
      const ms = time ? Date.parse(time) : NaN;
      if (Number.isNaN(ms)) return undefined;
      const { unit, count } = ageParts(ctx.now - ms);
      return ctx.t(`common:age.${unit}`, { count });
    },
    searchTextTimed: true,
  };
}

export const labelsColumn: ColumnDef = column("labels", (o) => labelPairs(o).join(", "), {
  width: "minmax(160px, 2fr)",
  sortable: false,
  render: (o) => <Labels values={labelPairs(o)} />,
});

/** Name (+ namespace when namespaced) … `rest` … Age. */
export function standardColumns(namespaced: boolean, ...rest: ColumnDef[]): ColumnDef[] {
  return [nameColumn, ...(namespaced ? [namespaceColumn] : []), ...rest, ageColumn];
}

export function Labels({ values }: { values: string[] }) {
  return (
    <span className="rt-labels">
      {values.map((v) => (
        <span key={v} className="rt-label">
          {v}
        </span>
      ))}
    </span>
  );
}

/** A status word colored by its meaning (Running → green, Pending → yellow, Failed → red). */
export function StatusText({ value, tone }: { value: string | undefined; tone?: Tone }) {
  if (!value) return null;
  return <span className={`rt-status rt-status--${tone ?? statusTone(value)}`}>{value}</span>;
}

/**
 * Several status words, e.g. conditions, in one fixed order (`sortStatuses`: problems first, then by name), so rows
 * with the same set read the same whatever order the API reported it in.
 */
export function StatusList({ values, tone = statusTone }: { values: string[]; tone?: (v: string) => Tone }) {
  return (
    <span className="rt-status-list">
      {sortStatuses(values, tone).map((v) => (
        <StatusText key={v} value={v} tone={tone(v)} />
      ))}
    </span>
  );
}

/**
 * A column of several status words (`StatusList`); its text (sorting, copying, the palette's status) has them in the
 * same order as the cell.
 */
export function statusListColumn(
  id: string,
  values: (o: KubeObject) => string[],
  { width = "minmax(140px, 1.5fr)", tone = statusTone }: { width?: string; tone?: (v: string) => Tone } = {},
): ColumnDef {
  return column(id, (o) => sortStatuses(values(o), tone).join(" "), {
    width,
    render: (o) => <StatusList values={values(o)} tone={tone} />,
  });
}

export function statusColumn(id: string, value: (o: KubeObject) => string | undefined, width = "110px"): ColumnDef {
  return column(id, value, { width, render: (o) => <StatusText value={value(o)} /> });
}

/** A link that opens the details of another object (owner, node, …) instead of the clicked row. */
export function ObjectLink({
  target,
  namespace,
  children,
}: {
  target: OwnerRef;
  /** Namespace of the target; `null` for cluster-scoped objects. */
  namespace: string | null;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  return (
    <button
      type="button"
      className="rt-link"
      aria-label={t("resources:table.openObject", { kind: target.kind, name: target.name })}
      onClick={(e) => {
        e.stopPropagation();
        openDetails({ kind: kindFromApiVersion(target.apiVersion, target.kind), namespace, name: target.name });
      }}
    >
      {children ?? target.kind}
    </button>
  );
}
