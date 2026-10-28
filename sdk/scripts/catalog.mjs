// The extension catalog's rules (ADR-0130), used by the catalog repository's workflow
// (FriendsOfKubernetes/sextant-extensions) to check entries and to write `index.json`, and by this SDK's tests. The app
// reads the index with crates/sextant-core/src/extensions/catalog.rs and checks every package again itself: nothing
// here is trusted by Sextant, it only keeps the index from listing what Sextant would refuse.
//
// An entry (`extensions/<id>.json`, reviewed) names the extension, its GitHub repository and the publisher's minisign
// key. For each entry the workflow picks the newest published release that carries `<id>-<version>.sextant-ext` and its
// `.minisig`, checks them with `checkRelease`, and `buildIndex` writes what passed beside what did not.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { checkManifestBytes, formatManifestError, isExtensionId, isPackagePath, MANIFEST_FILE } from "./manifest.mjs";
import { MinisignError, parsePublicKey, verify } from "./minisign.mjs";
import { unzip } from "./zip.mjs";

export const SCHEMA_VERSION = 1;
export const CATEGORIES = ["observability", "cost", "security", "gitops", "networking", "storage", "workloads", "developer", "other"];
export const MAX_CATEGORIES = 3;
/** The app's download cap for a package (`MAX_DOWNLOAD_BYTES` in src-tauri/src/extensions/manage.rs). */
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 2000;
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
/** A release's permissions are refused when their JSON is longer: the index has to stay small. */
export const MAX_PERMISSIONS_BYTES = 16 * 1024;
export const MAX_ENTRIES = 2000;
export const PACKAGE_SUFFIX = ".sextant-ext";
export const SIGNATURE_SUFFIX = ".minisig";
const CONTRIBUTION_TYPES = ["pages", "detailsSections", "actions", "columns", "dockActions", "settings"];

export class CatalogError extends Error {}

const ENTRY_FIELDS = ["id", "name", "author", "description", "categories", "repository", "publisherKey", "withdrawn"];

const isControl = (c) => c.codePointAt(0) <= 0x1f || c.codePointAt(0) === 0x7f;
const isText = (value, max) =>
  typeof value === "string" && value.trim() !== "" && [...value].length <= max && ![...value].some(isControl);

/** `owner/repo` as GitHub allows them (no `.` or `..` for the repository). */
export function isRepository(text) {
  if (typeof text !== "string") return false;
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(text);
  return !!match && match[2] !== "." && match[2] !== "..";
}

/** A release tag the app puts into a download URL: no `/`, nothing that needs escaping. */
export function isReleaseTag(text) {
  return typeof text === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(text);
}

/** `X.Y.Z` with no pre-release or build part: the only versions the catalog lists. */
export function isPlainVersion(text) {
  return typeof text === "string" && /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(text);
}

/** Compares two `X.Y.Z` versions: negative, zero or positive. */
export function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Checks an entry file's parsed JSON; `fileName` is its name (`<id>.json`). Returns the entry with its fields in a
 * fixed order; throws `CatalogError` naming the field.
 */
export function checkEntry(value, fileName) {
  const fail = (field, message) => {
    throw new CatalogError(`${fileName}: ${field ? `${field}: ` : ""}${message}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("", "must be an object");
  for (const key of Object.keys(value)) if (!ENTRY_FIELDS.includes(key)) fail(key, "is not a field of an entry");
  const { id, name, author, description, categories, repository, publisherKey, withdrawn } = value;
  if (typeof id !== "string" || !isExtensionId(id)) fail("id", "must be an extension id, as in the manifest");
  if (fileName !== `${id}.json`) fail("id", `the file must be named ${id}.json`);
  if (!isText(name, 80)) fail("name", "must be 1–80 characters, not only spaces");
  if (!isText(author, 100)) fail("author", "must be 1–100 characters, not only spaces");
  if (!isText(description, 500)) fail("description", "must be 1–500 characters, not only spaces");
  if (!Array.isArray(categories) || categories.length < 1 || categories.length > MAX_CATEGORIES) {
    fail("categories", `must list 1 to ${MAX_CATEGORIES} categories`);
  }
  for (const category of categories) {
    if (!CATEGORIES.includes(category)) fail("categories", `\`${category}\` is not one of ${CATEGORIES.join(", ")}`);
  }
  if (new Set(categories).size !== categories.length) fail("categories", "lists a category twice");
  if (!isRepository(repository)) fail("repository", "must be `<owner>/<repository>` on GitHub");
  let key;
  try {
    key = parsePublicKey(publisherKey ?? "");
  } catch (err) {
    fail("publisherKey", err instanceof MinisignError ? err.message : "is not a minisign public key");
  }
  if (typeof publisherKey !== "string" || publisherKey.trim() !== key.base64) {
    fail("publisherKey", "must be the base64 line of the minisign public key alone");
  }
  const entry = { id, name, author, description, categories: [...categories], repository, publisherKey: key.base64 };
  if (withdrawn !== undefined) {
    if (typeof withdrawn !== "object" || withdrawn === null || Array.isArray(withdrawn) || Object.keys(withdrawn).join() !== "reason") {
      fail("withdrawn", "must be `{ \"reason\": \"…\" }`");
    }
    if (!isText(withdrawn.reason, 300)) fail("withdrawn.reason", "must be 1–300 characters");
    entry.withdrawn = { reason: withdrawn.reason };
  }
  return entry;
}

/** The version in `<id>-<version>.sextant-ext`, or `null`. */
export function assetVersion(id, assetName) {
  const prefix = `${id}-`;
  if (typeof assetName !== "string" || !assetName.startsWith(prefix) || !assetName.endsWith(PACKAGE_SUFFIX)) return null;
  const version = assetName.slice(prefix.length, -PACKAGE_SUFFIX.length);
  return isPlainVersion(version) ? version : null;
}

/**
 * The release the catalog lists for `entry`, from GitHub's list of releases (newest first, as the API returns them):
 * the first one that is published, not a pre-release, has a tag the app can use, and carries exactly one package of
 * this id with its signature. Returns `{tag, asset, version, publishedAt, packageUrl, signatureUrl}` or `null`.
 */
export function pickRelease(entry, releases) {
  for (const release of Array.isArray(releases) ? releases : []) {
    if (!release || release.draft || release.prerelease || !isReleaseTag(release.tag_name)) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const packages = assets.filter((asset) => assetVersion(entry.id, asset?.name) !== null);
    if (packages.length !== 1) continue;
    const pkg = packages[0];
    const sig = assets.find((asset) => asset?.name === `${pkg.name}${SIGNATURE_SUFFIX}`);
    if (!sig) continue;
    return {
      tag: release.tag_name,
      asset: pkg.name,
      version: assetVersion(entry.id, pkg.name),
      publishedAt: typeof release.published_at === "string" ? release.published_at : null,
      packageUrl: pkg.browser_download_url,
      signatureUrl: sig.browser_download_url,
    };
  }
  return null;
}

/** The download URL the app builds for a release asset (`release_url` in the core); the workflow downloads the same. */
export function releaseUrl(repository, tag, asset) {
  return `https://github.com/${repository}/releases/download/${tag}/${asset}`;
}

function contributionCounts(contributes) {
  const counts = {};
  for (const type of CONTRIBUTION_TYPES) {
    const list = contributes?.[type];
    if (Array.isArray(list) && list.length > 0) counts[type] = list.length;
  }
  return counts;
}

/**
 * Checks one release of `entry`: the package (`packageBytes`) and its `.minisig` text, as `pickRelease` chose them.
 * Throws `CatalogError` with the reason; returns the index's `latest` block.
 */
export function checkRelease(entry, picked, packageBytes, signatureText) {
  const fail = (message) => {
    throw new CatalogError(`${entry.id} ${picked.tag}: ${message}`);
  };
  if (!isReleaseTag(picked.tag)) fail("the tag has characters the app cannot put into a link");
  const version = assetVersion(entry.id, picked.asset);
  if (version === null) fail(`the package must be named ${entry.id}-<X.Y.Z>${PACKAGE_SUFFIX}`);
  if (packageBytes.length > MAX_PACKAGE_BYTES) fail(`the package is larger than ${MAX_PACKAGE_BYTES} bytes`);
  let signed;
  try {
    signed = verify(packageBytes, signatureText, entry.publisherKey);
  } catch (err) {
    fail(err instanceof MinisignError ? `signature: ${err.message}` : "signature: cannot be read");
  }
  let files;
  try {
    files = unzip(Buffer.from(packageBytes));
  } catch (err) {
    fail(`the package is not a zip archive Sextant reads (${err.message})`);
  }
  if (files.length > MAX_FILES) fail(`the package has more than ${MAX_FILES} files`);
  let total = 0;
  const seen = new Set();
  const paths = new Set();
  for (const file of files) {
    if (file.path.endsWith("/")) continue;
    if (!isPackagePath(file.path)) fail(`\`${file.path}\` is not a plain relative path`);
    const lower = file.path.toLowerCase();
    if (seen.has(lower)) fail(`\`${file.path}\` is in the package twice`);
    seen.add(lower);
    paths.add(file.path);
    total += file.data.length;
    if (total > MAX_UNPACKED_BYTES) fail(`the package unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
  }
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE);
  if (!manifestFile) fail(`the package has no ${MANIFEST_FILE} at its top`);
  const checked = checkManifestBytes(manifestFile.data);
  if (checked.error) fail(formatManifestError(checked.error));
  const { manifest } = checked;
  if (manifest.id !== entry.id) fail(`the manifest's id is ${manifest.id}, not ${entry.id}`);
  if (manifest.version !== version) fail(`the manifest's version is ${manifest.version}, the file name says ${version}`);
  if (!paths.has(manifest.entry)) fail(`the manifest's entry \`${manifest.entry}\` is not in the package`);
  const permissions = manifest.permissions;
  if (Buffer.byteLength(JSON.stringify(permissions)) > MAX_PERMISSIONS_BYTES) fail("the permissions are too long for the catalog");
  return {
    version,
    sextantApi: manifest.sextantApi,
    tag: picked.tag,
    asset: picked.asset,
    size: packageBytes.length,
    sha256: createHash("sha256").update(packageBytes).digest("hex"),
    keyId: signed.keyId,
    publishedAt: picked.publishedAt ?? null,
    permissions,
    contributes: contributionCounts(manifest.contributes),
  };
}

/**
 * The index to write. `entries` are checked entries; `results` maps an id to `{latest}` (a release that passed),
 * `{error}` (one that did not) or nothing (no release found); `previous` is the index now published (or `null`).
 * An entry keeps its previous `latest` when its newest release fails or is older, as long as the key and repository
 * did not change. Returns `{index, notes}`: `notes` are the warnings to show in the workflow.
 */
export function buildIndex({ entries, results, previous, now = new Date() }) {
  if (entries.length > MAX_ENTRIES) throw new CatalogError(`the catalog has more than ${MAX_ENTRIES} entries`);
  const before = new Map();
  for (const old of Array.isArray(previous?.extensions) ? previous.extensions : []) {
    if (old && typeof old.id === "string") before.set(old.id, old);
  }
  const notes = [];
  const extensions = [...entries]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((entry) => {
      const old = before.get(entry.id);
      const kept = old && old.publisherKey === entry.publisherKey && old.repository === entry.repository ? old.latest : undefined;
      const result = results.get(entry.id) ?? {};
      let latest = kept;
      if (result.latest) {
        if (kept && compareVersions(result.latest.version, kept.version) < 0) {
          notes.push(`${entry.id}: the newest release ${result.latest.version} is older than the listed ${kept.version}; keeping ${kept.version}`);
        } else {
          latest = result.latest;
        }
      } else if (result.error) {
        notes.push(kept ? `${result.error}; keeping ${kept.version}` : result.error);
      } else {
        notes.push(`${entry.id}: no release with ${entry.id}-<X.Y.Z>${PACKAGE_SUFFIX} and its ${SIGNATURE_SUFFIX} was found`);
      }
      return latest ? { ...entry, latest } : { ...entry };
    });
  // An index whose extensions did not change keeps its time, so the workflow has nothing to commit.
  const same = previous && JSON.stringify(previous.extensions) === JSON.stringify(extensions);
  const generatedAt = same && typeof previous.generatedAt === "string" ? previous.generatedAt : now.toISOString();
  return { index: { schemaVersion: SCHEMA_VERSION, generatedAt, extensions }, notes };
}
