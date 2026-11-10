// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated — every text
// with words in it; a text that is only field values or KEDA's own words (Active, Paused, Secret, env) reads the same in
// every language, as the built-in view showed them.
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

/** Keys the code builds from a value: the phrases of the state and of the HPA's verdict and causes. */
const BUILT = [
  ...["notReady", "paused", "pausedAt", "fallback", "triggerFailing", "jobActive", "jobInactive", "active", "inactiveIdle", "inactive", "hpaMissing"].map((k) => `keda.${k}`),
  ...["disabled", "noMetrics", "backoff", "cannotScale", "stabilizedDown", "stabilizedUp", "atMax", "atMin", "upLimit", "downLimit", "noStatus", "scaling", "heldByMissing", "steady"].map(
    (k) => `verdict.${k}`,
  ),
  ...["missingRequest", "noMetricsServer", "noCustomMetrics", "noExternalMetrics", "noPodMetrics", "metricNotFound"].map((k) => `cause.${k}`),
];

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for, and no other", () => {
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const keys = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [
        ...[...text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // The rows of `fieldsOf`, labelled `fields.<key>`.
        ...(f === "details.ts" ? [...text.matchAll(/^\s*\[\s*"([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`) : []),
        // Table headers: `["trigger", "metadata"].map((h) => t(`keda.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    expect(keys.length).toBeGreaterThan(30);
    const asked = new Set([...keys, ...BUILT]);
    expect([...asked].filter((key) => !has(key))).toEqual([]);
    const unused = Object.keys(en)
      .map((k) => k.replace(/_(zero|one|two|few|many|other)$/, ""))
      .filter((k) => !asked.has(k));
    expect([...new Set(unused)]).toEqual([]);
  });

  it("are the built-in view's texts", () => {
    // Taken word for word from Sextant's `autoscaling` texts; spot checks of a few languages.
    expect(CATALOGS.en["keda.title"]).toBe("KEDA");
    expect(CATALOGS.en["keda.hpaMissing"]).toBe("The HPA {{name}} that KEDA manages for this ScaledObject is not there.");
    expect(CATALOGS.de["fields.pollingInterval"]).toBe("Abfrageintervall");
    expect(CATALOGS.ja["keda.authTitle"]).toBe("パラメーターの取得元");
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
  /** KEDA's own words and values: shown as the cluster writes them, in every language. */
  const sameEverywhere = (text: string) => /^[A-Za-z0-9,/ ]*$/.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string]),
    ]),
  ]);

  it("translate every text with words into every language Sextant has", () => {
    // Kinds, sections, details sections and column titles always; case texts only where they have words of ours.
    const words = [...english]
      .filter(([key, text]) => key !== "name" && (/^(sections|kinds|detailsSections)\.|^columns\.[^.]+\.title$|^description$/.test(key) || !sameEverywhere(text)))
      .map(([key]) => key);
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    for (const [language, texts] of Object.entries(translations)) expect(Object.keys(texts).sort(), language).toEqual(words.sort());
  });

  it("keep the English placeholders", () => {
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of Object.entries(texts)) expect(placeholders(text), `${language} ${key}`).toEqual(placeholders(english.get(key)!));
    }
  });

  it("title the columns and kinds as the built-in view did", () => {
    for (const [language, texts] of Object.entries(translations)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      expect(texts["detailsSections.trigger-authentication.title"], language).toBe(catalog["keda.authTitle"]);
      expect(texts["detailsSections.scaled-object.title"], language).toBe(catalog["keda.title"]);
    }
  });
});
