// axe-core on the real WebKit page (#186): the vitest helper (src/test/axe.ts) runs in jsdom, which has no layout and
// no computed colours, so colour contrast can only be checked here. The rule set is the vitest one with colour
// contrast turned on; the source of axe is injected into the window with `browser.execute`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { browser } from "@wdio/globals";

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** As in src/test/axe.ts, except `color-contrast`, which the real page can check. */
const RULES_OFF = ["color-contrast-enhanced", "scrollable-region-focusable", "target-size"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const IGNORED = ["document-title", "html-has-lang", "landmark-one-main", "page-has-heading-one", "region"];

export interface AxeFinding {
  rule: string;
  impact: string;
  target: string;
  detail: string;
}

interface RawResult {
  error?: string;
  violations?: {
    id: string;
    impact: string | null;
    help: string;
    nodes: {
      target: unknown[];
      failureSummary?: string;
      any: { data?: Record<string, unknown> | null }[];
    }[];
  }[];
}

/** The contrast data of a `color-contrast` node: colours, ratio, expected ratio and font. */
function contrastDetail(data: Record<string, unknown> | null | undefined): string | null {
  if (!data || data.contrastRatio === undefined) return null;
  return `fg ${String(data.fgColor)} on bg ${String(data.bgColor)}, ratio ${String(data.contrastRatio)} < ${String(
    data.expectedContrastRatio,
  )} (${String(data.fontSize)} ${String(data.fontWeight)})`;
}

/** Runs axe over the whole window and returns its violations (the ignored rules left out). */
export async function axeFindings(): Promise<AxeFinding[]> {
  const loaded = await browser.execute(() => typeof (window as unknown as { axe?: unknown }).axe === "object");
  if (!loaded) await browser.execute(`${AXE_SOURCE}\n;return true;`);
  const rules = Object.fromEntries(RULES_OFF.map((id) => [id, { enabled: false }]));
  // WebDriver's "execute script" waits for a returned promise.
  const result = (await browser.execute(
    (tags: string[], ruleConfig: Record<string, { enabled: boolean }>) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<RawResult> } }).axe;
      return axe
        .run(document, { runOnly: { type: "tag", values: tags }, rules: ruleConfig, resultTypes: ["violations"], iframes: false })
        .then(
          (r): RawResult => ({
            violations: (r.violations ?? []).map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              nodes: v.nodes.map((n) => ({
                target: n.target,
                failureSummary: n.failureSummary,
                any: n.any.map((c) => ({ data: c.data ?? null })),
              })),
            })),
          }),
          (e: unknown): RawResult => ({ error: String(e) }),
        );
    },
    TAGS,
    rules,
  )) as RawResult;
  if (result.error) throw new Error(`axe failed: ${result.error}`);
  return (result.violations ?? [])
    .filter((v) => !IGNORED.includes(v.id))
    .flatMap((v) =>
      v.nodes.map((n) => ({
        rule: v.id,
        impact: v.impact ?? "unknown",
        target: n.target.map(String).join(" "),
        detail:
          contrastDetail(n.any.find((c) => c.data && "contrastRatio" in c.data)?.data) ??
          n.failureSummary?.split("\n").slice(1).join("; ").trim() ??
          v.help,
      })),
    );
}

/** One line per finding: `rule [impact]: target — detail`. */
export function formatFindings(findings: AxeFinding[]): string {
  return findings.map((f) => `${f.rule} [${f.impact}]: ${f.target} — ${f.detail}`).join("\n");
}
