// The `resources:` snippet of a recommendation, ready to paste under a container of a pod template. Nothing is
// applied to the cluster: the snippet goes to the clipboard.
import type { Recommendation } from "./recommend";
import { cpuQuantity, memoryQuantity } from "./units";

/** `resources:` with requests (CPU, memory) and limits (memory; CPU only when recommended). */
export function resourcesYaml(rec: Recommendation): string {
  const lines = [
    "resources:",
    "  requests:",
    `    cpu: ${cpuQuantity(rec.cpuRequest)}`,
    `    memory: ${memoryQuantity(rec.memoryRequest)}`,
    "  limits:",
  ];
  if (rec.cpuLimit !== undefined) lines.push(`    cpu: ${cpuQuantity(rec.cpuLimit)}`);
  lines.push(`    memory: ${memoryQuantity(rec.memoryLimit)}`);
  return `${lines.join("\n")}\n`;
}
