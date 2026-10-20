// Tests of scripts/packaging.mjs and the templates in packaging/ (run by `npm run check`:
// `node --test scripts/packaging.test.mjs`), on the fixture packaging/fixtures/release-v0.19.0.json.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  WINGET_ID,
  appIdentifier,
  assetNames,
  checksumsFromDir,
  checksumsFromRelease,
  isUnbundled,
  renderAll,
  renderTemplate,
  versionOfTag,
} from "./packaging.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "packaging.mjs");
const FIXTURE = join(ROOT, "packaging", "fixtures", "release-v0.19.0.json");
const REPO = "FriendsOfKubernetes/sextant";
const release = JSON.parse(readFileSync(FIXTURE, "utf8"));
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function temp() {
  const dir = mkdtempSync(join(tmpdir(), "sextant-packaging-"));
  dirs.push(dir);
  return dir;
}

function rendered() {
  const { sums } = checksumsFromRelease(release, "0.19.0");
  const files = renderAll({ version: "0.19.0", repo: REPO, identifier: appIdentifier(), releaseDate: "2026-11-02", sums });
  return Object.fromEntries(files.map(({ out, text }) => [out, text]));
}

const assetUrl = (name) => release.assets.find((a) => a.name === name).browser_download_url;
const WINGET_DIR = "winget/manifests/f/FriendsOfKubernetes/Sextant/0.19.0";

test("checksums come from GitHub's digests of the release assets, lowercased", () => {
  const { sums } = checksumsFromRelease(release, "0.19.0");
  assert.equal(sums.dmg, "7c0e895a259027e7f60830b25cd00bedc150dd40ad0dc097cf01a34a129979d8");
  assert.equal(sums.msi, "f28392f25a7c7a75de21e89cdd2640ecaaaf1206d9c0d55bd9a5f73cd9b9db02");
  assert.equal(sums.zip, "2f1286c6a3ea643fc659734b283915b4a451d49ee8cc239ce86b280850899c38");
});

test("an asset without a digest is reported as unknown, a missing or unfinished asset is an error", () => {
  const strip = (name) => ({ ...release, assets: release.assets.map((a) => (a.name === name ? { ...a, digest: undefined } : a)) });
  assert.equal(checksumsFromRelease(strip(assetNames("0.19.0").zip), "0.19.0").sums.zip, null);
  const without = { ...release, assets: release.assets.filter((a) => a.name !== assetNames("0.19.0").msi) };
  assert.throws(() => checksumsFromRelease(without, "0.19.0"), /no asset Sextant_0\.19\.0_x64_en-US\.msi/);
  const starter = { ...release, assets: release.assets.map((a) => ({ ...a, state: "starter" })) };
  assert.throws(() => checksumsFromRelease(starter, "0.19.0"), /is starter/);
});

test("tags and template values are checked", () => {
  assert.equal(versionOfTag("v1.2.3"), "1.2.3");
  assert.equal(versionOfTag("v1.2.3-rc.1"), "1.2.3-rc.1");
  for (const bad of ["1.2.3", "v1.2", "v1.2.3\n", 'v1.2.3"', undefined]) assert.throws(() => versionOfTag(bad));
  assert.equal(renderTemplate("a {{x}} b", { x: "1" }), "a 1 b");
  assert.throws(() => renderTemplate("{{y}}", { x: "1" }), /\{\{y\}\} is missing/);
  assert.throws(() => renderTemplate("{{x}}", { x: 'a"b' }), /may not carry/);
  const sums = { dmg: "a".repeat(64), zip: "b".repeat(64), msi: "c".repeat(64) };
  const good = { version: "1.0.0", repo: REPO, identifier: "dev.sextant.app", releaseDate: "2026-01-01", sums };
  assert.equal(renderAll(good).length, 5);
  assert.throws(() => renderAll({ ...good, sums: { ...sums, zip: "B".repeat(64) } }), /SHA-256 for the zip/);
  assert.throws(() => renderAll({ ...good, repo: "a/b c" }), /bad repository/);
  assert.throws(() => renderAll({ ...good, releaseDate: "today" }), /bad release date/);
});

test("the cask points at the universal dmg of the release, updates itself and trashes the app's own dirs", () => {
  const cask = rendered()["homebrew/Casks/sextant.rb"];
  assert.match(cask, /^cask "sextant" do$/m);
  assert.match(cask, /^ {2}version "0\.19\.0"$/m);
  assert.match(cask, /^ {2}sha256 "7c0e895a259027e7f60830b25cd00bedc150dd40ad0dc097cf01a34a129979d8"$/m);
  assert.match(cask, /^ {2}auto_updates true$/m);
  assert.match(cask, /^ {2}app "Sextant\.app"$/m);
  const url = cask.match(/^ {2}url "([^"]+)"$/m)[1].replaceAll("#{version}", "0.19.0");
  assert.equal(url, assetUrl(assetNames("0.19.0").dmg));
  const id = appIdentifier();
  assert.equal(id, "dev.sextant.app");
  for (const dir of ["Application Support", "Caches", "WebKit", "Logs"]) {
    assert.ok(cask.includes(`"~/Library/${dir}/${id}",`), `zap ${dir}`);
  }
  assert.doesNotMatch(cask, /\{\{|\}\}/);
});

test("the cask is valid Ruby", { skip: spawnSync("ruby", ["-v"]).status !== 0 && "no ruby here" }, () => {
  const dir = temp();
  writeFileSync(join(dir, "sextant.rb"), rendered()["homebrew/Casks/sextant.rb"]);
  assert.match(execFileSync("ruby", ["-c", join(dir, "sextant.rb")], { encoding: "utf8" }), /Syntax OK/);
});

test("the Scoop manifest takes the portable zip, and its autoupdate URL is the same URL", () => {
  const scoop = JSON.parse(rendered()["scoop/bucket/sextant.json"]);
  assert.equal(scoop.version, "0.19.0");
  for (const key of ["description", "homepage", "license", "bin", "shortcuts", "checkver", "autoupdate"]) {
    assert.ok(scoop[key], key);
  }
  const x64 = scoop.architecture["64bit"];
  assert.equal(x64.url, assetUrl(assetNames("0.19.0").zip));
  assert.equal(x64.hash, "2f1286c6a3ea643fc659734b283915b4a451d49ee8cc239ce86b280850899c38");
  assert.equal(scoop.autoupdate.architecture["64bit"].url.replaceAll("$version", "0.19.0"), x64.url);
  assert.equal(scoop.bin, "sextant.exe");
  assert.equal(scoop.checkver.github, `https://github.com/${REPO}`);
});

test("the winget manifests agree with each other and name the msi of the release", () => {
  const files = rendered();
  const version = parseYaml(files[`${WINGET_DIR}/${WINGET_ID}.yaml`]);
  const installer = parseYaml(files[`${WINGET_DIR}/${WINGET_ID}.installer.yaml`]);
  const locale = parseYaml(files[`${WINGET_DIR}/${WINGET_ID}.locale.en-US.yaml`]);
  assert.deepEqual([version.ManifestType, installer.ManifestType, locale.ManifestType], ["version", "installer", "defaultLocale"]);
  for (const doc of [version, installer, locale]) {
    assert.equal(doc.PackageIdentifier, WINGET_ID);
    assert.equal(doc.PackageVersion, "0.19.0");
    assert.equal(doc.ManifestVersion, "1.6.0");
  }
  assert.equal(version.DefaultLocale, locale.PackageLocale);
  assert.equal(installer.InstallerType, "wix");
  assert.equal(installer.ReleaseDate, "2026-11-02");
  assert.equal(installer.Installers.length, 1);
  assert.equal(installer.Installers[0].Architecture, "x64");
  assert.equal(installer.Installers[0].InstallerUrl, assetUrl(assetNames("0.19.0").msi));
  assert.equal(installer.Installers[0].InstallerSha256, "F28392F25A7C7A75DE21E89CDD2640ECAAAF1206D9C0D55BD9A5F73CD9B9DB02");
  for (const key of ["Publisher", "PackageName", "License", "ShortDescription"]) assert.ok(locale[key], key);
  assert.ok(locale.ShortDescription.length <= 256);
});

test("the CLI renders a published release's manifests into the tap, bucket and winget layout", () => {
  const out = temp();
  execFileSync("node", [SCRIPT, "render", "--tag", "v0.19.0", "--release", FIXTURE, "--out", out], { encoding: "utf8" });
  assert.equal(readFileSync(join(out, "homebrew/Casks/sextant.rb"), "utf8"), rendered()["homebrew/Casks/sextant.rb"]);
  assert.match(readFileSync(join(out, WINGET_DIR, `${WINGET_ID}.installer.yaml`), "utf8"), /ReleaseDate: 2026-11-02/);
  const other = spawnSync("node", [SCRIPT, "render", "--tag", "v0.18.0", "--release", FIXTURE, "--out", out], {
    encoding: "utf8",
  });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /is the release of v0\.19\.0/);
});

test("a dry run hashes the bundles it built", () => {
  const dir = temp();
  const out = temp();
  for (const name of Object.values(assetNames("0.19.0"))) writeFileSync(join(dir, name), name);
  const sums = checksumsFromDir(dir, "0.19.0");
  assert.equal(sums.dmg, createHash("sha256").update(assetNames("0.19.0").dmg).digest("hex"));
  execFileSync("node", [SCRIPT, "render", "--tag", "v0.19.0", "--dir", dir, "--out", out]);
  assert.match(readFileSync(join(out, "scoop/bucket/sextant.json"), "utf8"), new RegExp(sums.zip));
  assert.throws(() => checksumsFromDir(temp(), "0.19.0"), /has no Sextant_0\.19\.0_universal\.dmg/);
});

test("only an executable with Tauri's unset bundle marker goes into the portable zip", () => {
  const plain = Buffer.concat([Buffer.alloc(16), Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK"), Buffer.alloc(8)]);
  const patched = Buffer.from(plain.toString("latin1").replace("_UNK", "_MSI"), "latin1");
  assert.equal(isUnbundled(plain), true);
  assert.equal(isUnbundled(patched), false);
  const dir = temp();
  writeFileSync(join(dir, "plain.exe"), plain);
  writeFileSync(join(dir, "patched.exe"), patched);
  execFileSync("node", [SCRIPT, "check-unbundled", join(dir, "plain.exe")]);
  assert.notEqual(spawnSync("node", [SCRIPT, "check-unbundled", join(dir, "patched.exe")]).status, 0);
});
