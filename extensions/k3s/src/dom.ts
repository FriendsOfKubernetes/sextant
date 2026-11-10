// Small DOM and formatting helpers the views share; the blocks, fields, tables, status words and links are the SDK's
// UI kit (`ui`, ADR-0160).
import { isSextantError, ui, type Sextant } from "@sextant/extension-sdk";
import { i18n, t } from "./i18n";
import type { KindRef } from "./model";

type Child = Node | string | null | undefined | false;

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

/** The date and time in the UI language's default style, as Sextant's `formatDateTime` (`toLocaleString`). */
export const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
};

/** An RFC 3339 time as a date and time; nothing for no time. */
export function dateTime(time: string | undefined): HTMLElement | null {
  if (!time) return null;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return element("time", { dateTime: time, textContent: time });
  return element("time", { dateTime: time, textContent: i18n().formatDateTime(ms, DATE_TIME) });
}

/** helm-controller's or etcd's words about a failure, or what a state means (a coloured bar on its left). */
export const note = (text: string, tone: "warning" | "danger"): HTMLElement => element("p", { className: `k3s-note k3s-note--${tone}`, textContent: text });

/** A muted remark. */
export const remark = (text: string): HTMLElement => element("p", { className: "k3s-muted", textContent: text });

/** Text from the cluster longer than this is cut in a details view (the YAML section has all of it). */
export const MAX_TEXT = 20_000;
export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** Kubernetes' quantity suffixes, as Sextant's `parseQuantity` reads them. */
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
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** A Kubernetes quantity in base units; `undefined` if it does not parse (Sextant's `parseQuantity`). */
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

/** Bytes as Sextant writes them ("12.0MiB"), the fraction in the UI language (Sextant's `formatBytes`). */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)}${BYTE_UNITS[0]}`;
  const digits = Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0;
  return `${i18n().formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })}${BYTE_UNITS[unit]}`;
}

/** A snapshot's size: a byte count as bytes, any other quantity as it is. */
export function sizeText(size: string | undefined): string {
  if (!size) return "";
  const bytes = parseQuantity(size);
  return bytes === undefined ? size : formatBytes(bytes);
}

/** A link to an object's details in Sextant's panel, named `text` (its name by default). */
export function link(sextant: Sextant, kind: KindRef, name: string | undefined, namespace: string | null, text?: string): HTMLElement | null {
  if (!name) return null;
  const button = ui.objectLink(sextant, { kind, namespace, name }, text ?? name);
  button.setAttribute("aria-label", t("openObject", { kind: kind.kind, name }));
  return button;
}

export function errorText(err: unknown): string {
  if (isSextantError(err, "denied")) return t("error.denied", { message: err.message });
  if (isSextantError(err, "forbidden")) return t("error.forbidden", { message: err.message });
  return err instanceof Error ? err.message : String(err);
}
