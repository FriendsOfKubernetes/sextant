// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);

/** The field rows of the details section (`fields.<id>`), as `details.ts` lists them. */
const FIELDS = [
  "project",
  "sync",
  "syncedRevision",
  "health",
  "operation",
  "operationStarted",
  "operationFinished",
  "sources",
  "destination",
  "syncPolicy",
  "syncOptions",
  "reconciledAt",
  "generators",
  "applications",
  "description",
  "sourceRepos",
  "destinations",
  "clusterResourceWhitelist",
  "clusterResourceBlacklist",
  "namespaceResourceWhitelist",
  "namespaceResourceBlacklist",
  "roles",
];
const PREFIXES = "common|error|fields|sources|destinations|policy|tree|history|diff|sync|terminate|refresh|openUi|installation|login";

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const literal = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [...text.matchAll(new RegExp(`"((?:${PREFIXES})\\.[a-zA-Z0-9_.]+)"`, "g"))].map((m) => m[1]!);
    });
    const built = [
      ...FIELDS.map((id) => `fields.${id}`),
      ...["changed", "inSync", "missingLive", "missingTarget"].map((state) => `diff.state.${state}`),
      ...["secret", "manual"].map((source) => `diff.source.${source}`),
    ];
    const missing = [...new Set([...literal, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    const keys = [
      "name",
      "description",
      ...c.kinds.flatMap((k, i) => [`kinds.${i}.title`, ...("sectionTitle" in k ? [`kinds.${i}.sectionTitle`] : [])]),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.actions.flatMap((a) => [`actions.${a.id}.title`, ...("whyNot" in a ? [`actions.${a.id}.whyNot`] : [])]),
      ...c.columns.flatMap((col) => [`columns.${col.id}.title`, ...(col.cases ?? []).map((_, i) => `columns.${col.id}.cases.${i}.text`)]),
      ...c.services.map((s) => `services.${s.id}.title`),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).sort(), language).toEqual(keys);
    }
  });

  it("tone the translated Syncing of the Sync column as a warning", () => {
    const sync = manifest.contributes.columns.find((c) => c.id === "sync")!;
    const tones = sync.tones as unknown as Record<string, string>;
    for (const texts of Object.values(manifest.translations as Record<string, Record<string, string>>)) {
      expect(tones[texts["columns.sync.cases.0.text"]!]).toBe("warning");
    }
    expect(tones.Syncing).toBe("warning");
  });
});
