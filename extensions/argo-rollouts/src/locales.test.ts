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
import { ACTION_IDS, type RolloutAction } from "./patches";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const ACTIONS = Object.keys(ACTION_IDS) as RolloutAction[];

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const literal = sources.flatMap((f) =>
      [...readFileSync(join(here, f), "utf8").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
    );
    const built = [
      ...["specNotObserved", "unpausing", "workloadNotObserved", "manuallyPaused", "restarting", "updating"].map((r) => `phaseReason.${r}`),
      ...["becomingAvailable", "cutoverPending", "postPromotion", "oldReplicas", "steps"].map((r) => `phaseReason.${r}`),
      ...["stable", "canary", "active", "preview", "old"].map((r) => `roles.${r}`),
      ...["name", "role", "revision", "available", "phase", "started", "message", "metric", "successful", "failed"].map((h) => `table.${h}`),
      ...["inconclusive", "error", "lastValue", "provider", "template", "status"].map((h) => `table.${h}`),
      ...ACTIONS.flatMap((a) => [`actions.${a}`, `dialog.${a}Title`, `dialog.${a}Text`, `whyNot.${a}`]),
    ];
    const missing = [...new Set([...literal, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });

  it("say an action's whyNot as the manifest does", () => {
    for (const action of ACTIONS) {
      const entry = manifest.contributes.actions.find((a) => a.id === ACTION_IDS[action])!;
      expect(entry.whyNot).toBe(en[`whyNot.${action}` as keyof typeof en]);
      for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
        const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
        expect(texts[`actions.${entry.id}.whyNot`], language).toBe(catalog[`whyNot.${action}`]);
      }
    }
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    // Column cases are the API's own words (Paused, Degraded, Canary, …), beside `.status.phase` values shown as
    // written: "translated" as themselves in every language (model.test.ts checks it); their tooltips are sentences,
    // translated. The Weight's `valueText` and its cases are written in each language's form ("20 %" in French).
    const keys = [
      "name",
      "description",
      ...c.kinds.flatMap((k, i) => [`kinds.${i}.title`, ...("sectionTitle" in k ? [`kinds.${i}.sectionTitle`] : [])]),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.actions.flatMap((a) => [`actions.${a.id}.title`, `actions.${a.id}.whyNot`]),
      ...c.sections.flatMap((s) => (s.title === undefined ? [] : [`sections.${s.section}.title`])),
      ...c.columns.flatMap((col) => [
        `columns.${col.id}.title`,
        ...("valueText" in col ? [`columns.${col.id}.valueText`] : []),
        ...((col as { cases?: { tooltip?: string }[] }).cases ?? []).flatMap((cs, i) => [
          `columns.${col.id}.cases.${i}.text`,
          ...(cs.tooltip === undefined ? [] : [`columns.${col.id}.cases.${i}.tooltip`]),
        ]),
      ]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
      ...c.agentTools.map((t) => `agentTools.${t.id}.title`),
      ...c.problemCategories.map((p) => `problemCategories.${p.id}.title`),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).sort(), language).toEqual(keys);
    }
  });
});
