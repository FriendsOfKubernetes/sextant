import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDocs, SECTIONS } from "./check-extension-docs.mjs";

const manifest = {
  id: "sextant.demo",
  version: "1.2.0",
  contributes: {
    pages: [{ id: "overview", section: "demo", sectionTitle: "Demo" }],
    problems: [{ id: "broken" }],
    commands: [{ id: "status" }],
  },
};
const readme = ["# Demo", "", "The `overview` page in `demo`.", ...SECTIONS.map((s) => `## ${s}\n\nNone.`), "`broken` and `status`."].join("\n");
const index = "| Extension | Folder | Version |\n|---|---|---|\n| Demo (`sextant.demo`) | demo/ | 1.2.0 | x |";
const good = { name: "demo", manifest, readme, changelog: "# Changes\n\n## 1.2.0 — unreleased\n", index };

test("documents that follow the structure pass", () => {
  assert.deepEqual(checkDocs(good), []);
});

test("a manifest id the README does not name is reported", () => {
  const errors = checkDocs({ ...good, manifest: { ...manifest, contributes: { ...manifest.contributes, metricQueries: [{ id: "pgs" }] } } });
  assert.deepEqual(errors, ["extensions/demo/README.md does not name `pgs` of the manifest"]);
});

test("a missing or misplaced section is reported", () => {
  assert.match(checkDocs({ ...good, readme: readme.replace("## Troubleshooting", "## Help") }).join("\n"), /no section "## Troubleshooting"/);
  const swapped = readme.replace("## Problems", "## X").replace("## Metrics", "## Problems").replace("## X", "## Metrics");
  assert.match(checkDocs({ ...good, readme: swapped }).join("\n"), /out of order/);
});

test("a changelog without the manifest's version, missing files and a stale index are reported", () => {
  assert.deepEqual(checkDocs({ ...good, changelog: "## 1.1.0 — 2026-10-31\n" }), ['extensions/demo/CHANGELOG.md has no section "## 1.2.0"']);
  assert.deepEqual(checkDocs({ ...good, readme: null, changelog: null }), [
    "extensions/demo/README.md is missing",
    "extensions/demo/CHANGELOG.md is missing",
  ]);
  assert.deepEqual(checkDocs({ ...good, index: index.replace("1.2.0", "1.1.1") }), [
    "extensions/README.md lists `sextant.demo` without its version 1.2.0",
  ]);
});
