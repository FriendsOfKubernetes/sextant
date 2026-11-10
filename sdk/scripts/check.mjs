#!/usr/bin/env node
// `npm run sdk:check`, after tsc and vitest: builds the template, the examples and Sextant's own extensions
// (`extensions/`) into a temporary folder and packs each in a dry run, so a manifest Sextant would refuse or a build
// that breaks fails the check. The backend examples (ADR-0131: TypeScript through componentize-js, Rust through
// cargo for wasm32-wasip2) are then run by Sextant's own runtime (`cargo run -p sextant-ext-runtime --example run`,
// a stand-in host) to prove they load and answer — a problem judge (ADR-0168) with objects as Sextant sends them.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildExtension } from "./build.mjs";
import { packFolder } from "./pack.mjs";

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Sextant's own extensions (`extensions/<name>`, ADR-0139), built against this SDK. */
const EXTENSIONS = readdirSync(resolve(sdk, "..", "extensions"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => `../extensions/${entry.name}`);
const PROJECTS = ["template", "examples/hello-page", "examples/crd-view", "examples/backend-ts", "examples/backend-rust"];
/** What each backend must answer to the stand-in host (one cluster, no network). */
const BACKEND_CALLS = [
  ["ping", null, (answer) => answer === "pong"],
  ["summary", null, (answer) => answer?.clusters === 1 && answer.latest === null && typeof answer.error === "string"],
];
const service = (uid, namespace, selector) => ({
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: `svc-${uid}`, namespace, uid },
  values: { ".spec.selector": selector },
});
/** What a backend with a problem judge (ADR-0168) must answer besides, by project. */
const JUDGE_CALLS = {
  "examples/backend-ts": [
    [
      "problemJudge:same-selector",
      { objects: [service("a", "shop", { app: "web" }), service("b", "shop", { app: "web" }), service("c", "other", { app: "web" })] },
      (answer) =>
        JSON.stringify(answer) ===
        JSON.stringify([
          { uid: "a", fact: "shared", values: { other: "svc-b" } },
          { uid: "b", fact: "shared", values: { other: "svc-a" } },
        ]),
    ],
  ],
};

function runBackend(wasm, method, params) {
  const run = spawnSync(
    "cargo",
    ["run", "-q", "-p", "sextant-ext-runtime", "--example", "run", "--", wasm, method, JSON.stringify(params)],
    { cwd: resolve(sdk, ".."), encoding: "utf8" },
  );
  if (run.error) throw new Error(`cargo cannot be run: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${method}: ${run.stderr.trim().split("\n").pop()}`);
  return JSON.parse(run.stdout);
}

const out = mkdtempSync(join(tmpdir(), "sextant-sdk-check-"));
try {
  for (const project of [...PROJECTS, ...EXTENSIONS]) {
    const built = await buildExtension(join(sdk, project), { out: join(out, project.replaceAll("../", "")), quiet: true });
    const { manifest, files } = packFolder(built, { dryRun: true });
    process.stdout.write(`sdk: ${project} builds and packs (${manifest.id} ${manifest.version}, ${files.length} files)\n`);
    if (manifest.backend) {
      const wasm = join(built, ...manifest.backend.module.split("/"));
      if (EXTENSIONS.includes(project)) {
        // Sextant's own extensions answer methods of their own: the backend loads and answers an unknown one so.
        try {
          runBackend(wasm, "ping", null);
        } catch (err) {
          if (!/unknown method ping/.test(err.message)) throw new Error(`${project}: ${err.message}`);
        }
      } else {
        for (const [method, params, expected] of [...BACKEND_CALLS, ...(JUDGE_CALLS[project] ?? [])]) {
          const answer = runBackend(wasm, method, params);
          if (!expected(answer)) throw new Error(`${project}: ${method} answered ${JSON.stringify(answer)}`);
        }
      }
      process.stdout.write(`sdk: ${project}'s backend runs in Sextant's runtime\n`);
    }
  }
} catch (err) {
  process.stderr.write(`sdk: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
