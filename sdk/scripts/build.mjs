#!/usr/bin/env node
// Builds an extension project into a folder Sextant can load ("Load unpacked folder…") or `pack.mjs` can pack:
// Vite bundles the project's `index.html` and what it imports (TypeScript included) with relative URLs, `public/` is
// copied as is, and `sextant-extension.json` is checked and copied to the top of the output.
//
// The bundled script and styles are then put inside `index.html` (`<script type="module">…</script>`, `<style>`), and
// small assets become `data:` URLs. An extension's frame is sandboxed without `allow-same-origin`: its origin is
// opaque, and on Linux (WebKitGTK) the CSP's `'self'` then matches none of the package's files, so a
// `<script src="…">` or a stylesheet link is blocked while inline code runs. `--no-inline` keeps separate files.
//
//   node sdk/scripts/build.mjs <project> [--out <dir>] [--no-inline]      (default <project>/dist)
//
// `@sextant/extension-sdk` resolves to this SDK, so a project inside the repository builds without installing it.
import { copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { checkManifestBytes, formatManifestError, MANIFEST_FILE } from "./manifest.mjs";

const SDK_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

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
  return outDir;
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
