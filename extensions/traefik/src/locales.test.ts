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
import { HEALTHS, REF_PLACES, REF_STATES, STRATEGIES } from "./model";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

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
    const keys = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [
        ...[...text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // `t(cond ? "a" : "b")`.
        ...[...text.matchAll(/\bt\([^()"]*\? "([a-zA-Z0-9_.]+)" : "([a-zA-Z0-9_.]+)"/g)].flatMap((m) => [m[1]!, m[2]!]),
        // The rows of `fieldsOf`, labelled `fields.<key>`.
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)", (?!")/gm)].map((m) => `fields.${m[1]!}`),
      ];
    });
    const built = [
      ...HEALTHS.map((h) => `health.${h}`),
      ...REF_STATES.map((s) => `refState.${s}`),
      ...REF_PLACES.map((p) => `place.${p}`),
      ...STRATEGIES.map((s) => `strategy.${s}`),
      "explain.emptyMatch",
      "explain.unsupportedKind",
      "explain.broken",
    ];
    expect(keys.length).toBeGreaterThan(30);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const english = new Map<string, string>([
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as const),
    // The certificate section's title; the untitled `traefik` section's is the name.
    ...c.detailsSections.filter((d) => d.id !== "traefik").map((d) => [`detailsSections.${d.id}.title`, d.title] as const),
    ...c.problemCategories.map((p) => [`problemCategories.${p.id}.title`, p.title] as const),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as const,
      ...(((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as const)),
    ]),
    ...c.problems.flatMap((r) => [[`problems.${r.id}.title`, r.title] as const, [`problems.${r.id}.message`, r.message] as const]),
  ]);
  /**
   * Texts a language may write as English does, left out of `translations` (the window then shows the English): the
   * kinds' plural names (as the built-in sidebar kept them in several languages), Traefik's own words and field
   * values, a blank cell, and texts made only of placeholders. The name and the section's title are "Traefik".
   */
  const sameAllowed = (text: string) =>
    text === "" ||
    /^\{\{[^}]+\}\}$/.test(text) ||
    /^(weighted|mirroring|highestRandomWeight|failover|TLS|Passthrough|Type|Services|Secrets)$/.test(text) ||
    /^(IngressRoutes|IngressRoutes TCP|IngressRoutes UDP|Middlewares|Middlewares TCP|Traefik Services|TLS Options|TLS Stores|Servers Transports|Servers Transports TCP)( \(traefik\.containo\.us\))?$/.test(text);

  it("translate every text of the manifest into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      for (const key of Object.keys(texts).filter((k) => !badge(k))) expect(english.has(key), `${language} ${key}`).toBe(true);
      for (const [key, text] of english) {
        if (!Object.hasOwn(texts, key)) expect(sameAllowed(text), `${language} leaves out ${key}: ${text}`).toBe(true);
        // What a language translates differs from English (the same text is left out, not repeated).
        else if (!key.startsWith("problems.")) expect(texts[key], `${language} ${key}`).not.toBe(text);
      }
      // The counter's label in exactly the language's plural forms (ADR-0167), the built-in counter's words.
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.traefik.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      for (const [k, v] of Object.entries(texts)) expect(v.trim(), `${language} ${k}`).not.toBe("");
    }
  });

  it("keep the English placeholders, and give every rule its own title within 80 characters in every language", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    for (const [language, texts] of Object.entries(translations)) {
      const titles = new Set<string>();
      for (const rule of c.problems) {
        const message = texts[`problems.${rule.id}.message`];
        expect(message, `${language} ${rule.id}`).toBeDefined();
        expect(placeholders(message!), `${language} ${rule.id}`).toEqual(placeholders(rule.message));
        const title = texts[`problems.${rule.id}.title`]!;
        expect(title, language).not.toBe(rule.title);
        expect(Array.from(title).length, language).toBeLessThanOrEqual(80);
        expect(titles.has(title), `${language} ${title}`).toBe(false);
        titles.add(title);
      }
    }
    expect(new Set(c.problems.map((r) => r.title)).size).toBe(c.problems.length);
    for (const r of c.problems) expect(Array.from(r.title).length).toBeLessThanOrEqual(80);
  });

  it("stay within the SDK's size limit for a manifest", () => {
    const bytes = readFileSync(join(here, "../sextant-extension.json")).length;
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
  });
});
