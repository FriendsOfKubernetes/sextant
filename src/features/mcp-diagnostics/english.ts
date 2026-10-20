// Answers for agents are in English whatever the window's language (the MCP tools speak English): phrases are
// translated with English texts, which are always loaded (`src/i18n`), and lists are joined with ", ".
import i18n from "i18next";

export type T = (key: string, options?: Record<string, unknown>) => string;

/** English `t`. */
export const en: T = (key, options) => i18n.getFixedT("en")(key, options as never) as unknown as string;

/** Items joined the English way. */
export const list = (items: readonly string[]) => items.join(", ");

/** A time (ms) as RFC 3339; `undefined` for none. */
export function iso(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}
