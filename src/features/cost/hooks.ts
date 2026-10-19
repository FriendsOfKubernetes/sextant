// Cost reports through the metrics feature's shared pollers: one `cost_allocation` call per (cluster, query) however
// many views show it, refreshed every `COST_POLL_MS` while shown and stopped when the last one unmounts.
import type { ClusterId, CostQuery, CostReport } from "../../api";
import { api } from "../../api";
import { usePolled, type Polled } from "../metrics/hooks";

/** Costs change slowly (OpenCost itself recomputes them every few minutes). */
export const COST_POLL_MS = 10 * 60_000;

/** The report of `query` (`null`: nothing to ask yet). A new `attempt` asks again at once (Retry). */
export function useCostReport(clusterId: ClusterId, query: CostQuery | null, attempt = 0): Polled<CostReport> {
  const key = query ? `cost|${clusterId}|${JSON.stringify(query)}|${attempt}` : null;
  return usePolled(key, () => api.cost.allocation(clusterId, query!), COST_POLL_MS);
}
