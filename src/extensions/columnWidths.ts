// The widths of an extension's own tables (`ui.table` with an `id`, since Sextant 0.30, #417): kept in
// `AppSettings.columnWidths` under `ext:<extension id>:<table id>` as Sextant's own tables' widths are (the same caps,
// `applyWidthChanges`), written a short while after the last change, and given to the extension's frames in their
// context (`columnWidths`, only the extension's own tables).
import { updateSettings, type AppSettings } from "../api";
import { applyWidthChanges, clampWidth, cleanWidths, SAVE_WIDTHS_DELAY_MS } from "../components/Table/columnWidths";

/** What a table or column id of an extension looks like (`ui.setColumnWidth`). */
export const COLUMN_WIDTH_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** The key of an extension's table among Sextant's saved widths. */
export const extensionTableKey = (extensionId: string, table: string): string => `ext:${extensionId}:${table}`;

const pending = new Map<string, Record<string, number | null>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  const changes = [...pending];
  pending.clear();
  if (changes.length === 0) return;
  void updateSettings((current) => {
    let widths = current.columnWidths ?? {};
    const now = Date.now();
    for (const [key, set] of changes) widths = applyWidthChanges(widths, key, { clear: false, set }, now);
    return { ...current, columnWidths: widths };
  }).catch(() => undefined);
}

/** Keeps one column's width (`null`: back to its own width) of the extension's table; saved after a pause. */
export function saveExtensionColumnWidth(extensionId: string, table: string, column: string, width: number | null): void {
  const key = extensionTableKey(extensionId, table);
  const set = pending.get(key) ?? {};
  set[column] = width === null ? null : clampWidth(width);
  pending.set(key, set);
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_WIDTHS_DELAY_MS);
}

/** Writes what is waiting now (tests; a window about to go). */
export function flushExtensionColumnWidths(): void {
  if (timer !== null) clearTimeout(timer);
  flush();
}

/** The saved widths of the extension's own tables, by table id (the `ext:<id>:` prefix taken off). */
export function extensionColumnWidths(settings: AppSettings | null | undefined, extensionId: string): Record<string, Record<string, number>> {
  const prefix = extensionTableKey(extensionId, "");
  const out: Record<string, Record<string, number>> = {};
  for (const [key, entry] of Object.entries(settings?.columnWidths ?? {})) {
    if (!key.startsWith(prefix)) continue;
    const table = key.slice(prefix.length);
    const widths = cleanWidths(entry);
    if (COLUMN_WIDTH_ID.test(table) && Object.keys(widths).length > 0) out[table] = { ...widths };
  }
  return out;
}
