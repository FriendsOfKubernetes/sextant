#!/usr/bin/env node
// `npm run sdk:check`, after tsc and vitest: builds the template and both examples into a temporary folder and packs
// each in a dry run, so a manifest Sextant would refuse or a build that breaks fails the check.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildExtension } from "./build.mjs";
import { packFolder } from "./pack.mjs";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECTS = ["template", "examples/hello-page", "examples/crd-view"];

const out = mkdtempSync(join(tmpdir(), "sextant-sdk-check-"));
try {
  for (const project of PROJECTS) {
    const built = await buildExtension(join(sdk, project), { out: join(out, project), quiet: true });
    const { manifest, files } = packFolder(built, { dryRun: true });
    process.stdout.write(`sdk: ${project} builds and packs (${manifest.id} ${manifest.version}, ${files.length} files)\n`);
  }
} catch (err) {
  process.stderr.write(`sdk: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
