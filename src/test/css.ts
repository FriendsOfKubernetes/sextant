// CSS for tests: the test run does not process CSS (`css: false`), so a test that pins a layout rule reads the file.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The declarations of the first rule in `path` (from the repository root) whose selector is exactly `selector`. */
export function cssRule(path: string, selector: string): Record<string, string> {
  const css = readFileSync(join(process.cwd(), path), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const block = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(([, sel]) => sel!.trim() === selector);
  if (!block) throw new Error(`no rule for ${selector} in ${path}`);
  return Object.fromEntries(
    block[2]!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

/** What a details tab's root sets so it pads itself (the tab body has no padding) and wraps long names. */
export const DETAILS_TAB_ROOT = { "min-width": "0", padding: "8px 16px 16px", "overflow-wrap": "break-word" } as const;
