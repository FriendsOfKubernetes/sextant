// Kubernetes quantities in, short texts out ("587m", "250MiB"): Sextant's metrics formatting (`parseQuantity`,
// `formatCpu`, `formatBytes`) and the autoscaling views' `formatAmount`, ported. Fractions use the UI language's
// decimal sign ("1,50GiB" in German); units stay the Kubernetes ones.
import { i18n } from "./i18n";

const SUFFIXES: [string, number][] = [
  ["Ki", 2 ** 10],
  ["Mi", 2 ** 20],
  ["Gi", 2 ** 30],
  ["Ti", 2 ** 40],
  ["Pi", 2 ** 50],
  ["Ei", 2 ** 60],
  ["n", 1e-9],
  ["u", 1e-6],
  ["m", 1e-3],
  ["k", 1e3],
  ["M", 1e6],
  ["G", 1e9],
  ["T", 1e12],
  ["P", 1e15],
  ["E", 1e18],
];

/** A Kubernetes quantity ("4", "250m", "16Gi") in base units (cores, bytes); `undefined` if it does not parse. */
export function parseQuantity(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const text = value.trim();
  for (const [suffix, factor] of SUFFIXES) {
    if (text.endsWith(suffix)) {
      const n = Number(text.slice(0, -suffix.length));
      if (text.length > suffix.length && Number.isFinite(n)) return n * factor;
    }
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** A number in the UI language with exactly `digits` fraction digits, without grouping (Sextant's `formatNumber`). */
export function formatNumber(value: number, digits = 0): string {
  return i18n().formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Bytes in binary units: "512B", "34.0MiB", "1.50GiB", "120GiB". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}${BYTE_UNITS[0]}`;
  const digits = Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0;
  return `${formatNumber(value, digits)}${BYTE_UNITS[unit]}`;
}

/** A quantity in the units people read for `resource` (base units in): cores or millicores for cpu, binary bytes for memory. */
export function formatAmount(resource: string, value: number): string {
  if (resource === "cpu") {
    // Whole cores as Kubernetes writes them ("4"), anything else in millicores ("3920m").
    const milli = Math.round(value * 1000);
    return milli % 1000 === 0 && milli > 0 ? String(milli / 1000) : `${Math.round(milli)}m`;
  }
  if (resource === "memory" || resource.endsWith("storage")) return formatBytes(value);
  return formatNumber(value, Number.isInteger(value) ? 0 : 2);
}
