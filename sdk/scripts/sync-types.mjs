#!/usr/bin/env node
// Copies the TypeScript types the SDK shares with Sextant from `src/api/generated/` (written by ts-rs from the Rust
// types) to `sdk/src/generated/`, with everything they import. The SDK is self-contained; `test/types.test.ts` fails
// when the copies drift from the originals — run `npm run sdk:sync-types` then.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = resolve(here, "../../src/api/generated");
export const TARGET_DIR = resolve(here, "../src/generated");

/** The types the SDK uses; their imports come along. */
export const ROOTS = [
  "ExtensionManifest",
  "ObjectRef",
  "KindRef",
  "ResourceKind",
  "WatchUpdate",
  "ErrorCode",
  "ClusterId",
  "ConnectionState",
  "PatchType",
  "CoreError",
];

/** `{relative path (posix, with .ts) → content}` of every file to copy. */
export function plannedFiles(sourceDir = SOURCE_DIR) {
  const files = new Map();
  const pending = ROOTS.map((name) => `${name}.ts`);
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    const content = readFileSync(join(sourceDir, ...file.split("/")), "utf8");
    files.set(file, content);
    for (const match of content.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = join(dirname(file), match[1]).split(sep).join("/");
      pending.push(`${target}.ts`);
    }
  }
  return new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Every `.ts` file under `dir`, as posix paths relative to it. */
export function existingFiles(dir = TARGET_DIR) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) out.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function sync() {
  rmSync(TARGET_DIR, { recursive: true, force: true });
  for (const [file, content] of plannedFiles()) {
    const target = join(TARGET_DIR, ...file.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  process.stdout.write(`synced ${plannedFiles().size} files into ${relative(process.cwd(), TARGET_DIR)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) sync();
