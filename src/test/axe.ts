// axe-core in Vitest: runs the accessibility rules over a rendered tree and fails with a readable list.
// jsdom has no layout and no computed colours, so the rules that need them (colour contrast, scrollable regions,
// target size) are off here; contrast is checked from the theme tokens in src/styles/contrast.test.ts instead.
import axe from "axe-core";

const RULES_OFF = ["color-contrast", "color-contrast-enhanced", "scrollable-region-focusable", "target-size"];

/** Violations of `root` (the whole document by default) as `rule-id: target — message` lines. */
export async function axeViolations(root: Element | Document = document): Promise<string[]> {
  const rules = Object.fromEntries(RULES_OFF.map((id) => [id, { enabled: false }]));
  const result = await axe.run(root as Element, {
    rules,
    resultTypes: ["violations"],
    // A page fragment rendered by a test is not a whole document: no <title>/<html lang> or landmark rules.
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  });
  const ignored = new Set(["document-title", "html-has-lang", "landmark-one-main", "page-has-heading-one", "region"]);
  return result.violations
    .filter((v) => !ignored.has(v.id))
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} — ${n.failureSummary?.split("\n").slice(1).join("; ") ?? v.help}`));
}
