// Building blocks of the details sections. Values are prepared outside JSX (the i18n lint rule forbids string
// literals inside JSX): a view builds `FieldRow`s with the helpers below (`link`, `chips`, `table`, …), each of
// which returns `null` when there is nothing to show, and renders them with <Fields rows={…} />.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { ObjectLink, StatusText, status } from "../../resources";
import type { Tone } from "../../resources/status";
import "./details.css";

const { arr, get, record, str } = status;

/** A titled block inside a section. `title` is already translated. */
export function Block({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="dt-block">
      {(title || actions) && (
        <div className="dt-block__head">
          {title && <h3 className="dt-block__title">{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

/** `[labelKey under details:fields, value]`; rows with an empty value are left out. */
export type FieldRow = readonly [labelKey: string, value: ReactNode];

function isEmpty(value: ReactNode): boolean {
  return value === null || value === undefined || value === false || value === "";
}

export function Fields({ rows }: { rows: FieldRow[] }) {
  const { t } = useTranslation();
  const shown = rows.filter(([, value]) => !isEmpty(value));
  if (shown.length === 0) return null;
  return (
    <dl className="dt-fields">
      {shown.map(([labelKey, value]) => (
        <FieldRowView key={labelKey} label={t(`details:fields.${labelKey}`)} value={value} />
      ))}
    </dl>
  );
}

function FieldRowView({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="dt-fields__label">{label}</dt>
      <dd className="dt-fields__value">{value}</dd>
    </>
  );
}

function Chips({ values }: { values: string[] }) {
  return (
    <span className="dt-chips">
      {values.map((v, i) => (
        <span key={`${i}:${v}`} className="dt-chip">
          {v}
        </span>
      ))}
    </span>
  );
}

/** Chips of strings; `null` when there are none. */
export function chips(values: string[]): ReactNode {
  const list = values.filter(Boolean);
  return list.length > 0 ? <Chips values={list} /> : null;
}

/** `key=value` chips of a string map (labels, selectors, node selectors). */
export function mapChips(value: unknown): ReactNode {
  return chips(Object.entries(record(value)).map(([k, v]) => `${k}=${String(v)}`));
}

/** Selector of a workload/PDB/…: `matchLabels` and `matchExpressions` as chips. */
export function labelSelector(selector: unknown): ReactNode {
  const labels = Object.entries(record(get(selector, "matchLabels"))).map(([k, v]) => `${k}=${String(v)}`);
  const expressions = arr(get(selector, "matchExpressions")).map((e) => {
    const values = arr(get(e, "values")).map(String).join(", ");
    return `${str(get(e, "key")) ?? ""} ${str(get(e, "operator")) ?? ""}${values ? ` (${values})` : ""}`;
  });
  return chips([...labels, ...expressions]);
}

export interface TypeRef {
  apiVersion: string;
  kind: string;
}

export const KINDS = {
  node: { apiVersion: "v1", kind: "Node" },
  namespace: { apiVersion: "v1", kind: "Namespace" },
  pod: { apiVersion: "v1", kind: "Pod" },
  service: { apiVersion: "v1", kind: "Service" },
  endpoints: { apiVersion: "v1", kind: "Endpoints" },
  configMap: { apiVersion: "v1", kind: "ConfigMap" },
  secret: { apiVersion: "v1", kind: "Secret" },
  serviceAccount: { apiVersion: "v1", kind: "ServiceAccount" },
  pvc: { apiVersion: "v1", kind: "PersistentVolumeClaim" },
  pv: { apiVersion: "v1", kind: "PersistentVolume" },
  storageClass: { apiVersion: "storage.k8s.io/v1", kind: "StorageClass" },
  priorityClass: { apiVersion: "scheduling.k8s.io/v1", kind: "PriorityClass" },
  ingressClass: { apiVersion: "networking.k8s.io/v1", kind: "IngressClass" },
  job: { apiVersion: "batch/v1", kind: "Job" },
} satisfies Record<string, TypeRef>;

/** A link opening the details of another object, labelled with its name (or `label`); `null` without a name. */
export function link(type: TypeRef, name: string | undefined, namespace: string | null = null, label?: string): ReactNode {
  if (!name) return null;
  return (
    <ObjectLink key={`${type.kind}/${namespace ?? ""}/${name}`} target={{ ...type, name }} namespace={namespace}>
      {label ?? name}
    </ObjectLink>
  );
}

/** Several nodes in a wrapping row; `null` when all are empty. */
export function inline(nodes: ReactNode[]): ReactNode {
  const list = nodes.filter((n) => !isEmpty(n));
  return list.length > 0 ? <span className="dt-links">{list}</span> : null;
}

export function statusText(value: string | undefined, tone?: Tone): ReactNode {
  return value ? <StatusText value={value} tone={tone} /> : null;
}

export function pre(value: string | undefined): ReactNode {
  return value === undefined ? null : <pre className="dt-pre">{value}</pre>;
}

export function muted(value: string | undefined): ReactNode {
  return value ? <span className="dt-muted">{value}</span> : null;
}

/** A small table; `headers` are already translated; `null` without rows. */
export function table(headers: string[], rows: ReactNode[][]): ReactNode {
  if (rows.length === 0) return null;
  return (
    <table className="dt-table">
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i}>
            {cells.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Namespace of an object (`null` for cluster-scoped ones). */
export function nsOf(obj: KubeObject): string | null {
  return obj.metadata?.namespace ?? null;
}

/** Plain text of a value from an object (numbers, booleans and strings; nothing for the rest). */
export function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** Strings of a string array field. */
export function strings(value: unknown): string[] {
  return arr(value).filter((v): v is string => typeof v === "string");
}

/** Tolerations as `key=value:Effect` (or `key:Effect`, `Exists`). */
export function tolerations(value: unknown): string[] {
  return arr(value).map((tol) => {
    const key = str(get(tol, "key"));
    const op = str(get(tol, "operator"));
    const val = str(get(tol, "value"));
    const effect = str(get(tol, "effect"));
    const seconds = get(tol, "tolerationSeconds");
    let s = key ? (op === "Exists" ? key : `${key}=${val ?? ""}`) : (op ?? "Exists");
    if (effect) s += `:${effect}`;
    if (typeof seconds === "number") s += ` (${seconds}s)`;
    return s;
  });
}
