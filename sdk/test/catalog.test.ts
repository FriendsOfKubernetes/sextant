// @vitest-environment node
// sdk/scripts/catalog.mjs: the rules the catalog repository's workflow checks entries and releases with, and how it
// writes `index.json`. The fixture package is also read by the app's tests (crates/sextant-core/src/extensions/catalog.rs).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assetVersion,
  buildIndex,
  CatalogError,
  checkEntry,
  checkRelease,
  compareVersions,
  isReleaseTag,
  isRepository,
  pickRelease,
  releaseUrl,
} from "../scripts/catalog.mjs";
import { generateKeyPair, parseSecretKey, sign } from "../scripts/minisign.mjs";
import { unzip, zip } from "../scripts/zip.mjs";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/catalog/${name}`, import.meta.url));
const PUBLISHER = fixture("publisher.pub").toString().trim().split("\n")[1];
const ASSET = "demo.catalog-1.0.0.sextant-ext";

const ENTRY = {
  id: "demo.catalog",
  name: "Catalog demo",
  author: "Sextant tests",
  description: "A package of the catalog tests",
  categories: ["developer"],
  repository: "FriendsOfKubernetes/demo",
  publisherKey: PUBLISHER,
};

function failure(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof CatalogError) return err.message;
    throw err;
  }
  throw new Error("accepted");
}

const picked = { tag: "v1.0.0", asset: ASSET, version: "1.0.0", publishedAt: "2026-10-28T00:00:00Z" };

describe("entries", () => {
  it("accept a reviewed entry and keep its fields in order", () => {
    const entry = checkEntry({ ...ENTRY, withdrawn: { reason: "Replaced by demo.catalog2" } }, "demo.catalog.json");
    expect(Object.keys(entry)).toEqual(["id", "name", "author", "description", "categories", "repository", "publisherKey", "withdrawn"]);
  });

  it("refuse what the app would not read", () => {
    const of = (patch: object, file = "demo.catalog.json") => failure(() => checkEntry({ ...ENTRY, ...patch }, file));
    expect(of({}, "other.json")).toBe("other.json: id: the file must be named demo.catalog.json");
    expect(of({ id: "Demo" }, "Demo.json")).toBe("Demo.json: id: must be an extension id, as in the manifest");
    expect(of({ homepage: "https://x" })).toBe("demo.catalog.json: homepage: is not a field of an entry");
    expect(of({ name: " " })).toBe("demo.catalog.json: name: must be 1–80 characters, not only spaces");
    expect(of({ description: "line\u0007" })).toBe("demo.catalog.json: description: must be 1–500 characters, not only spaces");
    expect(of({ categories: [] })).toBe("demo.catalog.json: categories: must list 1 to 3 categories");
    expect(of({ categories: ["games"] })).toMatch(/^demo\.catalog\.json: categories: `games` is not one of observability, /);
    expect(of({ categories: ["cost", "cost"] })).toBe("demo.catalog.json: categories: lists a category twice");
    expect(of({ repository: "https://github.com/a/b" })).toBe("demo.catalog.json: repository: must be `<owner>/<repository>` on GitHub");
    expect(of({ publisherKey: "not a key!" })).toBe("demo.catalog.json: publisherKey: the public key is not base64");
    expect(of({ publisherKey: fixture("publisher.pub").toString() })).toBe(
      "demo.catalog.json: publisherKey: must be the base64 line of the minisign public key alone",
    );
    expect(of({ withdrawn: { reason: "x", by: "me" } })).toBe('demo.catalog.json: withdrawn: must be `{ "reason": "…" }`');
  });

  it("name repositories, tags and versions by the app's rules", () => {
    expect(isRepository("FriendsOfKubernetes/sextant-extensions")).toBe(true);
    for (const bad of ["a/..", "-a/b", "a/b/c", "a", "a/b?x"]) expect(isRepository(bad)).toBe(false);
    expect(isReleaseTag("v1.2.3")).toBe(true);
    for (const bad of ["release/1", "v1 2", "", "../x", "v1%2F"]) expect(isReleaseTag(bad)).toBe(false);
    expect(assetVersion("demo.catalog", ASSET)).toBe("1.0.0");
    for (const bad of ["demo.catalog-1.0.sextant-ext", "demo.catalog-1.0.0-beta.sextant-ext", "demo.catalog-01.0.0.sextant-ext", "x-1.0.0.sextant-ext"]) {
      expect(assetVersion("demo.catalog", bad)).toBeNull();
    }
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(releaseUrl("o/r", "v1", ASSET)).toBe(`https://github.com/o/r/releases/download/v1/${ASSET}`);
  });
});

describe("releases", () => {
  const asset = (name: string) => ({ name, browser_download_url: `https://github.com/o/r/releases/download/t/${name}` });

  it("pick the newest published release that carries one signed package of the id", () => {
    const releases = [
      { tag_name: "v3.0.0", draft: true, prerelease: false, assets: [asset("demo.catalog-3.0.0.sextant-ext"), asset("demo.catalog-3.0.0.sextant-ext.minisig")] },
      { tag_name: "v2.1.0-rc.1", draft: false, prerelease: true, assets: [asset("demo.catalog-2.1.0.sextant-ext"), asset("demo.catalog-2.1.0.sextant-ext.minisig")] },
      { tag_name: "v2.0.1", draft: false, prerelease: false, assets: [asset("demo.catalog-2.0.1.sextant-ext")] },
      { tag_name: "v2.0.0", draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z", assets: [asset("demo.catalog-2.0.0.sextant-ext"), asset("demo.catalog-2.0.0.sextant-ext.minisig"), asset("notes.txt")] },
    ];
    expect(pickRelease(ENTRY, releases)).toEqual({
      tag: "v2.0.0",
      asset: "demo.catalog-2.0.0.sextant-ext",
      version: "2.0.0",
      publishedAt: "2026-10-01T00:00:00Z",
      packageUrl: "https://github.com/o/r/releases/download/t/demo.catalog-2.0.0.sextant-ext",
      signatureUrl: "https://github.com/o/r/releases/download/t/demo.catalog-2.0.0.sextant-ext.minisig",
    });
    const two = [{ tag_name: "v1", draft: false, prerelease: false, assets: [asset("demo.catalog-1.0.0.sextant-ext"), asset("demo.catalog-1.0.1.sextant-ext"), asset("demo.catalog-1.0.0.sextant-ext.minisig")] }];
    expect(pickRelease(ENTRY, two)).toBeNull();
    expect(pickRelease(ENTRY, [{ tag_name: "a/b", assets: [asset(ASSET), asset(`${ASSET}.minisig`)] }])).toBeNull();
  });

  it("are listed with their size, digest, key and what the manifest asks for", () => {
    const latest = checkRelease(checkEntry(ENTRY, "demo.catalog.json"), picked, fixture(ASSET), fixture(`${ASSET}.minisig`).toString());
    expect(latest).toMatchObject({
      version: "1.0.0",
      sextantApi: 1,
      tag: "v1.0.0",
      asset: ASSET,
      size: fixture(ASSET).length,
      publishedAt: "2026-10-28T00:00:00Z",
      contributes: { pages: 1 },
      permissions: { clusters: { type: "all" } },
    });
    expect(latest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(latest.keyId).toMatch(/^[0-9A-F]{16}$/);
  });

  it("are refused when the signature, the name or the manifest do not match", () => {
    const entry = checkEntry(ENTRY, "demo.catalog.json");
    const signature = fixture(`${ASSET}.minisig`).toString();
    const otherKey = checkEntry({ ...ENTRY, publisherKey: fixture("other.pub").toString().trim().split("\n")[1] }, "demo.catalog.json");
    expect(failure(() => checkRelease(otherKey, picked, fixture(ASSET), signature))).toMatch(/^demo\.catalog v1\.0\.0: signature: the file is signed with key /);
    const changed = Buffer.from(fixture(ASSET));
    changed[changed.length - 30] = changed[changed.length - 30]! ^ 1;
    expect(failure(() => checkRelease(entry, picked, changed, signature))).toBe("demo.catalog v1.0.0: signature: the signature does not match the file");

    // Signed by the right key, but not what the entry and the file name promise.
    const key = parseSecretKey(fixture("publisher.key").toString());
    const signed = (files: { path: string; data: Buffer }[]) => {
      const bytes = zip(files);
      return [bytes, sign(bytes, key)] as const;
    };
    const manifest = JSON.parse(unzip(fixture(ASSET)).find((file) => file.path === "sextant-extension.json")!.data.toString());
    const [wrongVersion, wrongVersionSig] = signed([
      { path: "sextant-extension.json", data: Buffer.from(JSON.stringify({ ...manifest, version: "1.0.1" })) },
      { path: "index.html", data: Buffer.from("x") },
    ]);
    expect(failure(() => checkRelease(entry, picked, wrongVersion, wrongVersionSig))).toBe(
      "demo.catalog v1.0.0: the manifest's version is 1.0.1, the file name says 1.0.0",
    );
    const [noEntry, noEntrySig] = signed([{ path: "sextant-extension.json", data: Buffer.from(JSON.stringify(manifest)) }]);
    expect(failure(() => checkRelease(entry, picked, noEntry, noEntrySig))).toBe("demo.catalog v1.0.0: the manifest's entry `index.html` is not in the package");
    const [notZip, notZipSig] = [Buffer.from("plain text"), sign(Buffer.from("plain text"), key)];
    expect(failure(() => checkRelease(entry, picked, notZip, notZipSig))).toBe(
      "demo.catalog v1.0.0: the package is not a zip archive Sextant reads (not a zip archive)",
    );
  });
});

describe("the index", () => {
  const latest = (version: string) => ({ version, sextantApi: 1, tag: `v${version}`, asset: `demo.catalog-${version}.sextant-ext`, size: 1, sha256: "0".repeat(64), keyId: "K", publishedAt: null, permissions: {}, contributes: {} });
  const now = new Date("2026-10-28T12:00:00Z");

  it("lists entries by id with what passed, and tells what did not", () => {
    const b = { ...ENTRY, id: "a.first" };
    const { index, notes } = buildIndex({
      entries: [ENTRY, b],
      results: new Map<string, object>([["demo.catalog", { latest: latest("1.0.0") }]]),
      previous: null,
      now,
    });
    expect(index).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-10-28T12:00:00.000Z",
      extensions: [{ ...b }, { ...ENTRY, latest: latest("1.0.0") }],
    });
    expect(notes).toEqual(["a.first: no release with a.first-<X.Y.Z>.sextant-ext and its .minisig was found"]);
  });

  it("keeps the listed release when the newest fails or is older, unless the key or repository changed", () => {
    const previous = { schemaVersion: 1, generatedAt: "2026-10-27T00:00:00.000Z", extensions: [{ ...ENTRY, latest: latest("2.0.0") }] };
    const failed = buildIndex({ entries: [ENTRY], results: new Map([["demo.catalog", { error: "demo.catalog v3: signature: bad" }]]), previous, now });
    expect(failed.index.extensions[0].latest.version).toBe("2.0.0");
    expect(failed.notes).toEqual(["demo.catalog v3: signature: bad; keeping 2.0.0"]);
    // Nothing changed: the time stays, so the workflow commits nothing.
    expect(failed.index.generatedAt).toBe("2026-10-27T00:00:00.000Z");

    const older = buildIndex({ entries: [ENTRY], results: new Map([["demo.catalog", { latest: latest("1.5.0") }]]), previous, now });
    expect(older.index.extensions[0].latest.version).toBe("2.0.0");
    expect(older.notes[0]).toBe("demo.catalog: the newest release 1.5.0 is older than the listed 2.0.0; keeping 2.0.0");

    const newKey = { ...ENTRY, publisherKey: generateKeyPair().publicKeyBase64 };
    const rekeyed = buildIndex({ entries: [newKey], results: new Map([["demo.catalog", { error: "demo.catalog v3: signature: bad" }]]), previous, now });
    expect(rekeyed.index.extensions[0]).not.toHaveProperty("latest");
    expect(rekeyed.index.generatedAt).toBe("2026-10-28T12:00:00.000Z");
  });
});
