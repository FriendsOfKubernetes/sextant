// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated — every text
// with words in it; a text that is only field values, a kind's name or a framework's reads the same in every language.
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
  ...["ready", "progressing", "notReady", "failed", "stopped"].map((s) => `state.${s}`),
  ...["predictor", "transformer", "explainer"].map((c) => `component.${c}`),
  ...["knative", "standard", "modelMesh", "other", "default"].map((m) => `mode.${m}`),
  ...["namedMissing", "namedDisabled", "namedProtocol", "namedFormat"].map((k) => `choice.${k}`),
  "choice.fields.named",
  "choice.fields.auto",
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
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`),
        // Table headers: `["name", "version"].map((h) => t(`formats.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
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
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;
  const KINDS = new Set(["InferenceService", "ServingRuntime", "ClusterServingRuntime", "InferenceGraph", "TrainedModel"]);
  /** A text with no words to translate: field values, numbers and punctuation, a kind's or a framework's name, True or False. */
  const sameEverywhere = (text: string) =>
    KINDS.has(text) || text === "KServe" || text === "True" || text === "False" || /^[a-z]+$/.test(text) || text.replace(/\{\{[\s\S]*?\}\}/g, "").replace(/[\s,:…0-9]/g, "") === "";

  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
        [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string],
        ...(cs.tooltip === undefined ? [] : [[`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip] as [string, string]]),
      ]),
    ]),
    ...c.problems.flatMap((r) => [[`problems.${r.id}.title`, r.title] as [string, string], [`problems.${r.id}.message`, r.message] as [string, string]]),
  ]);

  it("translate every text with words into every language Sextant has", () => {
    const words = [...english].filter(([key, text]) => !sameEverywhere(text) || /^(sections|kinds)\.|^columns\.[^.]+\.title$/.test(key)).map(([key]) => key);
    const translations = manifest.translations as Record<string, Record<string, string>>;
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(words.filter((k) => k !== "name").sort());
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.kserve.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
    }
  });

  it("keep the English placeholders", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
      for (const [key, text] of Object.entries(texts)) if (english.has(key)) expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(english.get(key)!));
    }
  });

  it("say the states as the details do", () => {
    const status = c.columns.find((col) => col.id === "isvc-status")! as { cases: Case[] };
    for (const [language, texts] of Object.entries(manifest.translations as Record<string, Record<string, string>>)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      status.cases.forEach((cs, i) => {
        const state = Object.entries(en).find(([k, v]) => k.startsWith("state.") && v === cs.text)![0];
        expect(texts[`columns.isvc-status.cases.${i}.text`], language).toBe(catalog[state]);
      });
    }
  });
});
