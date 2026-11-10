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
type Case = { text: string };
/** Case texts that are no words (a placeholder, "0", "*", "true" or blank, as the built-in columns wrote them): not translated. */
const literal = (text: string) => /^(\{\{[^}]+\}\}|0|\*|true|)$/.test(text);

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const literalKeys = sources.flatMap((f) =>
      [...readFileSync(join(here, f), "utf8").matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
    );
    const fields = ["phase", "namespaces", "ttl", "location", "started", "completed", "expires", "backup", "schedule", "cron", "lastBackup", "provider", "bucket", "prefix", "accessMode", "lastValidated"];
    const explain = ["validation", "validationNoReason", "failed", "failedNoReason", "backupErrors", "restoreErrors", "warnings", "backupLogs", "restoreLogs", "progress", "deleting", "paused", "unavailable", "unavailableNoMessage"];
    const built = [
      ...["seconds", "minutes", "hours", "days", "years"].map((u) => `age.${u}`),
      ...fields.map((k) => `fields.${k}`),
      ...explain.map((k) => `velero.explain.${k}`),
    ];
    const missing = [...new Set([...literalKeys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });

  it("say the actions' and the section's titles as the manifest does", () => {
    const titles: [string, string][] = [
      ["actions.back-up-namespace.title", "velero.backupAction"],
      ["actions.restore-backup.title", "velero.restoreAction"],
      ["detailsSections.velero.title", "velero.section"],
    ];
    const english = (key: string) => {
      const [, id] = key.split(".");
      return key.startsWith("actions.") ? manifest.contributes.actions.find((a) => a.id === id)!.title : manifest.contributes.detailsSections[0]!.title;
    };
    for (const [key, catalogKey] of titles) {
      expect(english(key)).toBe(en[catalogKey as keyof typeof en]);
      for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
        const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
        expect(texts[key], language).toBe(catalog[catalogKey]);
      }
    }
  });
});

describe("the manifest's translations", () => {
  it("translate every text of the manifest into every language Sextant has", () => {
    const c = manifest.contributes;
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.sections.map((s) => `sections.${s.section}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.actions.map((a) => `actions.${a.id}.title`),
      ...c.columns.flatMap((col) => [
        `columns.${col.id}.title`,
        ...(((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => (literal(cs.text) ? [] : [`columns.${col.id}.cases.${i}.text`]))),
      ]),
    ].sort();
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).sort(), language).toEqual(keys);
      for (const [key, text] of Object.entries(texts)) expect(text.trim(), `${language} ${key}`).not.toBe("");
    }
  });
});
