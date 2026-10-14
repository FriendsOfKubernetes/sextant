#!/usr/bin/env node
// Packs an extension folder (the one with `sextant-extension.json` at its top, e.g. a build's `dist/`) into
// `<id>-<version>.sextant-ext`, checked as Sextant checks a package before it asks the user anything: a valid manifest,
// its entry present, only plain relative paths (no symbolic links, no names that collide ignoring case, nothing
// Windows reads as a device), at most 2000 files and 50 MB. As when Sextant reads a folder, entries whose name starts
// with `.` and `node_modules` folders are left out.
//
//   node sdk/scripts/pack.mjs <folder> [--out <dir>] [--dry-run]
//
// Without `--out` the package goes next to the folder. `--dry-run` checks and lists, writes nothing.
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkManifestBytes, formatManifestError, isPackagePath, MANIFEST_FILE } from "./manifest.mjs";
import { zip } from "./zip.mjs";

export const MAX_FILES = 2000;
export const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const PACKAGE_EXTENSION = ".sextant-ext";

export class PackError extends Error {}

/**
 * The files of the package in `folder`: `[{path, size, source}]`, sorted by path; throws `PackError`.
 *
 * @param {string} folder
 * @param {{ skip?: (source: string) => boolean }} [options]
 */
export function collectFiles(folder, { skip = () => false } = {}) {
  const files = [];
  const seenFiles = new Set();
  const seenDirs = new Set();
  let total = 0;
  const walk = (dir, prefix) => {
    const names = readdirSync(dir).sort();
    for (const name of names) {
      if (name.startsWith(".") || name.toLowerCase() === "node_modules") continue;
      const source = join(dir, name);
      if (skip(source)) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new PackError(`\`${path}\` is a symbolic link; Sextant refuses packages with links`);
      if (!isPackagePath(path)) {
        throw new PackError(`\`${path}\` is not a plain relative path Sextant accepts (no \\ : * ? " < > |, no names ending with . or a space, no device names such as nul or con)`);
      }
      const lower = path.toLowerCase();
      if (stat.isDirectory()) {
        if (seenFiles.has(lower)) throw new PackError(`the package has both a file and a folder named \`${path}\``);
        seenDirs.add(lower);
        walk(source, path);
      } else if (stat.isFile()) {
        if (seenFiles.has(lower)) throw new PackError(`the package has \`${path}\` twice (names are compared ignoring case)`);
        if (seenDirs.has(lower)) throw new PackError(`the package has both a file and a folder named \`${path}\``);
        seenFiles.add(lower);
        if (files.length >= MAX_FILES) throw new PackError(`the package has more than ${MAX_FILES} files`);
        total += stat.size;
        if (total > MAX_UNPACKED_BYTES) throw new PackError(`the package unpacks to more than ${MAX_UNPACKED_BYTES} bytes`);
        files.push({ path, size: stat.size, source });
      } else {
        throw new PackError(`\`${path}\` is not a regular file`);
      }
    }
  };
  walk(folder, "");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Checks `folder` and packs it. Returns `{manifest, files, output, bytes}` (`bytes` is `null` in a dry run); throws
 * `PackError` with the reason Sextant would refuse it.
 *
 * @param {string} folder
 * @param {{ out?: string, dryRun?: boolean }} [options]
 */
export function packFolder(folder, { out, dryRun = false } = {}) {
  const root = resolve(folder);
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    throw new PackError(`${folder} does not exist`);
  }
  if (!stat.isDirectory()) throw new PackError(`${folder} is not a folder`);
  let manifestBytes;
  try {
    manifestBytes = readFileSync(join(root, MANIFEST_FILE));
  } catch {
    throw new PackError(`${folder} has no ${MANIFEST_FILE} at its top`);
  }
  const checked = checkManifestBytes(manifestBytes);
  if (checked.error) throw new PackError(formatManifestError(checked.error));
  const { manifest } = checked;
  const outDir = resolve(out ?? dirname(root));
  const output = join(outDir, `${manifest.id}-${manifest.version}${PACKAGE_EXTENSION}`);
  // An earlier package written into the folder itself is not part of the next one.
  const files = collectFiles(root, { skip: (source) => source.endsWith(PACKAGE_EXTENSION) && dirname(source) === root });
  if (!files.some((f) => f.path === manifest.entry)) {
    throw new PackError(`${MANIFEST_FILE}: entry: \`${manifest.entry}\` is not in the package`);
  }
  if (dryRun) return { manifest, files, output, bytes: null };
  const archive = zip(files.map((f) => ({ path: f.path, data: readFileSync(f.source) })));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(output, archive);
  return { manifest, files, output, bytes: archive.length };
}

function parseArgs(argv) {
  const args = { folder: null, out: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (args.folder === null) args.folder = arg;
    else throw new PackError(`unexpected argument ${arg}`);
  }
  return args;
}

/** A path relative to the current folder when it is inside it, else absolute. */
const shown = (path) => {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith("..") ? rel : path;
};

export function main(argv = process.argv.slice(2)) {
  const usage = "usage: pack <folder> [--out <dir>] [--dry-run]\n";
  try {
    const args = parseArgs(argv);
    if (args.help || !args.folder) {
      process.stdout.write(usage);
      return args.help ? 0 : 2;
    }
    const result = packFolder(args.folder, args);
    const where = shown(result.output);
    const size = result.files.reduce((n, f) => n + f.size, 0);
    if (args.dryRun) {
      process.stdout.write(`${result.manifest.id} ${result.manifest.version}: ${result.files.length} files, ${size} bytes — would write ${where}\n`);
    } else {
      process.stdout.write(`${where} (${result.files.length} files, ${result.bytes} bytes)\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof PackError) {
      process.stderr.write(`pack: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
