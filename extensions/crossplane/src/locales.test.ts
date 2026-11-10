// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated — every text
// with words in it but Crossplane's own names (its kinds, condition types and modes), which the built-in view kept in
// English in every language, and the few words a language writes as English does.
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

/** Keys the code builds from a value. */
const BUILT = [
  ...["ready", "progressing", "paused", "failed", "unknown"].map((s) => `health.${s}`),
  ...["claim", "composite", "managed"].map((r) => `role.${r}`),
  ...["claim", "composite"].map((r) => `page.kindWithRole.${r}`),
  ...[
    "ready",
    "creating",
    "deleting",
    "paused",
    "notSynced",
    "notReady",
    "packageHealthy",
    "packageInstalling",
    "packageNotInstalled",
    "packageUnhealthy",
    "xrdNotEstablished",
    "xrdClaimNotOffered",
    "xrdEstablishedWithClaim",
    "xrdEstablished",
  ].map((k) => `explain.${k}`),
];

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
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)",\s(?!")/gm)].map((m) => `fields.${m[1]!}`),
        // Table headers: `["kind", "name"].map((h) => t(`page.columns.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z.]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    expect(keys.length).toBeGreaterThan(60);
    const missing = [...new Set([...keys, ...BUILT])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string };
  const c = manifest.contributes;
  /** Crossplane's own names, English in every language as the built-in view had them; texts of field values only. */
  const crossplaneName = (text: string) =>
    c.kinds.some((k) => k.title === text) || ["Crossplane", "Established", "Offered", "Installed", "Healthy", "Pipeline", "Resources"].includes(text) || text.replace(/\{\{[\s\S]*?\}\}/g, "").replace(/[\s.]/g, "") === "";
  /** Words a language writes as English does. */
  const SAME: Record<string, string[]> = { de: ["Composite Resources", "Status"], fr: ["Mode"] };

  const english = new Map<string, string>([
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.pages.map((p) => [`pages.${p.id}.title`, p.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string]),
    ]),
    ...c.problems.map((r) => [`problems.${r.id}.title`, r.title] as [string, string]),
  ]);
  /** The section counter's label: each language's plural forms, English's `other` standing for those it lacks. */
  const badge = c.sectionBadges[0]!;
  const badgeKey = (form: string) => `sectionBadges.${badge.section}.label.${form}`;
  const badgeEnglish = (form: string) => (badge.label as Record<string, string>)[form] ?? badge.label.other;
  const isBadge = (key: string) => key.startsWith("sectionBadges.");

  it("translate every text with words into every language Sextant has", () => {
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) {
      for (const key of Object.keys(texts).filter((k) => !isBadge(k))) expect(english.has(key), `${language} ${key}`).toBe(true);
      const words = [...english].filter(([, text]) => !crossplaneName(text) && !(SAME[language] ?? []).includes(text)).map(([key]) => key);
      expect(Object.keys(texts).filter((k) => !isBadge(k)).sort(), language).toEqual(words.sort());
      const forms = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
      expect(Object.keys(texts).filter(isBadge).sort(), language).toEqual(forms.map(badgeKey).sort());
    }
  });

  it("keep the English placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
      for (const [key, text] of Object.entries(texts)) {
        const source = isBadge(key) ? badgeEnglish(key.slice(key.lastIndexOf(".") + 1)) : english.get(key)!;
        expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(source));
      }
    }
  });

  it("say the packages' states as the page and the details do", () => {
    for (const p of ["provider", "configuration", "function"]) {
      const status = c.columns.find((col) => col.id === `${p}-status`)! as unknown as { cases: (Case & { value: string })[] };
      for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
        const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
        status.cases.forEach((cs, i) => {
          expect(texts[`columns.${p}-status.cases.${i}.text`] ?? cs.text, language).toBe(catalog[`health.${cs.value}`]);
        });
      }
      status.cases.forEach((cs) => expect(cs.text).toBe(en[`health.${cs.value}` as keyof typeof en]));
    }
  });
});
