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
const ROUTE_STATES = ["admitted", "rejected", "pending"];
const DC_STATES = ["available", "progressing", "failed", "cancelled", "unavailable", "paused", "new"];

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const keys = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [
        ...[...text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // The rows of `fieldsOf`, labelled `fields.<key>`.
        ...(f === "details.ts" ? [...text.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`) : []),
        // Table headers: `["service", "weight"].map((h) => t(`backends.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    const built = [
      ...ROUTE_STATES.map((s) => `routeState.${s}`),
      ...DC_STATES.map((s) => `dcState.${s}`),
      ...["yes", "no", "unknown"].map((s) => `admitted.${s}`),
      ...["paused", "inProgress"].map((s) => `rolloutLatest.${s}`),
      ...["seconds", "minutes", "hours", "days", "years"].map((u) => `age.${u}`),
    ];
    expect(keys.length).toBeGreaterThan(80);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
  /** A text without words: placeholders, punctuation and digits only (a count, a list of names). */
  const wordless = (text: string) => !/\p{L}/u.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.actions.map((a) => [`actions.${a.id}.title`, a.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
        [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string],
        ...["zero", "one", "two", "few", "many"].map((f) => [`columns.${col.id}.cases.${i}.textForms.${f}`, cs.text] as [string, string]),
      ]),
      ...((col as { items?: { cases: Case[] } }).items?.cases ?? []).map((cs, i) => [`columns.${col.id}.items.${i}.text`, cs.text] as [string, string]),
    ]),
    ...c.problems.flatMap((r) => [
      [`problems.${r.id}.title`, r.title] as [string, string],
      [`problems.${r.id}.message`, r.message] as [string, string],
    ]),
  ]);

  it("translate every text of the manifest with words into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    // Wordless texts reading as in English are left to English, which the window shows for a missing key; one that
    // reads otherwise (a list joined with the language's own comma) is translated.
    // A plural form is asked for by the language's own forms (the next test), not by English's.
    const form = (key: string) => key.includes(".textForms.");
    const needed = [...english].filter(([key, text]) => !form(key) && !wordless(text)).map(([key]) => key);
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      const keys = Object.keys(texts).filter((k) => !badge(k));
      expect(keys.filter((k) => !english.has(k)), language).toEqual([]);
      const extra = keys.filter((k) => !needed.includes(k) && !form(k));
      for (const k of extra) expect(texts[k], `${language} ${k}`).not.toBe(english.get(k));
      expect(needed.filter((k) => !keys.includes(k)), language).toEqual([]);
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.openshift.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles", () => {
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of Object.entries(texts)) {
        if (key.startsWith("sectionBadges.")) continue;
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(english.get(key)!));
      }
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
    }
  });

  it("say the Route and DeploymentConfig states and the actions as the details and windows do", () => {
    const words = (id: string) => (c.columns.find((col) => col.id === id) as { cases: Case[] }).cases.map((cs) => cs.text);
    const dcCases = ["paused", "failed", "cancelled", "progressing", "available", "unavailable", "new", "progressing"];
    expect(words("route-status")).toEqual(ROUTE_STATES.map((s) => en[`routeState.${s}` as keyof typeof en]));
    expect(words("dc-status")).toEqual(dcCases.map((s) => en[`dcState.${s}` as keyof typeof en]));
    for (const [language, texts] of Object.entries(translations)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      ROUTE_STATES.forEach((s, i) => expect(texts[`columns.route-status.cases.${i}.text`], language).toBe(catalog[`routeState.${s}`]));
      dcCases.forEach((s, i) => expect(texts[`columns.dc-status.cases.${i}.text`], language).toBe(catalog[`dcState.${s}`]));
      expect(texts["actions.rollout-latest.title"], language).toBe(catalog["rolloutLatest.label"]);
      expect(texts["actions.start-build.title"], language).toBe(catalog["startBuild.label"]);
    }
  });

  it("write the failing imports in each language's plural forms, as the built-in texts did", () => {
    const failing = (c.columns.find((col) => col.id === "is-imports") as { cases: (Case & { pluralBy?: string; textForms?: Record<string, string> })[] }).cases[1]!;
    expect(failing.text).toBe("{{.status.tags[conditions.type=\"ImportSuccess\",conditions.status=\"False\",*]|count}} imports fail");
    expect(failing.pluralBy).toBe('.status.tags[conditions.type="ImportSuccess",conditions.status="False",*]|count');
    expect(Object.keys(failing.textForms!)).toEqual(["one"]);
    for (const [language, texts] of Object.entries(translations)) {
      const forms = Object.keys(texts)
        .filter((k) => k.startsWith("columns.is-imports.cases.1.textForms."))
        .map((k) => k.slice("columns.is-imports.cases.1.textForms.".length))
        .sort();
      const needed = [...new Intl.PluralRules(language).resolvedOptions().pluralCategories].filter((f) => f !== "other").sort();
      expect(forms, language).toEqual(needed);
    }
    expect(translations.ru!["columns.is-imports.cases.1.textForms.few"]).toMatch(/^\{\{.*\}\} импорта не удаются$/);
    expect(translations.ru!["columns.is-imports.cases.1.textForms.many"]).toMatch(/импортов не удаются$/);
  });
});
