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
import type { ClusterState, JobState, ServiceState } from "./model";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const CLUSTER: ClusterState[] = ["ready", "provisioning", "headNotReady", "suspending", "suspended", "failed"];
const JOB: JobState[] = ["succeeded", "running", "pending", "retrying", "stopped", "suspended", "failed"];
const SERVICE: ServiceState[] = ["ready", "upgrading", "notReady", "suspended", "failed"];
const BUILT = [
  ...CLUSTER.map((s) => `clusterState.${s}`),
  ...JOB.map((s) => `jobState.${s}`),
  ...SERVICE.map((s) => `serviceState.${s}`),
  ...["CPU", "Memory", "GPU", "TPU"].map((r) => `desiredResource.${r}`),
  "suspendedNote.suspended",
  "suspendedNote.suspending",
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
        // Table headers: `["name", "type"].map((h) => t(`pods.${h}`))`.
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
  type Case = { text: string; tooltip?: string; tooltipOr?: string[] };
  /** A text of placeholders and signs only has nothing to translate: every language uses it as written. */
  const wordless = (text: string) => !/\p{L}/u.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));
  const c = manifest.contributes;
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
          ...(wordless(cs.text) ? [] : [`columns.${col.id}.cases.${i}.text`]),
          ...(cs.tooltip === undefined || wordless(cs.tooltip) ? [] : [`columns.${col.id}.cases.${i}.tooltip`]),
          ...(cs.tooltipOr ?? []).flatMap((tip, k) => (wordless(tip) ? [] : [`columns.${col.id}.cases.${i}.tooltipOr.${k}`])),
        ])),
      ]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, ...(wordless(r.message) ? [] : [`problems.${r.id}.message`])]),
    ].sort();
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    // The counter's label in exactly the language's plural forms (ADR-0167).
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(keys);
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.kuberay.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles, each its own", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    const english = new Map<string, string>();
    for (const col of c.columns) {
      for (const [i, cs] of ((col as { cases?: Case[] }).cases ?? []).entries()) {
        english.set(`columns.${col.id}.cases.${i}.text`, cs.text);
        if (cs.tooltip !== undefined) english.set(`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip);
      }
    }
    for (const rule of c.problems) english.set(`problems.${rule.id}.message`, rule.message);
    // Every hover and problem message here is the object's own words, through placeholders only.
    expect([...english].filter(([k, v]) => !k.endsWith(".text") && !wordless(v))).toEqual([]);
    expect(new Set(c.problems.map((r) => r.title)).size).toBe(c.problems.length);
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of english) if (!wordless(text)) expect(placeholders(texts[key]!), `${language} ${key}`).toEqual(placeholders(text));
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
      expect(new Set(c.problems.map((r) => texts[`problems.${r.id}.title`])).size, language).toBe(c.problems.length);
    }
  });

  it("say the states, the kinds and the columns as the details do, and the counter as the built-in one", () => {
    const cases = (id: string) => (c.columns.find((col) => col.id === id) as { cases: Case[] }).cases;
    const catalogs = CATALOGS as Record<string, Record<string, string>>;
    for (const language of SEXTANT_LANGUAGES) {
      const catalog = catalogs[language]!;
      const text = (key: string, english: string) => (language === "en" ? english : translations[language]![key]);
      for (const [id, prefix] of [
        ["cluster-status", "clusterState"],
        ["job-status", "jobState"],
        ["service-status", "serviceState"],
      ] as const) {
        for (const [i, cs] of cases(id).entries()) {
          const state = Object.entries(en).find(([k, v]) => k.startsWith(`${prefix}.`) && v === cs.text)![0];
          expect(text(`columns.${id}.cases.${i}.text`, cs.text), `${language} ${id} ${i}`).toBe(catalog[state]);
        }
      }
    }
  });
});
