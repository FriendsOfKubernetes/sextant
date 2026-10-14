// sdk/scripts/build.mjs: a project in, a folder Sextant loads out — one index.html with its script and styles inside.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExtension, inlineAssets } from "../scripts/build.mjs";

const SDK = resolve(import.meta.dirname, "..");
let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "sextant-build-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe("build", () => {
  it("puts the manifest and one self-contained index.html in the output", async () => {
    const dist = await buildExtension(join(SDK, "examples/hello-page"), { out: join(out, "dist"), quiet: true });
    expect(readdirSync(dist).sort()).toEqual(["index.html", "sextant-extension.json"]);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    // Files of the package are not loaded by URL: in Sextant's sandboxed frame only inline code runs everywhere.
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*stylesheet/);
    expect(html).toMatch(/<script type="module">[\s\S]*startPodsPage|<script type="module">[\s\S]*Pods in/);
    expect(html).toContain("<style>");
    expect(existsSync(join(dist, "assets"))).toBe(false);
  });

  it("keeps files when asked", async () => {
    const dist = await buildExtension(join(SDK, "template"), { out: join(out, "dist"), quiet: true, inline: false });
    expect(readFileSync(join(dist, "index.html"), "utf8")).toMatch(/<script type="module" crossorigin src="\.\/assets\//);
  });
});

describe("inlineAssets", () => {
  it("inlines module scripts and stylesheets of the package and escapes a closing script tag", () => {
    const files: Record<string, string> = {
      "assets/a.js": 'const s = "</script>"; console.log(s);',
      "assets/a.css": "body { color: red }",
    };
    const { html, inlined } = inlineAssets(
      '<head><script type="module" crossorigin src="./assets/a.js"></script>\n<link rel="stylesheet" crossorigin href="./assets/a.css"><link rel="icon" href="./x.png"></head>',
      (path: string) => files[path],
    );
    expect(html).toBe(
      '<head><script type="module">const s = "<\\/script>"; console.log(s);</script>\n<style>body { color: red }</style><link rel="icon" href="./x.png"></head>',
    );
    expect(inlined).toEqual(["assets/a.js", "assets/a.css"]);
  });

  it("leaves what is not a file of the package", () => {
    const html = '<script type="module" src="https://example.com/x.js"></script>';
    expect(inlineAssets(html, () => undefined).html).toBe(html);
  });
});
