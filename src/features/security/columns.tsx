// Columns of the Trivy report tables: the scanned object, the container and image of image reports, and the
// operator's summary counts (or a compliance report's pass/fail, an SBOM's component count).
import type { KubeObject } from "../../api";
import { ageColumn, nameColumn, namespaceColumn, status, type ColumnDef } from "../../resources";
import { componentsCount, countsOf, imageOf, targetOf, type Counts, type TrivyKind } from "./trivy";

const { get, num, str } = status;

const col = (id: string, value: ColumnDef["value"], options: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  titleKey: `security:trivy.columns.${id}`,
  value,
  ...options,
});

const resourceColumn = col(
  "resource",
  (o) => {
    const target = targetOf(o);
    return target ? `${target.kind}/${target.name}` : undefined;
  },
  { width: "minmax(160px, 2fr)" },
);

const containerColumn = col("container", (o) => targetOf(o)?.container, { width: "minmax(100px, 1fr)" });

const imageColumn = col("image", imageOf, {
  width: "minmax(160px, 2fr)",
  render: (o) => {
    const image = imageOf(o);
    return image ? <span title={image}>{image}</span> : null;
  },
});

function countColumn(id: keyof Counts, tone: "danger" | "warning" | "muted"): ColumnDef {
  return col(id, (o: KubeObject) => countsOf(o)[id], {
    width: "80px",
    render: (o) => {
      const n = countsOf(o)[id];
      return <span className={n > 0 ? `rt-status rt-status--${tone}` : "rt-status rt-status--muted"}>{n}</span>;
    },
  });
}

const severityColumns = [
  countColumn("critical", "danger"),
  countColumn("high", "danger"),
  countColumn("medium", "warning"),
  countColumn("low", "muted"),
];

const titleColumn = col("title", (o) => str(get(o, "spec", "compliance", "title")) ?? str(get(o, "spec", "compliance", "id")), {
  width: "minmax(180px, 3fr)",
});
const passColumn = col("pass", (o) => num(get(o, "status", "summary", "passCount")), { width: "80px" });
const failColumn = col("fail", (o) => num(get(o, "status", "summary", "failCount")), {
  width: "80px",
  render: (o) => {
    const n = num(get(o, "status", "summary", "failCount"));
    return n === undefined ? null : <span className={n > 0 ? "rt-status rt-status--danger" : "rt-status rt-status--success"}>{n}</span>;
  },
});
const componentsColumn = col("components", componentsCount, { width: "110px" });

export function trivyColumns({ shape, namespaced }: TrivyKind): ColumnDef[] {
  const head = [nameColumn, ...(namespaced ? [namespaceColumn] : [])];
  switch (shape) {
    case "vulnerabilities":
      return [...head, resourceColumn, containerColumn, imageColumn, ...severityColumns, ageColumn];
    case "secrets":
      return [...head, resourceColumn, containerColumn, imageColumn, ...severityColumns, ageColumn];
    case "checks":
      return [...head, resourceColumn, ...severityColumns, ageColumn];
    case "compliance":
      return [...head, titleColumn, passColumn, failColumn, ageColumn];
    case "sbom":
      return [...head, resourceColumn, containerColumn, imageColumn, componentsColumn, ageColumn];
  }
}
