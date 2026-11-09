// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, the built-in section's texts word for
// word, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";

const here = dirname(fileURLToPath(import.meta.url));
const SEXTANT = join(here, "../../../src/locales");
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(SEXTANT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
/** Sextant's former built-in texts, while they are there (`src/locales/<lang>/externalsecrets.json`). */
const builtIn = (language: string, ns = "externalsecrets"): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(join(SEXTANT, language, `${ns}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};
const flat = (value: Record<string, unknown>, prefix = ""): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value).flatMap(([k, v]) =>
      v && typeof v === "object" ? Object.entries(flat(v as Record<string, unknown>, `${prefix}${k}.`)) : [[`${prefix}${k}`, String(v)]],
    ),
  );

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);

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
    const built = ["ready", "failed", "pending"].map((s) => `state.${s}`);
    const fields = [...readFileSync(join(here, "details.ts"), "utf8").matchAll(/\["([a-zA-Z]+)", /g)].map((m) => `fields.${m[1]!}`);
    expect([...new Set([...literal, ...built, ...fields])].filter((key) => !has(key))).toEqual([]);
  });

  it("say what the built-in section said, word for word", () => {
    for (const language of SEXTANT_LANGUAGES) {
      const texts = builtIn(language);
      if (!texts) continue;
      const theirs = flat(texts);
      const ours = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      for (const [key, text] of Object.entries(ours)) {
        if (key in theirs) expect(text, `${language} ${key}`).toBe(theirs[key]);
      }
    }
  });
});

describe("the manifest's translations", () => {
  const c = manifest.contributes;
  type Case = { text: string; tooltip?: string };
  const translations = manifest.translations as Record<string, Record<string, string>>;

  it("translate every text of the manifest into every language Sextant has", () => {
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.sections.map((s) => `sections.${s.section}.title`),
      ...c.columns.flatMap((col) => [
        `columns.${col.id}.title`,
        ...(((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
          `columns.${col.id}.cases.${i}.text`,
          ...(cs.tooltip === undefined ? [] : [`columns.${col.id}.cases.${i}.tooltip`]),
        ])),
      ]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
    ].sort();
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    // The counter's label in exactly the language's plural forms (ADR-0167).
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(keys);
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.externalSecrets.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      for (const r of c.problems) {
        expect(texts[`problems.${r.id}.title`], `${language} ${r.id}`).not.toBe(r.title);
        expect(texts[`problems.${r.id}.title`]!.length, `${language} ${r.id}`).toBeLessThanOrEqual(80);
      }
      const titles = c.problems.map((r) => texts[`problems.${r.id}.title`]);
      expect(new Set(titles).size, language).toBe(titles.length);
    }
  });

  it("keep the English placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    const english = new Map<string, string>();
    for (const col of c.columns) {
      for (const [i, cs] of ((col as { cases?: Case[] }).cases ?? []).entries()) {
        english.set(`columns.${col.id}.cases.${i}.text`, cs.text);
        if (cs.tooltip !== undefined) english.set(`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip);
      }
    }
    for (const rule of c.problems) english.set(`problems.${rule.id}.message`, rule.message);
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of english) expect(placeholders(texts[key]!), `${language} ${key}`).toEqual(placeholders(text));
    }
  });

  it("use the built-in section's texts: kinds, columns, states and the counter", () => {
    for (const language of SEXTANT_LANGUAGES.filter((l) => l !== "en")) {
      const texts = builtIn(language);
      if (!texts) continue;
      const theirs = flat(texts);
      const ours = translations[language]!;
      const sidebar = ["externalSecrets", "clusterExternalSecrets", "secretStores", "clusterSecretStores", "pushSecrets"];
      sidebar.forEach((key, index) => expect(ours[`kinds.${index}.title`], `${language} ${key}`).toBe(theirs[`sidebar.${key}`]));
      for (const col of c.columns) {
        const key = { status: "status", store: "store", target: "target", refresh: "refresh", "last-sync": "lastSync", reason: "reason", provider: "provider", capabilities: "capabilities", source: "source", stores: "stores" }[col.id.replace(/^[a-z]+-/, "")]!;
        expect(ours[`columns.${col.id}.title`], `${language} ${col.id}`).toBe(theirs[`columns.${key}`]);
      }
      for (const [i, state] of ["ready", "failed", "pending"].entries()) expect(ours[`columns.es-status.cases.${i}.text`]).toBe(theirs[`state.${state}`]);
      for (const form of ["zero", "one", "two", "few", "many", "other"]) {
        expect(ours[`sectionBadges.externalSecrets.label.${form}`], `${language} ${form}`).toBe(theirs[`badge_${form}`]);
      }
    }
    // English is the manifest itself.
    expect(c.sectionBadges[0]!.label).toEqual({ one: "{{count}} object needs attention", other: "{{count}} objects need attention" });
    for (const col of c.columns.filter((col) => col.id.endsWith("-status"))) {
      expect(col.cases!.map((cs) => cs.text)).toEqual(["ready", "failed", "pending"].map((s) => en[`state.${s}` as keyof typeof en]));
    }
  });
});
