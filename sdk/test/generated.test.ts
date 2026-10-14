// The SDK keeps its own copy of the types Sextant generates from Rust (`src/api/generated/`); this test fails as soon
// as the copy differs from what Sextant has now.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { existingFiles, plannedFiles, TARGET_DIR } from "../scripts/sync-types.mjs";

const HINT = "the SDK's copy of src/api/generated/ is out of date: run `npm run sdk:sync-types`";

describe("generated types", () => {
  it("are the same files as Sextant's src/api/generated/", () => {
    const planned = plannedFiles();
    expect(existingFiles(), HINT).toEqual([...planned.keys()]);
    for (const [file, content] of planned) {
      expect(readFileSync(join(TARGET_DIR, ...file.split("/")), "utf8"), `${file}: ${HINT}`).toBe(content);
    }
  });

  it("include the manifest and everything the API speaks", () => {
    const names = [...plannedFiles().keys()];
    for (const name of ["ExtensionManifest.ts", "AccessRule.ts", "WatchUpdate.ts", "serde_json/JsonValue.ts"]) {
      expect(names).toContain(name);
    }
  });
});
