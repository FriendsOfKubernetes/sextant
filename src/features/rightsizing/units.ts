// Rounding of recommended amounts to steps a person would write (10m of CPU, 16Mi of memory) and their Kubernetes
// quantities ("250m", "2", "192Mi", "1Gi"). CPU in millicores, memory in bytes, as in `metrics/requests.ts`.

export const MI = 2 ** 20;
export const GI = 2 ** 30;
/** CPU recommendations are multiples of this many millicores, and never below it. */
export const CPU_STEP_MILLICORES = 10;
/** Memory recommendations are multiples of this many bytes, and never below it. */
export const MEMORY_STEP_BYTES = 16 * MI;

/** Up to the next step (`step` at least); a value already on a step stays. */
function roundUp(value: number, step: number): number {
  if (!Number.isFinite(value) || value <= 0) return step;
  // The epsilon keeps 120.0000001 (float noise of a computed value) at 120.
  return Math.max(step, Math.ceil(value / step - 1e-6) * step);
}

export function roundCpuUp(millicores: number): number {
  return roundUp(millicores, CPU_STEP_MILLICORES);
}

export function roundMemoryUp(bytes: number): number {
  return roundUp(bytes, MEMORY_STEP_BYTES);
}

/** Millicores as a quantity: whole cores as a number ("2"), anything else in millicores ("250m", "1500m"). */
export function cpuQuantity(millicores: number): string {
  const m = Math.round(millicores);
  return m % 1000 === 0 ? String(m / 1000) : `${m}m`;
}

/** Bytes as a quantity: whole GiB as "Gi", whole MiB as "Mi", anything else in bytes. */
export function memoryQuantity(bytes: number): string {
  const b = Math.round(bytes);
  if (b > 0 && b % GI === 0) return `${b / GI}Gi`;
  if (b % MI === 0) return `${b / MI}Mi`;
  return String(b);
}
