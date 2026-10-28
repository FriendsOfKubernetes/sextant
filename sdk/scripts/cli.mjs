#!/usr/bin/env node
// `sextant-ext` — the SDK's command line: build, pack and check extensions.
//
//   sextant-ext build <project> [--out <dir>]          bundle the project into <project>/dist (or <dir>)
//   sextant-ext pack <folder> [--out <dir>] [--dry-run] check the folder and write <id>-<version>.sextant-ext
//   sextant-ext check <folder | sextant-extension.json> check a manifest as Sextant does
//   sextant-ext keygen | sign | verify …               sign packages for the extension catalog (see sign.mjs)
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { run as build } from "./build.mjs";
import { checkManifestBytes, formatManifestError, MANIFEST_FILE } from "./manifest.mjs";
import { main as pack } from "./pack.mjs";
import { main as signing } from "./sign.mjs";

function check(target) {
  if (!target) {
    process.stderr.write(`usage: sextant-ext check <folder | ${MANIFEST_FILE}>\n`);
    return 2;
  }
  let path = target;
  try {
    if (statSync(target).isDirectory()) path = join(target, MANIFEST_FILE);
    const result = checkManifestBytes(readFileSync(path));
    if (result.error) {
      process.stderr.write(`${formatManifestError(result.error)}\n`);
      return 1;
    }
    process.stdout.write(`${result.manifest.id} ${result.manifest.version}: the manifest is valid\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`cannot read ${path}: ${err.message}\n`);
    return 1;
  }
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  build: () => build(rest),
  pack: () => pack(rest),
  check: () => check(rest[0]),
  keygen: () => signing("keygen", rest),
  sign: () => signing("sign", rest),
  verify: () => signing("verify", rest),
};
if (!commands[command]) {
  process.stdout.write("usage: sextant-ext build|pack|check|keygen|sign|verify …\n");
  process.exitCode = command ? 2 : 0;
} else {
  process.exitCode = await commands[command]();
}
