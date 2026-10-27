// Columns of the node's pod tables: CPU and memory usage from the node's own usage poll (the Pods table's columns read
// the selected namespaces' poll, which may not cover a node's pods), and each pod's requests and limits.
import type { TFunction } from "i18next";
import type { ClusterId, KubeObject, PodUsage } from "../../api";
import type { ColumnDef } from "../../resources";
import { formatBytes, formatCpu, UnavailableCell } from "../metrics";
import { podResourceAmounts, type ResourceAmounts } from "../metrics/requests";
import { usageOf } from "./model";

type Resource = "cpu" | "memory";
const FORMAT: Record<Resource, (v: number) => string> = { cpu: formatCpu, memory: formatBytes };

/** The usage columns `cpu` and `memory` (the ids of the metrics feature's, so they take their place). */
export function usageColumns(
  clusterId: ClusterId,
  usage: ReadonlyMap<string, PodUsage> | null,
  unavailable: boolean,
  width: { cpu: string; memory: string } = { cpu: "80px", memory: "90px" },
): ColumnDef[] {
  const column = (resource: Resource): ColumnDef => {
    const read = (o: KubeObject) => {
      const u = usageOf(usage, o);
      return u === undefined ? undefined : resource === "cpu" ? u.cpuMillicores : u.memoryBytes;
    };
    return {
      id: resource,
      titleKey: `metrics:columns.${resource}`,
      width: width[resource],
      value: read,
      searchText: (o) => {
        const v = read(o);
        return v === undefined ? undefined : FORMAT[resource](v);
      },
      render: (o) => {
        if (unavailable) return <UnavailableCell clusterId={clusterId} />;
        const v = read(o);
        return v === undefined ? null : <span className="mx-value">{FORMAT[resource](v)}</span>;
      },
    };
  };
  return [column("cpu"), column("memory")];
}

/** A pod's request of `resource` as the cell tells it: the sum, and on how many containers it is set when not on all. */
function requestText(a: ResourceAmounts, format: (v: number) => string, t: TFunction): string | undefined {
  if (a.request === undefined) return undefined;
  if (a.requestSetOn === a.containers) return format(a.request);
  return t("nodepods:resources.partial", {
    value: format(a.request),
    note: t("metrics:requests.requestSetOn", { set: a.requestSetOn, count: a.containers }),
  });
}

/** A pod's limit: the sum when every container sets one, else "no limit" (ADR-0037). */
function limitText(a: ResourceAmounts, format: (v: number) => string, t: TFunction): string | undefined {
  if (a.containers === 0) return undefined;
  if (a.limit !== undefined && a.limitSetOn === a.containers) return format(a.limit);
  return t("metrics:requests.noLimit");
}

/** The requests and limits columns of `resource`. */
export function amountColumns(resource: Resource, t: TFunction): ColumnDef[] {
  const format = FORMAT[resource];
  const amounts = (o: KubeObject) => podResourceAmounts(o)[resource];
  const request: ColumnDef = {
    id: `${resource}Request`,
    titleKey: `nodepods:columns.${resource}Request`,
    width: "minmax(90px, 1fr)",
    value: (o) => amounts(o).request,
    searchText: (o) => requestText(amounts(o), format, t),
    render: (o) => requestText(amounts(o), format, t),
  };
  const limit: ColumnDef = {
    id: `${resource}Limit`,
    titleKey: `nodepods:columns.${resource}Limit`,
    width: "minmax(90px, 1fr)",
    value: (o) => {
      const a = amounts(o);
      return a.limitSetOn === a.containers ? a.limit : undefined;
    },
    searchText: (o) => limitText(amounts(o), format, t),
    render: (o) => limitText(amounts(o), format, t),
  };
  return [request, limit];
}
