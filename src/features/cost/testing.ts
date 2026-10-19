// Test helpers of the cost feature.
import type { CostRow } from "../../api";

/** A cost row with every amount 0; `patch` sets what a test needs. */
export function costRow(patch: Partial<CostRow> = {}): CostRow {
  return {
    name: "shop",
    namespace: "shop",
    controllerKind: null,
    controller: null,
    pod: null,
    node: null,
    cpuCost: 0,
    ramCost: 0,
    pvCost: 0,
    networkCost: 0,
    gpuCost: 0,
    otherCost: 0,
    totalCost: 0,
    cpuCoreHours: 0,
    ramByteHours: 0,
    minutes: 0,
    cpuEfficiency: null,
    ramEfficiency: null,
    totalEfficiency: null,
    ...patch,
  };
}
