// Description of a kind nobody registered (custom resources): name, namespace, the CRD's printer columns, age.
import type { KindRef, KubeObject, PrinterColumn, ResourceKind } from "../api";
import { Age } from "../components";
import { ageColumn, nameColumn, namespaceColumn } from "./columns";
import { evalJsonPath, formatJsonPathValues } from "./jsonpath";
import type { ColumnDef, ResourceDef } from "./registry";

/** Printer columns with priority 0 (what `kubectl get` shows); the creation timestamp is the standard Age column. */
export function printerColumns(columns: PrinterColumn[]): ColumnDef[] {
  return columns
    .filter((c) => c.priority === 0)
    .filter((c) => c.jsonPath.replace(/[{}$\s]/g, "") !== ".metadata.creationTimestamp")
    .map((c, i) => printerColumn(c, i));
}

function printerColumn(c: PrinterColumn, index: number): ColumnDef {
  const values = (o: KubeObject) => evalJsonPath(o, c.jsonPath);
  const numeric = c.type === "integer" || c.type === "number";
  return {
    id: `printer-${index}-${c.name}`,
    title: c.name,
    width: c.type === "date" ? "80px" : "minmax(90px, 1fr)",
    value: (o) => {
      const v = values(o);
      if (v.length === 0) return undefined;
      if (numeric && v.length === 1 && typeof v[0] === "number") return v[0];
      if (c.type === "date" && v.length === 1 && typeof v[0] === "string") return -Date.parse(v[0]);
      return formatJsonPathValues(v);
    },
    render: (o, ctx) => {
      const v = values(o);
      if (c.type === "date" && v.length === 1 && typeof v[0] === "string") return <Age timestamp={v[0]} now={ctx.now} />;
      return formatJsonPathValues(v);
    },
  };
}

export function genericResourceDef(kind: KindRef, resourceKind: ResourceKind | null): ResourceDef {
  const namespaced = resourceKind?.namespaced ?? true;
  return {
    kind,
    sidebar: null,
    columns: [
      nameColumn,
      ...(namespaced ? [namespaceColumn] : []),
      ...printerColumns(resourceKind?.printerColumns ?? []),
      ageColumn,
    ],
    actions: ["edit", "delete"],
    namespaced,
    title: kind.kind,
  };
}
