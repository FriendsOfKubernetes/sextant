// Fails if the application version differs between the manifests that carry it, or (with `--tag vX.Y.Z`) from the
// release tag. Run by `npm run check` and by the release workflow before anything is built.
//
//   node scripts/check-version.mjs                 # the manifests agree
//   node scripts/check-version.mjs --tag v0.2.0    # ... and the tag is v<version>
//
// Carriers: Cargo.toml `[workspace.package] version` (inherited by both crates), Cargo.lock (`sextant`,
// `sextant-core`), src-tauri/tauri.conf.json (names the installers), package.json and package-lock.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Text of `file` under `root`, or `null` when it cannot be read. */
function read(root, file) {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

function json(root, file) {
  const text = read(root, file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `key = "value"` inside the TOML table that starts with the line `header`. */
function tomlValue(text, header, key) {
  if (text === null) return null;
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = line === header;
      continue;
    }
    const match = inside && line.match(/^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    if (match && match[1] === key) return match[2];
  }
  return null;
}

/** Version of the package `name` in Cargo.lock. */
function lockedVersion(text, name) {
  if (text === null) return null;
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (tomlValue(`[p]\n${block}`, "[p]", "name") === name) return tomlValue(`[p]\n${block}`, "[p]", "version");
  }
  return null;
}

/** Every place the version is written: `{ where, version }` (`version` is `null` when it was not found). */
export function readVersions(root) {
  const cargoLock = read(root, "Cargo.lock");
  const lock = json(root, "package-lock.json");
  const str = (value) => (typeof value === "string" && value ? value : null);
  return [
    { where: "Cargo.toml", version: tomlValue(read(root, "Cargo.toml"), "[workspace.package]", "version") },
    { where: "Cargo.lock sextant", version: lockedVersion(cargoLock, "sextant") },
    { where: "Cargo.lock sextant-core", version: lockedVersion(cargoLock, "sextant-core") },
    { where: "src-tauri/tauri.conf.json", version: str(json(root, "src-tauri/tauri.conf.json")?.version) },
    { where: "package.json", version: str(json(root, "package.json")?.version) },
    { where: "package-lock.json", version: str(lock?.version) },
    { where: 'package-lock.json packages[""]', version: str(lock?.packages?.[""]?.version) },
  ];
}

/**
 * What is wrong with the versions under `root`, one line per problem (empty when all is well). The version most
 * places agree on is taken as the intended one; `tag`, when given, must be `v` followed by it.
 */
export function versionProblems(root, tag) {
  const found = readVersions(root);
  const counts = new Map();
  for (const { version } of found) if (version) counts.set(version, (counts.get(version) ?? 0) + 1);
  const expected = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const problems = [];
  for (const { where, version } of found) {
    if (version === null) problems.push(`${where}: no version found`);
    else if (version !== expected) problems.push(`${where}: version ${version}, the others have ${expected}`);
  }
  if (tag !== undefined && expected !== null && tag !== `v${expected}`) {
    problems.push(`tag ${tag} does not match the version ${expected} (expected tag v${expected})`);
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const tagAt = args.indexOf("--tag");
  const tag = tagAt >= 0 ? args[tagAt + 1] : undefined;
  if (tagAt >= 0 && !tag) {
    console.error("usage: node scripts/check-version.mjs [--tag vX.Y.Z]");
    process.exit(2);
  }
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const problems = versionProblems(root, tag);
  if (problems.length > 0) {
    console.error("Version mismatch:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const version = readVersions(root)[0].version;
  console.log(`Version ${version}${tag ? ` matches tag ${tag}` : ""} in every manifest.`);
}
