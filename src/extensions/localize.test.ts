import { describe, expect, it } from "vitest";
import type { ExtensionInfo, ExtensionManifest } from "../api";
import { localizeExtension, localizeManifest } from "./localize";

const manifest: ExtensionManifest = {
  id: "sextant.rook-ceph",
  name: "Rook Ceph",
  version: "1.0.0",
  description: "Rook Ceph clusters",
  author: "Sextant",
  sextantApi: 2,
  entry: "index.html",
  permissions: { clusters: { type: "all" }, rules: [] },
  contributes: {
    pages: [{ id: "overview", title: "Rook Ceph", section: "storage" }],
    detailsSections: [{ id: "status", title: "Ceph status", kinds: [], placement: "section" }],
    actions: [],
    columns: [{ kind: { group: "ceph.rook.io", kind: "CephCluster" }, id: "v", title: "Ceph", jsonPath: ".status.version.version" }],
    dockActions: [],
    problems: [
      {
        id: "error",
        title: "Ceph health error",
        kind: { group: "ceph.rook.io", kind: "CephCluster" },
        when: { type: "exists", path: ".status" },
        graceMinutes: 0,
        notify: true,
        message: "Ceph reports {{.status.ceph.health}}",
      },
    ],
    metricQueries: [{ id: "health", title: "Ceph health", query: "max(ceph_health_status)", params: [] }],
    settings: { title: "Rook Ceph" },
  },
  backend: { module: "b.wasm", network: { hosts: [] }, credentials: [{ id: "token", label: "Token" }] },
  translations: {
    ru: {
      name: "Rook Ceph (рус)",
      "detailsSections.status.title": "Состояние Ceph",
      "problems.error.title": "Ошибка Ceph",
      "problems.error.message": "Ceph сообщает {{.status.ceph.health}}",
      "metricQueries.health.title": "Состояние Ceph",
      "settings.title": "Настройки",
      "backend.credentials.token.label": "Токен",
    },
    "zh-TW": { "pages.overview.title": "Rook Ceph 總覽" },
  },
};

describe("localizeManifest", () => {
  it("takes every translated text for the UI language and keeps the rest in English", () => {
    const ru = localizeManifest(manifest, "ru");
    expect(ru.name).toBe("Rook Ceph (рус)");
    expect(ru.description).toBe("Rook Ceph clusters");
    expect(ru.contributes.detailsSections[0]!.title).toBe("Состояние Ceph");
    expect(ru.contributes.pages[0]!.title).toBe("Rook Ceph");
    expect(ru.contributes.problems[0]).toMatchObject({ title: "Ошибка Ceph", message: "Ceph сообщает {{.status.ceph.health}}" });
    expect(ru.contributes.metricQueries[0]).toEqual({ ...manifest.contributes.metricQueries[0], title: "Состояние Ceph" });
    expect(ru.contributes.settings?.title).toBe("Настройки");
    expect(ru.backend?.credentials[0]?.label).toBe("Токен");
    // What is never translated stays as it is.
    expect(ru.contributes.problems[0]!.when).toBe(manifest.contributes.problems[0]!.when);
    expect(ru.permissions).toBe(manifest.permissions);
  });

  it("chooses the translation as Sextant chooses its language, and English when none fits", () => {
    expect(localizeManifest(manifest, "zh-TW").contributes.pages[0]!.title).toBe("Rook Ceph 總覽");
    expect(localizeManifest(manifest, "zh-CN")).toBe(manifest);
    expect(localizeManifest(manifest, "de")).toBe(manifest);
    expect(localizeManifest(manifest, "en")).toBe(manifest);
  });

  it("gives an installed extension its translated name", () => {
    const info = { id: manifest.id, name: "Rook Ceph", manifest } as ExtensionInfo;
    expect(localizeExtension(info, "ru").name).toBe("Rook Ceph (рус)");
    expect(localizeExtension(info, "de")).toBe(info);
  });
});
