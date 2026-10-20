// Package-manager manifests of a release (ADR-0104): renders the templates in packaging/ — the Homebrew cask, the
// Scoop manifest and the three winget manifests — with the version and the SHA-256 of the release's own assets.
// Run by the release workflow after the release is published, and by `npm run check` on fixtures (the tests).
//
//   node scripts/packaging.mjs render --tag v0.19.0 --release release.json --out packaging-out
//   node scripts/packaging.mjs render --tag v0.19.0 --dir bundles --out packaging-out     # a dry run's files
//   node scripts/packaging.mjs check-unbundled target/release/sextant.exe
//   node scripts/packaging.mjs latest-json --tag v0.19.0 --assets assets.json --sigs sigs [--manifest latest.json] \
//     --platforms full --notes notes.md --published false --out latest.new.json
//
// `--release` is GitHub's JSON of the release (`gh api repos/<repo>/releases/<id>`): every checksum is the asset's
// `digest` that GitHub computed from the uploaded file; an asset without one is downloaded from the release and
// hashed. Nothing is rebuilt or hashed from a build directory, except with `--dir` (a dry run, which has no release).
// Without the portable zip (the Windows job skips it when the executable is patched) every manifest but Scoop's is
// rendered.
//
// `latest-json` is the release workflow's publish step for the updater manifest: it takes the release's assets
// (`gh api …/releases/<id>/assets`), the downloaded `.sig` assets and the latest.json the build jobs merged (if any),
// checks every entry against the assets, takes every signature from its `.sig` asset, rebuilds the entries that
// concurrent build jobs lost from the assets themselves, and fails only when a required platform has no signed asset.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** Roles whose asset may be missing: the manifest that needs it is then left out (the portable zip, Scoop). */
export const OPTIONAL_ROLES = new Set(["zip"]);

/**
 * SHA-256 (lowercase hex) of each needed asset from GitHub's `digest`; `null` where the asset has none. An optional
 * role without its asset is left out of `sums` and listed in `absent`.
 */
export function checksumsFromRelease(release, version) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const sums = {};
  const urls = {};
  const absent = [];
  for (const [role, name] of Object.entries(assetNames(version))) {
    const asset = assets.find((a) => a?.name === name);
    if (!asset && OPTIONAL_ROLES.has(role)) {
      absent.push(name);
      continue;
    }
    if (!asset) throw new Error(`the release has no asset ${name}`);
    if (asset.state !== undefined && asset.state !== "uploaded") throw new Error(`asset ${name} is ${asset.state}`);
    const digest = typeof asset.digest === "string" ? asset.digest.match(/^sha256:([0-9a-fA-F]{64})$/) : null;
    sums[role] = digest ? digest[1].toLowerCase() : null;
    urls[role] = asset.browser_download_url;
  }
  return { sums, urls, absent };
}

/** SHA-256 of each needed asset from files in `dir` (a dry run's bundles, searched a few levels deep). */
export function checksumsFromDir(dir, version, readFile = readFileSync, list = listFiles) {
  const files = list(dir);
  const sums = {};
  for (const [role, name] of Object.entries(assetNames(version))) {
    const path = files.find((file) => file.split(/[\\/]/).pop() === name);
    if (!path && OPTIONAL_ROLES.has(role)) continue;
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
    { template: "scoop/sextant.json.tmpl", out: "scoop/bucket/sextant.json", needs: "zip" },
    { template: `winget/${WINGET_ID}.yaml.tmpl`, out: `${winget}/${WINGET_ID}.yaml` },
    { template: `winget/${WINGET_ID}.installer.yaml.tmpl`, out: `${winget}/${WINGET_ID}.installer.yaml` },
    { template: `winget/${WINGET_ID}.locale.en-US.yaml.tmpl`, out: `${winget}/${WINGET_ID}.locale.en-US.yaml` },
  ];
}

/**
 * Every manifest as `{ out, text }`. `sums` holds the lowercase SHA-256 of the dmg, the portable zip and the msi
 * (without the zip — `undefined` or `null` — the Scoop manifest is left out); `identifier` is the app's bundle
 * identifier (the cask's zap paths, the Scoop notes); `msi` is what the .msi registers in Apps & Features
 * (`msiIdentity`).
 */
export function renderAll({ version, repo, identifier, releaseDate, sums, msi }, readTemplate = defaultReadTemplate) {
  if (!VERSION.test(version ?? "")) throw new Error(`bad version ${JSON.stringify(version)}`);
  if (!REPO.test(repo ?? "")) throw new Error(`bad repository ${JSON.stringify(repo)}`);
  if (!IDENTIFIER.test(identifier ?? "")) throw new Error(`bad identifier ${JSON.stringify(identifier)}`);
  if (!DATE.test(releaseDate ?? "")) throw new Error(`bad release date ${JSON.stringify(releaseDate)}`);
  const present = (role) => !(OPTIONAL_ROLES.has(role) && (sums?.[role] === undefined || sums?.[role] === null));
  for (const role of ["dmg", "zip", "msi"].filter(present)) {
    if (!SHA256.test(sums?.[role] ?? "")) throw new Error(`bad SHA-256 for the ${role}: ${JSON.stringify(sums?.[role])}`);
  }
  if (!GUID_BRACED.test(msi?.upgradeCode ?? "")) throw new Error(`bad upgrade code ${JSON.stringify(msi?.upgradeCode)}`);
  if (typeof msi?.manufacturer !== "string" || msi.manufacturer.trim() === "") throw new Error("no MSI manufacturer");
  if (typeof msi?.productName !== "string" || msi.productName.trim() === "") throw new Error("no MSI product name");
  const values = {
    version,
    repo,
    identifier,
    releaseDate,
    wingetId: WINGET_ID,
    dmgSha256: sums.dmg,
    zipSha256: sums.zip ?? undefined,
    msiSha256Upper: sums.msi.toUpperCase(),
    msiProductName: msi.productName,
    msiManufacturer: msi.manufacturer,
    msiUpgradeCode: msi.upgradeCode,
  };
  return outputs(version)
    .filter(({ needs }) => !needs || present(needs))
    .map(({ template, out }) => {
      const text = renderTemplate(readTemplate(template), values);
      if (out.endsWith(".json")) JSON.parse(text);
      return { out, text };
    });
}

function defaultReadTemplate(name) {
  return readFileSync(join(TEMPLATES, name), "utf8");
}

/** src-tauri/tauri.conf.json. */
export function tauriConfig(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
}

/** The app's bundle identifier from src-tauri/tauri.conf.json. */
export function appIdentifier(root = ROOT) {
  return tauriConfig(root).identifier;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUID_BRACED = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/;
/** RFC 4122's DNS namespace, which Tauri's bundler derives the default WiX upgrade code in. */
const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** RFC 4122 name-based UUID, version 5 (SHA-1), lowercase. */
export function uuidV5(name, namespace = NAMESPACE_DNS) {
  if (!GUID.test(namespace)) throw new Error(`bad namespace ${JSON.stringify(namespace)}`);
  const bytes = createHash("sha1")
    .update(Buffer.concat([Buffer.from(namespace.replaceAll("-", ""), "hex"), Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * What the .msi registers in Apps & Features, as Tauri's bundler writes it (winget's `AppsAndFeaturesEntries`):
 * the product name; the Manufacturer — `bundle.publisher`, else the second part of the identifier (`dev.sextant.app`
 * → `sextant`); the UpgradeCode — `bundle.windows.wix.upgradeCode`, else UUIDv5 in the DNS namespace of
 * `<productName>.exe.app.<arch>` (what `tauri inspect wix-upgrade-code` prints), upper case in braces as WiX
 * writes it. The UpgradeCode must never change: it is how Windows and winget tell an update from another app.
 */
export function msiIdentity(config, arch = "x64") {
  const productName = config?.productName;
  const identifier = config?.identifier;
  if (typeof productName !== "string" || productName === "") throw new Error("tauri.conf.json has no productName");
  if (!IDENTIFIER.test(identifier ?? "")) throw new Error(`bad identifier ${JSON.stringify(identifier)}`);
  const publisher = config.bundle?.publisher;
  const manufacturer = typeof publisher === "string" && publisher !== "" ? publisher : identifier.split(".")[1];
  const configured = config.bundle?.windows?.wix?.upgradeCode;
  if (configured !== undefined && configured !== null && !GUID.test(configured)) {
    throw new Error(`bad bundle.windows.wix.upgradeCode ${JSON.stringify(configured)}`);
  }
  const code = configured ?? uuidV5(`${productName}.exe.app.${arch}`);
  return { productName, manufacturer, upgradeCode: `{${code.toUpperCase()}}` };
}

// The updater manifest (latest.json) of a release, as tauri-action writes it: `<os>-<arch>` for the bundle an
// installed copy replaces itself with (AppImage, .app.tar.gz, .msi) and `<os>-<arch>-<bundle>` for each bundle.

/** The keys an installed copy may ask for, by the release's layout: `full` since ADR-0104, `legacy` before it. */
export function requiredPlatforms(layout) {
  if (layout === "legacy") return ["linux-x86_64", "darwin-x86_64", "darwin-aarch64", "windows-x86_64"];
  if (layout !== "full") throw new Error(`unknown platform set ${JSON.stringify(layout)} (full or legacy)`);
  return [
    "linux-x86_64",
    "linux-x86_64-deb",
    "linux-x86_64-rpm",
    "linux-aarch64",
    "linux-aarch64-deb",
    "linux-aarch64-rpm",
    "darwin-x86_64",
    "darwin-aarch64",
    "windows-x86_64",
  ];
}

const LINUX_ARCH = { amd64: "x86_64", x86_64: "x86_64", aarch64: "aarch64", arm64: "aarch64" };
const DARWIN_ARCHES = { universal: ["x86_64", "aarch64"], x64: ["x86_64"], aarch64: ["aarch64"] };
const WINDOWS_ARCH = { x64: "x86_64", arm64: "aarch64" };

/** The latest.json keys a release asset serves, from its name (Tauri's bundle names); `[]` for any other file. */
export function updaterKeysOfAsset(name) {
  if (typeof name !== "string") return [];
  let m = name.match(/_(amd64|aarch64)\.AppImage$/);
  if (m) return [`linux-${LINUX_ARCH[m[1]]}`, `linux-${LINUX_ARCH[m[1]]}-appimage`];
  m = name.match(/_(amd64|arm64)\.deb$/);
  if (m) return [`linux-${LINUX_ARCH[m[1]]}-deb`];
  m = name.match(/-\d+\.(x86_64|aarch64)\.rpm$/);
  if (m) return [`linux-${LINUX_ARCH[m[1]]}-rpm`];
  m = name.match(/_(universal|x64|aarch64)\.app\.tar\.gz$/);
  if (m) return DARWIN_ARCHES[m[1]].flatMap((arch) => [`darwin-${arch}`, `darwin-${arch}-app`]);
  m = name.match(/_(x64|arm64)_[A-Za-z]{2,3}(-[A-Za-z0-9]+)?\.msi$/);
  if (m) return [`windows-${WINDOWS_ARCH[m[1]]}`, `windows-${WINDOWS_ARCH[m[1]]}-msi`];
  return [];
}

/** The file ending a key's url must have (the existing checks of the publish job). */
function wantedSuffix(key) {
  if (key.endsWith("-deb")) return ".deb";
  if (key.endsWith("-rpm")) return ".rpm";
  if (key.endsWith("-nsis")) return "-setup.exe";
  if (key.startsWith("linux-")) return ".AppImage";
  if (key.startsWith("darwin-")) return ".app.tar.gz";
  if (key.startsWith("windows-")) return ".msi";
  return null;
}

const ASSET_NAME = /^[A-Za-z0-9._+-]+$/;

/** The tagged download URL of a release asset (a draft's own URLs say `untagged-…`). */
export function downloadUrl(repo, tag, name) {
  if (!REPO.test(repo ?? "")) throw new Error(`bad repository ${JSON.stringify(repo)}`);
  if (!ASSET_NAME.test(name ?? "")) throw new Error(`unexpected asset name ${JSON.stringify(name)}`);
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

/**
 * The release's latest.json. `manifest` is what the build jobs merged (`null` if the release has none); `assets` the
 * names of the release's assets; `signatures` maps `<asset>.sig` to its text. Every entry must link an asset of this
 * release with the right ending, and takes its signature from that asset's `.sig`. An entry the asset of a key would
 * give but the manifest lacks (concurrent build jobs overwrote each other) is rebuilt from the asset and its `.sig`.
 * Throws when a required key has no signed asset. Returns `{ manifest, notices }`.
 */
export function updaterManifest({ tag, repo, manifest, assets, signatures, required, notes, now, published }) {
  const version = versionOfTag(tag);
  const names = new Set(assets);
  const notices = [];
  const signatureOf = (file) => {
    const text = signatures.get(`${file}.sig`);
    return typeof text === "string" && text.trim() !== "" ? text : null;
  };
  if (manifest !== null && manifest !== undefined) {
    if (typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("latest.json is not an object");
    if (manifest.version !== version) throw new Error(`latest.json is for version '${manifest.version}', not for ${tag}`);
  }
  const out = {
    ...(manifest ?? {}),
    version,
    pub_date: manifest?.pub_date ?? now,
    platforms: { ...(manifest?.platforms ?? {}) },
  };
  const dir = `/releases/download/${tag}/`;
  const problems = [];

  for (const [key, entry] of Object.entries(out.platforms)) {
    const url = typeof entry?.url === "string" ? entry.url : "";
    if (url === "") {
      delete out.platforms[key];
      continue;
    }
    if (!url.includes(dir)) throw new Error(`latest.json links files outside the release ${tag}: ${key}: ${url}`);
    const file = url.slice(url.lastIndexOf("/") + 1);
    const want = wantedSuffix(key);
    if (!want || !file.endsWith(want)) {
      throw new Error(`latest.json: ${key} links ${file}, expected a *${want ?? "<known bundle>"} file`);
    }
    if (!names.has(file)) throw new Error(`latest.json: ${key} links ${file}, which is not an asset of the release`);
    const signature = signatureOf(file);
    if (!signature) throw new Error(`latest.json: ${key}: the release has no ${file}.sig`);
    if (entry.signature !== signature) {
      notices.push(`latest.json: ${key} had a stale or no signature, replaced with ${file}.sig of this release`);
    }
    out.platforms[key] = { ...entry, signature };
  }

  for (const name of [...names].sort()) {
    for (const key of updaterKeysOfAsset(name)) {
      if (out.platforms[key]) continue;
      const signature = signatureOf(name);
      if (!signature) continue;
      out.platforms[key] = { signature, url: downloadUrl(repo, tag, name) };
      notices.push(`latest.json: ${key} was missing, rebuilt from ${name} and ${name}.sig`);
    }
  }

  for (const key of required) {
    if (out.platforms[key]) continue;
    const asset = [...names].find((name) => updaterKeysOfAsset(name).includes(key));
    problems.push(asset ? `${key} (the release has ${asset} but no ${asset}.sig)` : `${key} (the release has no asset for it)`);
  }
  if (problems.length > 0) {
    throw new Error(`latest.json lacks platforms: ${problems.join(", ")} - re-run the failed build jobs`);
  }

  out.notes = notes;
  if (published) out.pub_date = now;
  out.platforms = Object.fromEntries(Object.entries(out.platforms).sort(([a], [b]) => a.localeCompare(b)));
  return { manifest: out, notices };
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

function latestJson(rest) {
  const tag = option(rest, "--tag");
  versionOfTag(tag);
  const repo = option(rest, "--repo") ?? DEFAULT_REPO;
  const assetsFile = option(rest, "--assets");
  const sigs = option(rest, "--sigs");
  const manifestFile = option(rest, "--manifest");
  const layout = option(rest, "--platforms");
  const notesFile = option(rest, "--notes");
  const published = option(rest, "--published");
  const out = option(rest, "--out");
  if (!assetsFile || !sigs || !layout || !notesFile || !out || !["true", "false"].includes(published ?? "")) {
    throw new Error("usage: latest-json --tag vX.Y.Z --assets <file> --sigs <dir> [--manifest <file>] --platforms full|legacy --notes <file> --published true|false --out <file>");
  }
  const list = JSON.parse(readFileSync(assetsFile, "utf8"));
  if (!Array.isArray(list)) throw new Error(`${assetsFile} is not a list of assets`);
  const assets = list.map((a) => a?.name).filter((name) => typeof name === "string");
  const signatures = new Map();
  for (const entry of readdirSafe(sigs)) {
    if (entry.isFile() && entry.name.endsWith(".sig")) signatures.set(entry.name, readFileSync(join(sigs, entry.name), "utf8"));
  }
  const manifest = manifestFile && existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, "utf8")) : null;
  if (!manifest) console.log("::notice::The release has no latest.json: it is built from the assets");
  const result = updaterManifest({
    tag,
    repo,
    manifest,
    assets,
    signatures,
    required: requiredPlatforms(layout),
    notes: readFileSync(notesFile, "utf8"),
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    published: published === "true",
  });
  for (const notice of result.notices) console.log(`::notice::${notice}`);
  writeFileSync(out, `${JSON.stringify(result.manifest, null, 2)}\n`);
  console.log(`latest.json: version ${result.manifest.version}, platforms ${Object.keys(result.manifest.platforms).join(", ")}`);
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === "latest-json") return latestJson(rest);
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
    for (const name of found.absent) console.log(`::warning::The release has no ${name}: its manifest is not rendered`);
    for (const role of Object.keys(sums)) {
      if (sums[role] === null) {
        console.log(`${assetNames(version)[role]} has no digest on GitHub, hashing the published asset`);
        sums[role] = await sha256OfUrl(found.urls[role]);
      }
    }
  } else {
    sums = checksumsFromDir(dir, version);
  }
  const config = tauriConfig();
  const files = renderAll({ version, repo, identifier: config.identifier, releaseDate, sums, msi: msiIdentity(config) });
  for (const { out: path, text } of files) {
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
