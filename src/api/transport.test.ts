import { beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  bundle: null as string | null,
  resourceDir: (): Promise<string> => Promise.reject(new Error("no resources")),
  resourceDirCalls: 0,
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => Promise.resolve("0.6.1"),
  getBundleType: () => Promise.resolve(tauri.bundle),
}));
vi.mock("@tauri-apps/api/path", () => ({
  resourceDir: () => {
    tauri.resourceDirCalls += 1;
    return tauri.resourceDir();
  },
}));

const { tauriTransport } = await import("./transport");

beforeEach(() => {
  tauri.bundle = null;
  tauri.resourceDir = () => Promise.reject(new Error("no resources"));
  tauri.resourceDirCalls = 0;
});

describe("tauriTransport.appInfo bundle kind", () => {
  it("counts macOS `app` as installed only when the executable runs inside a .app bundle", async () => {
    tauri.bundle = "app";
    tauri.resourceDir = () => Promise.resolve("/Applications/Sextant.app/Contents/Resources");
    expect((await tauriTransport.appInfo()).bundleKind).toBe("app");
  });

  it("treats macOS `app` from tauri dev (Cargo output directory) as not installed", async () => {
    tauri.bundle = "app";
    tauri.resourceDir = () => Promise.resolve("/Users/dev/sextant/target/debug");
    expect((await tauriTransport.appInfo()).bundleKind).toBeNull();
  });

  it("treats macOS `app` from a bare binary whose resources do not resolve as not installed", async () => {
    tauri.bundle = "app";
    expect((await tauriTransport.appInfo()).bundleKind).toBeNull();
  });

  it("keeps Linux and Windows kinds as Tauri reports them, without asking for the resource directory", async () => {
    for (const kind of ["appimage", "deb", "rpm", "msi", "nsis"]) {
      tauri.bundle = kind;
      expect((await tauriTransport.appInfo()).bundleKind).toBe(kind);
    }
    expect(tauri.resourceDirCalls).toBe(0);
    tauri.bundle = null;
    expect((await tauriTransport.appInfo()).bundleKind).toBeNull();
  });

  it("tells Scoop's portable copy (no bundle kind, run from Scoop's app directory) from a bare executable", async () => {
    tauri.bundle = null;
    for (const dir of [
      "C:\\Users\\dev\\scoop\\apps\\sextant\\current",
      "C:\\Users\\dev\\scoop\\apps\\sextant\\0.19.0\\",
      "\\\\?\\D:\\Scoop\\Apps\\Sextant\\0.19.0",
      "C:\\ProgramData\\scoop\\apps\\sextant\\current",
    ]) {
      tauri.resourceDir = () => Promise.resolve(dir);
      expect((await tauriTransport.appInfo()).bundleKind, dir).toBe("scoop");
    }
    for (const dir of [
      "C:\\Users\\dev\\Downloads",
      "C:\\Users\\dev\\scoop\\apps\\sextant",
      "C:\\Users\\dev\\scoop\\apps\\other\\current",
      "/home/dev/apps/sextant/current",
    ]) {
      tauri.resourceDir = () => Promise.resolve(dir);
      expect((await tauriTransport.appInfo()).bundleKind, dir).toBeNull();
    }
    // An installer's kind wins: the .msi copy is never taken for Scoop's.
    tauri.bundle = "msi";
    tauri.resourceDir = () => Promise.resolve("C:\\Users\\dev\\scoop\\apps\\sextant\\current");
    expect((await tauriTransport.appInfo()).bundleKind).toBe("msi");
  });

  it("reports a Vite dev build", async () => {
    expect((await tauriTransport.appInfo()).devBuild).toBe(import.meta.env.DEV);
  });
});
