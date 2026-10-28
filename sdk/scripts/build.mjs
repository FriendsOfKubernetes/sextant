#!/usr/bin/env node
// Builds an extension project into a folder Sextant can load ("Load unpacked folder…") or `pack.mjs` can pack:
// Vite bundles the project's `index.html` and what it imports (TypeScript included) with relative URLs, `public/` is
// copied as is, and `sextant-extension.json` is checked and copied to the top of the output.
//
// The bundled script and styles are then put inside `index.html` (`<script type="module">…</script>`, `<style>`), and
// small assets become `data:` URLs: one file to serve and nothing to lose on the way. Separate files work too — the
// extension's CSP allows scripts, styles, images and fonts from its own folder — and `--no-inline` keeps them.
//
//   node sdk/scripts/build.mjs <project> [--out <dir>] [--no-inline]      (default <project>/dist)
//
// `@sextant/extension-sdk` resolves to this SDK, so a project inside the repository builds without installing it.
//
// A manifest with a `backend` (ADR-0131) also gets its component, written to `backend.module` in the output:
// - `backend/main.ts` (or `main.js`): bundled into one ES module (`@sextant/extension-sdk/backend` included), then
//   made a component of `sdk/wit/sextant-extension.wit` by componentize-js (a dev dependency of Sextant; in a copy of
//   the SDK, `npm install -D @bytecodealliance/componentize-js@0.23.0`);
// - `backend/Cargo.toml`: `cargo build --release --target wasm32-wasip2` (`rustup target add wasm32-wasip2`), the
//   crate's `cdylib` copied.
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkManifestBytes, formatManifestError, MANIFEST_FILE } from "./manifest.mjs";

const SDK_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const SDK_BACKEND = resolve(dirname(fileURLToPath(import.meta.url)), "../src/backend.ts");
export const WIT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../wit/sextant-extension.wit");
/** The componentize-js version the SDK is checked with. */
export const COMPONENTIZE_JS = "0.23.0";

export class BuildError extends Error {}

/**
 * `html` with each module script and stylesheet of the package (a relative URL `readFile` knows) put inside it;
 * returns the new HTML and the package paths it took in.
 *
 * @param {string} html
 * @param {(path: string) => string | undefined} readFile
 */
export function inlineAssets(html, readFile) {
  const inlined = [];
  const local = (url) => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null;
    const path = url.replace(/^\.\//, "").split(/[?#]/)[0];
    const content = readFile(path);
    if (content === undefined) return null;
    inlined.push(path);
    return content;
  };
  const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
  let out = html.replace(/<script\b[^>]*><\/script>/g, (tag) => {
    const src = attribute(tag, "src");
    if (!src || attribute(tag, "type") !== "module") return tag;
    const code = local(src);
    return code === null ? tag : `<script type="module">${code.replace(/<\/(script)/gi, "<\\/$1")}</script>`;
  });
  out = out.replace(/<link\b[^>]*>/g, (tag) => {
    const href = attribute(tag, "href");
    if (!href || attribute(tag, "rel") !== "stylesheet") return tag;
    const css = local(href);
    return css === null ? tag : `<style>${css.replace(/<\/(style)/gi, "<\\/$1")}</style>`;
  });
  return { html: out, inlined };
}

/** Removes empty folders under `dir` (not `dir` itself). */
function removeEmptyFolders(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    removeEmptyFolders(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true });
  }
}

/**
 * Builds `project` into `out` (default `<project>/dist`); returns the output folder.
 *
 * @param {string} project
 * @param {{ out?: string, quiet?: boolean, inline?: boolean }} [options]
 */
export async function buildExtension(project, { out, quiet = false, inline = true } = {}) {
  const root = resolve(project);
  let bytes;
  try {
    bytes = readFileSync(join(root, MANIFEST_FILE));
  } catch {
    throw new BuildError(`${project} has no ${MANIFEST_FILE}`);
  }
  const checked = checkManifestBytes(bytes);
  if (checked.error) throw new BuildError(formatManifestError(checked.error));
  const outDir = resolve(out ?? join(root, "dist"));
  const { build } = await import("vite");
  await build({
    root,
    base: "./",
    configFile: false,
    logLevel: quiet ? "error" : "warn",
    resolve: { alias: [{ find: /^@sextant\/extension-sdk$/, replacement: SDK_ENTRY }] },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      // Inline scripts are allowed (CSP 'unsafe-inline'), but a frame has no use for the preload polyfill.
      modulePreload: { polyfill: false },
      // Small images and fonts as data: URLs (allowed by the CSP); see above for scripts and styles.
      assetsInlineLimit: inline ? 64 * 1024 : 0,
      reportCompressedSize: false,
      rolldownOptions: { input: join(root, checked.manifest.entry), output: { codeSplitting: !inline } },
    },
  });
  if (inline) {
    const page = join(outDir, ...checked.manifest.entry.split("/"));
    const pageDir = dirname(page);
    const read = (path) => {
      try {
        return readFileSync(join(pageDir, ...path.split("/")), "utf8");
      } catch {
        return undefined;
      }
    };
    const { html, inlined } = inlineAssets(readFileSync(page, "utf8"), read);
    writeFileSync(page, html);
    for (const path of inlined) rmSync(join(pageDir, ...path.split("/")));
    removeEmptyFolders(outDir);
  }
  copyFileSync(join(root, MANIFEST_FILE), join(outDir, MANIFEST_FILE));
  if (checked.manifest.backend) {
    const target = join(outDir, ...checked.manifest.backend.module.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await buildBackend(root, quiet));
  }
  return outDir;
}

/**
 * The backend component of the project at `root` (ADR-0131): from `backend/main.ts`/`main.js` through componentize-js,
 * or from `backend/Cargo.toml` through cargo. Returns its bytes.
 *
 * @param {string} root
 * @param {boolean} quiet
 */
export async function buildBackend(root, quiet = false) {
  const dir = join(root, "backend");
  if (existsSync(join(dir, "Cargo.toml"))) return buildRustBackend(dir);
  const entry = ["main.ts", "main.js"].map((name) => join(dir, name)).find((path) => existsSync(path));
  if (!entry) {
    throw new BuildError(`${MANIFEST_FILE} declares a backend, but the project has no backend/main.ts, backend/main.js or backend/Cargo.toml`);
  }
  let componentize;
  try {
    ({ componentize } = await import("@bytecodealliance/componentize-js"));
  } catch {
    throw new BuildError(
      `a TypeScript backend needs componentize-js: npm install -D @bytecodealliance/componentize-js@${COMPONENTIZE_JS}`,
    );
  }
  const temp = mkdtempSync(join(tmpdir(), "sextant-backend-"));
  try {
    const { build } = await import("vite");
    await build({
      root: dir,
      configFile: false,
      logLevel: quiet ? "error" : "warn",
      resolve: { alias: [{ find: /^@sextant\/extension-sdk\/backend$/, replacement: SDK_BACKEND }] },
      build: {
        outDir: temp,
        emptyOutDir: true,
        target: "es2022",
        minify: false,
        reportCompressedSize: false,
        lib: { entry, formats: ["es"], fileName: () => "backend.js" },
        rolldownOptions: { external: [/^sextant:/, /^wasi:/] },
      },
    });
    const source = readFileSync(join(temp, "backend.js"), "utf8");
    // The WIT and the source are passed as text: componentize-js reads files through its own sandbox.
    const { component } = await componentize(source, readFileSync(WIT_PATH, "utf8"), {
      worldName: "backend",
      // Not an HTTP server: no incoming-handler export.
      disableFeatures: ["fetch-event"],
    });
    return Buffer.from(component);
  } catch (err) {
    if (err instanceof BuildError) throw err;
    throw new BuildError(`the backend does not build: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** `cargo build` of a backend crate for `wasm32-wasip2`; the one `.wasm` it makes. */
function buildRustBackend(dir) {
  const targetDir = join(dir, "target");
  const run = spawnSync("cargo", ["build", "--release", "--target", "wasm32-wasip2", "--target-dir", targetDir], {
    cwd: dir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.error) throw new BuildError(`cargo cannot be run: ${run.error.message}`);
  if (run.status !== 0) {
    throw new BuildError("cargo build of the backend failed (is the target installed? rustup target add wasm32-wasip2)");
  }
  const out = join(targetDir, "wasm32-wasip2", "release");
  const wasm = readdirSync(out).filter((name) => name.endsWith(".wasm"));
  if (wasm.length !== 1) throw new BuildError(`expected one .wasm in ${out}, found ${wasm.length}`);
  return readFileSync(join(out, wasm[0]));
}

async function main(argv) {
  let project = null;
  let out;
  let inline = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--no-inline") inline = false;
    else if (project === null) project = argv[i];
    else throw new BuildError(`unexpected argument ${argv[i]}`);
  }
  if (!project) {
    process.stdout.write("usage: build <project> [--out <dir>] [--no-inline]\n");
    return 2;
  }
  const outDir = await buildExtension(project, { out, inline });
  const rel = relative(process.cwd(), outDir);
  process.stdout.write(`built ${rel && !rel.startsWith("..") ? rel : outDir}\n`);
  return 0;
}

export async function run(argv = process.argv.slice(2)) {
  try {
    return await main(argv);
  } catch (err) {
    if (err instanceof BuildError) {
      process.stderr.write(`build: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run();
