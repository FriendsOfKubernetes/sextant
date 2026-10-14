// sdk/scripts/pack.mjs: a folder in, a `.sextant-ext` out — only what Sextant would accept.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packFolder, PackError } from "../scripts/pack.mjs";
import { unzip } from "../scripts/zip.mjs";

const MANIFEST = {
  id: "demo.pack",
  name: "Demo",
  version: "1.2.3",
  description: "",
  author: "Me",
  sextantApi: 1,
  entry: "index.html",
  permissions: { clusters: { type: "all" }, rules: [] },
  contributes: { pages: [{ id: "main", title: "Main", section: "demo" }] },
};

let dir: string;
let folder: string;

function write(path: string, content: string | Buffer) {
  const target = join(folder, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof PackError) return err.message;
    throw err;
  }
  throw new Error("packed");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sextant-pack-"));
  folder = join(dir, "dist");
  write("sextant-extension.json", JSON.stringify(MANIFEST));
  write("index.html", "<!doctype html><script src=main.js></script>");
  write("assets/main.js", "console.log(1)");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pack", () => {
  it("writes <id>-<version>.sextant-ext next to the folder with every file, deflated", () => {
    write("assets/big.txt", "x".repeat(10_000));
    const result = packFolder(folder);
    expect(result.output).toBe(join(dir, "demo.pack-1.2.3.sextant-ext"));
    const entries = unzip(readFileSync(result.output));
    expect(entries.map((e) => e.path)).toEqual(["assets/big.txt", "assets/main.js", "index.html", "sextant-extension.json"]);
    expect(entries.find((e) => e.path === "assets/big.txt")!.data.toString()).toBe("x".repeat(10_000));
    expect(result.bytes).toBeLessThan(5000);
    expect(entries.every((e) => (e.mode & 0o170000) === 0o100000)).toBe(true);
  });

  it("gives the same bytes for the same files", () => {
    const first = readFileSync(packFolder(folder, { out: join(dir, "a") }).output);
    const second = readFileSync(packFolder(folder, { out: join(dir, "b") }).output);
    expect(first.equals(second)).toBe(true);
  });

  it("leaves out dot entries, node_modules and a package written into the folder", () => {
    write(".git/config", "x");
    write(".env", "x");
    write("node_modules/x/index.js", "x");
    write("Node_Modules/y.js", "x");
    packFolder(folder, { out: folder });
    const again = packFolder(folder, { out: folder });
    const paths = unzip(readFileSync(again.output)).map((e) => e.path);
    expect(paths).toEqual(["assets/main.js", "index.html", "sextant-extension.json"]);
  });

  it("checks and lists without writing in a dry run", () => {
    const result = packFolder(folder, { dryRun: true });
    expect(result.files.map((f: { path: string }) => f.path)).toContain("index.html");
    expect(result.bytes).toBeNull();
    expect(existsSync(result.output)).toBe(false);
  });

  it("refuses a manifest Sextant refuses, naming the field", () => {
    write("sextant-extension.json", JSON.stringify({ ...MANIFEST, id: "Demo" }));
    expect(errorOf(() => packFolder(folder))).toMatch(/^sextant-extension\.json: id: must be 3–64 characters/);
    write("sextant-extension.json", "{");
    expect(errorOf(() => packFolder(folder))).toBe("sextant-extension.json: not valid JSON");
  });

  it("refuses a folder without the manifest or without its entry", () => {
    rmSync(join(folder, "sextant-extension.json"));
    expect(errorOf(() => packFolder(folder))).toContain("has no sextant-extension.json");
    write("sextant-extension.json", JSON.stringify({ ...MANIFEST, entry: "app/index.html" }));
    expect(errorOf(() => packFolder(folder))).toBe("sextant-extension.json: entry: `app/index.html` is not in the package");
  });

  it.runIf(process.platform !== "win32")("refuses symbolic links", () => {
    symlinkSync("/etc/hostname", join(folder, "assets", "link.txt"));
    expect(errorOf(() => packFolder(folder))).toContain("`assets/link.txt` is a symbolic link");
  });

  // Linux only: other systems do not let a folder hold such names.
  it.runIf(process.platform === "linux")("refuses names Sextant refuses or that collide ignoring case", () => {
    write("assets/Main.js", "x");
    expect(errorOf(() => packFolder(folder))).toContain("`assets/main.js` twice");
    rmSync(join(folder, "assets", "Main.js"));
    write("nul.js", "x");
    expect(errorOf(() => packFolder(folder))).toContain("`nul.js` is not a plain relative path");
    rmSync(join(folder, "nul.js"));
    write("a:b.js", "x");
    expect(errorOf(() => packFolder(folder))).toContain("`a:b.js`");
  });
});
