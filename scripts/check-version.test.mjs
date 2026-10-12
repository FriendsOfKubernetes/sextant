// Tests of scripts/check-version.mjs (run by `npm run check`: `node --test scripts/check-version.test.mjs`).
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { versionProblems } from "./check-version.mjs";

const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A copy of the project's version-carrying files, every one at `version` unless `override` says otherwise. */
function project(version, override = {}) {
  const v = (file) => override[file] ?? version;
  const root = mkdtempSync(join(tmpdir(), "sextant-version-"));
  dirs.push(root);
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(
    join(root, "Cargo.toml"),
    `[workspace]\nmembers = ["crates/sextant-core", "src-tauri"]\n\n[workspace.package]\nversion = "${v("Cargo.toml")}"\nedition = "2024"\n\n[workspace.dependencies]\nserde = { version = "1" }\n`,
  );
  writeFileSync(
    join(root, "Cargo.lock"),
    `version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "sextant"\nversion = "${v("Cargo.lock sextant")}"\n\n[[package]]\nname = "sextant-core"\nversion = "${v("Cargo.lock sextant-core")}"\n`,
  );
  writeFileSync(
    join(root, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ productName: "Sextant", version: v("src-tauri/tauri.conf.json") }, null, 2),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sextant", version: v("package.json") }, null, 2));
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify(
      {
        name: "sextant",
        version: v("package-lock.json"),
        packages: { "": { name: "sextant", version: v('package-lock.json packages[""]') } },
      },
      null,
      2,
    ),
  );
  return root;
}

test("matching versions pass", () => {
  assert.deepEqual(versionProblems(project("0.2.0")), []);
});

for (const file of [
  "Cargo.toml",
  "Cargo.lock sextant",
  "Cargo.lock sextant-core",
  "src-tauri/tauri.conf.json",
  "package.json",
  "package-lock.json",
  'package-lock.json packages[""]',
]) {
  test(`a different version in ${file} is reported`, () => {
    const problems = versionProblems(project("0.2.0", { [file]: "0.2.1" }));
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /0\.2\.1/);
    assert.ok(problems[0].includes(file), problems[0]);
  });
}

test("the tag must name the same version", () => {
  const root = project("0.2.0");
  assert.deepEqual(versionProblems(root, "v0.2.0"), []);
  assert.equal(versionProblems(root, "v0.2.1").length, 1);
  assert.match(versionProblems(root, "v0.2.1")[0], /v0\.2\.1.*0\.2\.0|0\.2\.0.*v0\.2\.1/);
  assert.equal(versionProblems(root, "0.2.0").length, 1, "a tag without the leading v is not a release tag");
});

test("a missing version is reported, not taken as a match", () => {
  const root = project("0.2.0");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sextant" }));
  const problems = versionProblems(root);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("package.json"));
});
