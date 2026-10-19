import { render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppSettings, type ClusterInfo, type ClusterSettings } from "../../api";
import { ClusterAvatar } from "./ClusterAvatar";
import {
  CLUSTER_COLORS,
  contrastRatio,
  defaultClusterSettings,
  iconOf,
  INITIALS_DARK,
  INITIALS_LIGHT,
  initialsColorOn,
  normalizeIconText,
} from "./clusterSettings";
import { IconImageError, readIconImage } from "./iconImage";

const prod: ClusterInfo = {
  id: "aaaa",
  context: "kind-prod-east",
  clusterName: "prod",
  server: "https://prod.example:6443",
  user: "admin",
  namespace: null,
  sourceId: "src",
};

function settingsWith(patch: Partial<ClusterSettings>): AppSettings {
  return { ...defaultAppSettings(), clusters: { aaaa: { ...defaultClusterSettings(), ...patch } } };
}

describe("normalizeIconText", () => {
  it("keeps up to two characters, counting an emoji as one", () => {
    expect(normalizeIconText("abc")).toBe("ab");
    expect(normalizeIconText("  X ")).toBe("X");
    expect(normalizeIconText("🚀🔥🌊")).toBe("🚀🔥");
    // A family emoji is several code points but one character on screen.
    expect(normalizeIconText("👨‍👩‍👧Z!")).toBe("👨‍👩‍👧Z");
    expect(normalizeIconText("   ")).toBe("");
  });
});

describe("iconOf", () => {
  it("without an own icon, shows the initials of the shown name", () => {
    expect(iconOf(prod, null)).toEqual({ kind: "text", text: "KP" });
    expect(iconOf(prod, settingsWith({ displayName: "Staging" }))).toEqual({ kind: "text", text: "ST" });
  });

  it("shows the chosen text", () => {
    expect(iconOf(prod, settingsWith({ icon: { type: "text", text: "🚀" } }))).toEqual({ kind: "text", text: "🚀" });
    // An empty text falls back to the initials.
    expect(iconOf(prod, settingsWith({ icon: { type: "text", text: " " } }))).toEqual({ kind: "text", text: "KP" });
  });

  it("shows a picture only when it is a base64 PNG data URL", () => {
    const png = "data:image/png;base64,iVBORw0KGgo=";
    expect(iconOf(prod, settingsWith({ icon: { type: "image", dataUrl: png } }))).toEqual({ kind: "image", src: png });
    for (const other of ["https://example.com/a.png", "data:image/svg+xml;base64,PHN2Zz4=", "javascript:alert(1)"]) {
      expect(iconOf(prod, settingsWith({ icon: { type: "image", dataUrl: other } }))).toEqual({ kind: "text", text: "KP" });
    }
  });
});

describe("readIconImage", () => {
  const drawImage = vi.fn();
  let decodeFails = false;
  let natural = { width: 200, height: 100 };

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_value: string) {
      setTimeout(() => {
        if (decodeFails) return this.onerror?.();
        this.naturalWidth = natural.width;
        this.naturalHeight = natural.height;
        this.onload?.();
      });
    }
  }

  beforeEach(() => {
    drawImage.mockReset();
    decodeFails = false;
    natural = { width: 200, height: 100 };
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      return { drawImage, clearRect: vi.fn(), imageSmoothingEnabled: true, imageSmoothingQuality: "low" } as never;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement, type) {
      return `data:${type};base64,${this.width}x${this.height}`;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const file = (type: string, size = 10, name = "icon") => new File([new Uint8Array(size)], name, { type });

  it("fits the picture into a 96×96 PNG, keeping its proportions", async () => {
    await expect(readIconImage(file("image/jpeg"))).resolves.toBe("data:image/png;base64,96x96");
    expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 24, 96, 48);

    natural = { width: 30, height: 60 };
    await readIconImage(file("image/svg+xml"));
    expect(drawImage).toHaveBeenLastCalledWith(expect.any(FakeImage), 24, 0, 48, 96);
  });

  it("accepts PNG, JPEG, SVG and WebP", async () => {
    for (const type of ["image/png", "image/jpeg", "image/svg+xml", "image/webp"]) {
      await expect(readIconImage(file(type))).resolves.toMatch(/^data:image\/png;base64,/);
    }
  });

  it("refuses other files, files over 5 MB and files that do not decode as a picture", async () => {
    await expect(readIconImage(file("text/plain"))).rejects.toMatchObject({ code: "type" });
    await expect(readIconImage(file("image/gif"))).rejects.toBeInstanceOf(IconImageError);
    await expect(readIconImage(file("image/png", 5 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "size" });
    decodeFails = true;
    await expect(readIconImage(file("image/png"))).rejects.toMatchObject({ code: "type" });
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe("the letters on the label color", () => {
  it("are light or dark, whichever contrasts more with the color", () => {
    // Yellow and other light or mid colors take dark letters; red and dark ones keep white.
    for (const light of ["#ffff00", "#ffd700", "#f0f0f0", "#fff", "#d6a01e", "#2aa3a3", "#48a868", "#3d90ce"]) {
      expect(initialsColorOn(light), light).toBe(INITIALS_DARK);
    }
    for (const dark of ["#000000", "#123", "#ce3933", "#1e2124", "#5a2d82"]) {
      expect(initialsColorOn(dark), dark).toBe(INITIALS_LIGHT);
    }
  });

  it("reach 4.5:1 on every offered color and never lose to the other choice", () => {
    for (const color of [...CLUSTER_COLORS, "#ffff00", "#00ffff", "#ff00ff", "#808080"]) {
      const chosen = initialsColorOn(color);
      const other = chosen === INITIALS_DARK ? INITIALS_LIGHT : INITIALS_DARK;
      expect(contrastRatio(chosen, color), color).toBeGreaterThanOrEqual(contrastRatio(other, color)!);
      if (CLUSTER_COLORS.includes(color)) expect(contrastRatio(chosen, color), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("stay white on a value that is not a hex color", () => {
    expect(initialsColorOn("rebeccapurple")).toBe(INITIALS_LIGHT);
  });

  it("are drawn in the chosen color", () => {
    const cluster = { ...defaultClusterSettings(), color: "#ffff00" };
    const settings: AppSettings = { ...defaultAppSettings(), clusters: { [prod.id]: cluster } };
    const { container } = render(createElement(ClusterAvatar, { cluster: prod, settings }));
    const avatar = container.querySelector<HTMLElement>(".cluster-avatar")!;
    expect(avatar.style.getPropertyValue("--cluster-text")).toBe(INITIALS_DARK);
  });
});
