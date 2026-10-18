// Numbers of the metrics feature: Kubernetes quantities in, short texts out ("250m", "34.0MiB", "12%"). Fractions use
// the UI language's decimal sign ("1,50GiB" in German); units stay the Kubernetes ones.
import { formatNumber } from "../../i18n";

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

/** CPU like `kubectl top`: millicores, "0m", "250m", "1250m". */
export function formatCpu(millicores: number): string {
  return `${Math.round(millicores)}m`;
}

/** CPU in cores for chart axes: "0.25", "1.5", "12". */
export function formatCores(millicores: number): string {
  const cores = millicores / 1000;
  if (cores === 0) return "0";
  if (cores < 0.1) return formatNumber(cores, 3);
  if (cores < 10) return formatNumber(cores, 2);
  return formatNumber(cores, 0);
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

export function formatCount(value: number): string {
  return String(Math.round(value));
}

/** `part` of `whole` in percent, 0–100 (rounded); `undefined` without a whole. */
export function percentOf(part: number, whole: number | undefined): number | undefined {
  if (!whole || whole <= 0) return undefined;
  return Math.min(100, Math.max(0, Math.round((part / whole) * 100)));
}
