// Package-manager manifests of a release (ADR-0104): renders the templates in packaging/ — the Homebrew cask, the
// Scoop manifest and the three winget manifests — with the version and the SHA-256 of the release's own assets.
// Run by the release workflow after the release is published, and by `npm run check` on fixtures (the tests).
//
//   node scripts/packaging.mjs render --tag v0.19.0 --release release.json --out packaging-out
//   node scripts/packaging.mjs render --tag v0.19.0 --dir bundles --out packaging-out     # a dry run's files
//   node scripts/packaging.mjs check-unbundled target/release/sextant.exe
//
// `--release` is GitHub's JSON of the release (`gh api repos/<repo>/releases/<id>`): every checksum is the asset's
// `digest` that GitHub computed from the uploaded file; an asset without one is downloaded from the release and
// hashed. Nothing is rebuilt or hashed from a build directory, except with `--dir` (a dry run, which has no release).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
export const TEMPLATES = join(ROOT, "packaging");
export const DEFAULT_REPO = "FriendsOfKubernetes/sextant";
export const WINGET_ID = "FriendsOfKubernetes.Sextant";

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const IDENTIFIER = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The release assets the manifests point at, by role. */
export function assetNames(version) {
  return {
    dmg: `Sextant_${version}_universal.dmg`,
    zip: `Sextant_${version}_x64_portable.zip`,
    msi: `Sextant_${version}_x64_en-US.msi`,
  };
}

/** `version` from a tag `v<version>`; throws on anything else. */
export function versionOfTag(tag) {
  const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : "";
  if (!VERSION.test(version)) throw new Error(`not a release tag: ${JSON.stringify(tag)} (expected vX.Y.Z)`);
  return version;
}

/** Replaces every `{{name}}`; an unknown name or a value with a line break, quote or backslash is an error. */
export function renderTemplate(text, values) {
  return text.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_, name) => {
    const value = values[name];
    if (typeof value !== "string" || value === "") throw new Error(`template value {{${name}}} is missing`);
    if (/["\\\r\n]/.test(value)) throw new Error(`template value {{${name}}} has a character it may not carry`);
    return value;
  });
}

/** SHA-256 (lowercase hex) of each needed asset from GitHub's `digest`; `null` where the asset has none. */
export function checksumsFromRelease(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const sums = {};
  const urls = {};
  for (const [role, name] of Object.entries(assetNames(version))) {
    const asset = assets.find((a) => a?.name === name);
    if (!asset) throw new Error(`the release has no asset ${name}`);
    if (asset.state !== undefined && asset.state !== "uploaded") throw new Error(`asset ${name} is ${asset.state}`);
    const digest = typeof asset.digest === "string" ? asset.digest.match(/^sha256:([0-9a-fA-F]{64})$/) : null;
    sums[role] = digest ? digest[1].toLowerCase() : null;
    urls[role] = asset.browser_download_url;
  }
  return { sums, urls };
}

/** SHA-256 of each needed asset from files in `dir` (a dry run's bundles, searched a few levels deep). */
export function checksumsFromDir(dir, version, readFile = readFileSync, list = listFiles) {
  const files = list(dir);
  const sums = {};
  for (const [role, name] of Object.entries(assetNames(version))) {
    const path = files.find((file) => file.split(/[\\/]/).pop() === name);
    if (!path) throw new Error(`${dir} has no ${name}`);
    sums[role] = createHash("sha256").update(readFile(path)).digest("hex");
  }
  return sums;
}

function listFiles(dir, depth = 4) {
  const out = [];
  for (const entry of readdirSafe(dir)) {
    const path = join(dir, entry.name);
    if (entry.isFile()) out.push(path);
    else if (entry.isDirectory() && depth > 0) out.push(...listFiles(path, depth - 1));
  }
  return out;
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Where each template is rendered to, relative to the output directory (the layout of the tap, bucket and winget-pkgs). */
export function outputs(version) {
  const winget = `winget/manifests/f/FriendsOfKubernetes/Sextant/${version}`;
  return [
    { template: "homebrew/sextant.rb.tmpl", out: "homebrew/Casks/sextant.rb" },
    { template: "scoop/sextant.json.tmpl", out: "scoop/bucket/sextant.json" },
    { template: `winget/${WINGET_ID}.yaml.tmpl`, out: `${winget}/${WINGET_ID}.yaml` },
    { template: `winget/${WINGET_ID}.installer.yaml.tmpl`, out: `${winget}/${WINGET_ID}.installer.yaml` },
    { template: `winget/${WINGET_ID}.locale.en-US.yaml.tmpl`, out: `${winget}/${WINGET_ID}.locale.en-US.yaml` },
  ];
}

/**
 * Every manifest as `{ out, text }`. `sums` holds the lowercase SHA-256 of the dmg, the portable zip and the msi;
 * `identifier` is the app's bundle identifier (the cask's zap paths, the Scoop notes).
 */
export function renderAll({ version, repo, identifier, releaseDate, sums }, readTemplate = defaultReadTemplate) {
  if (!VERSION.test(version ?? "")) throw new Error(`bad version ${JSON.stringify(version)}`);
  if (!REPO.test(repo ?? "")) throw new Error(`bad repository ${JSON.stringify(repo)}`);
  if (!IDENTIFIER.test(identifier ?? "")) throw new Error(`bad identifier ${JSON.stringify(identifier)}`);
  if (!DATE.test(releaseDate ?? "")) throw new Error(`bad release date ${JSON.stringify(releaseDate)}`);
  for (const role of ["dmg", "zip", "msi"]) {
    if (!SHA256.test(sums?.[role] ?? "")) throw new Error(`bad SHA-256 for the ${role}: ${JSON.stringify(sums?.[role])}`);
  }
  const values = {
    version,
    repo,
    identifier,
    releaseDate,
    wingetId: WINGET_ID,
    dmgSha256: sums.dmg,
    zipSha256: sums.zip,
    msiSha256Upper: sums.msi.toUpperCase(),
  };
  return outputs(version).map(({ template, out }) => {
    const text = renderTemplate(readTemplate(template), values);
    if (out.endsWith(".json")) JSON.parse(text);
    return { out, text };
  });
}

function defaultReadTemplate(name) {
  return readFileSync(join(TEMPLATES, name), "utf8");
}

/** The app's bundle identifier from src-tauri/tauri.conf.json. */
export function appIdentifier(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).identifier;
}

// Tauri's bundler writes the bundle kind into the executable it packs (`__TAURI_BUNDLE_TYPE_VAR_MSI` in the one
// inside the .msi) and restores the plain one afterwards. A copy that still says MSI would update itself through the
// .msi into Program Files beside the Scoop copy, so the portable zip takes only an executable with the unset marker.
const UNSET_MARKER = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");

/** Whether an executable carries Tauri's unset bundle-kind marker (it was not patched for an installer). */
export function isUnbundled(bytes) {
  return Buffer.from(bytes).indexOf(UNSET_MARKER) >= 0;
}

async function sha256OfUrl(url) {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) throw new Error(`refusing to fetch ${url}`);
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

function option(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "check-unbundled") {
    const [file] = rest;
    if (!file) throw new Error("usage: check-unbundled <executable>");
    if (!isUnbundled(readFileSync(file))) throw new Error(`${file} is patched for an installer (no unset bundle marker)`);
    console.log(`${file}: not patched for an installer`);
    return;
  }
  if (command !== "render") throw new Error("usage: render --tag vX.Y.Z (--release <file> | --dir <dir>) --out <dir>");
  const version = versionOfTag(option(rest, "--tag"));
  const repo = option(rest, "--repo") ?? DEFAULT_REPO;
  const out = option(rest, "--out");
  const releaseFile = option(rest, "--release");
  const dir = option(rest, "--dir");
  if (!out || Boolean(releaseFile) === Boolean(dir)) throw new Error("give --out and exactly one of --release, --dir");

  let sums;
  let releaseDate = new Date().toISOString().slice(0, 10);
  if (releaseFile) {
    const release = JSON.parse(readFileSync(releaseFile, "utf8"));
    if (release.tag_name !== `v${version}`) throw new Error(`${releaseFile} is the release of ${release.tag_name}`);
    if (typeof release.published_at === "string" && DATE.test(release.published_at.slice(0, 10))) {
      releaseDate = release.published_at.slice(0, 10);
    }
    const found = checksumsFromRelease(release, version);
    sums = found.sums;
    for (const role of Object.keys(sums)) {
      if (sums[role] === null) {
        console.log(`${assetNames(version)[role]} has no digest on GitHub, hashing the published asset`);
        sums[role] = await sha256OfUrl(found.urls[role]);
      }
    }
  } else {
    sums = checksumsFromDir(dir, version);
  }
  for (const { out: path, text } of renderAll({ version, repo, identifier: appIdentifier(), releaseDate, sums })) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`wrote ${target}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`packaging: ${error.message}`);
    process.exit(1);
  });
}
