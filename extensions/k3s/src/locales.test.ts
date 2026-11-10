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
import { CHART_TONE, COMPONENT_TONE, COMPONENTS, SNAPSHOT_TONE } from "./model";

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
        // The rows of `fieldsOf`, labelled `fields.<key>` (not the quantity suffixes of `dom.ts`, `["Ki", 2 ** 10]`).
        ...[...text.matchAll(/^\s*\["([a-zA-Z]+)", (?![0-9])/gm)].map((m) => `fields.${m[1]!}`),
        // Table headers: `["service", "daemonSet"].map((h) => t(`serviceLb.${h}`))`.
        ...[...text.matchAll(/\[((?:"[a-zA-Z]+",?\s*)+)\]\.map\(\(h\) => t\(`([a-zA-Z.]+)\.\$\{h\}`\)\)/g)].flatMap((m) =>
          [...m[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((h) => `${m[2]!}.${h[1]!}`),
        ),
      ];
    });
    const built = [
      ...Object.keys(CHART_TONE).map((s) => `chartState.${s}`),
      ...["running", "complete", "failed", "pending"].map((s) => `jobState.${s}`),
      ...Object.keys(SNAPSHOT_TONE).map((s) => `snapshotState.${s}`),
      ...["s3", "local"].map((s) => `storage.${s}`),
      ...["k3s", "rke2", "mixed"].map((s) => `distribution.${s}`),
      ...["controlPlane", "etcd", "master"].map((s) => `role.${s}`),
      ...["kubeletVersion", "annotations", "providerId", "instanceType"].map((s) => `signal.${s}`),
      ...COMPONENTS.map((c) => `component.${c.id}`),
      ...Object.keys(COMPONENT_TONE).map((s) => `components.state.${s}`),
      ...["k3s", "rke2"].map((s) => `components.hint.${s}`),
    ];
    expect(keys.length).toBeGreaterThan(60);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;

  it("translate every text of the manifest into every language Sextant has", () => {
    const keys = [
      "name",
      "description",
      ...c.kinds.map((_, i) => `kinds.${i}.title`),
      ...c.sections.map((s) => `sections.${s.section}.title`),
      ...c.pages.map((p) => `pages.${p.id}.title`),
      ...c.detailsSections.map((s) => `detailsSections.${s.id}.title`),
      ...c.columns.flatMap((col) => [
        `columns.${col.id}.title`,
        ...(((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
          // A blank cell has nothing to translate.
          ...(cs.text === "" ? [] : [`columns.${col.id}.cases.${i}.text`]),
          ...(cs.tooltip === undefined ? [] : [`columns.${col.id}.cases.${i}.tooltip`]),
        ])),
      ]),
      ...c.problems.flatMap((r) => [`problems.${r.id}.title`, `problems.${r.id}.message`]),
    ].sort();
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      expect(Object.keys(texts).filter((k) => !badge(k)).sort(), language).toEqual(keys);
      // The counters' labels in exactly the language's plural forms (ADR-0167).
      const forms = [...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort();
      for (const section of c.sectionBadges.map((b) => b.section)) {
        const prefix = `sectionBadges.${section}.label.`;
        const own = Object.keys(texts).filter((k) => k.startsWith(prefix));
        expect(own.map((k) => k.slice(prefix.length)).sort(), `${language} ${section}`).toEqual(forms);
        for (const k of own) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      }
      for (const [k, v] of Object.entries(texts)) expect(v.trim(), `${language} ${k}`).not.toBe("");
    }
  });

  it("keep the English placeholders, and translate the problem rules' titles", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
    const english = new Map<string, string>();
    for (const rule of c.problems) english.set(`problems.${rule.id}.message`, rule.message);
    for (const col of c.columns) ((col as { cases?: Case[] }).cases ?? []).forEach((cs, i) => cs.text !== "" && english.set(`columns.${col.id}.cases.${i}.text`, cs.text));
    for (const [language, texts] of Object.entries(translations)) {
      for (const [key, text] of english) expect(placeholders(texts[key]!), `${language} ${key}`).toEqual(placeholders(text));
      for (const rule of c.problems) expect(texts[`problems.${rule.id}.title`], language).not.toBe(rule.title);
    }
  });

  it("say the states as the details do, in every language", () => {
    const states: [string, string][] = [
      ["chart-state", "chartState"],
      ["snapshot-state", "snapshotState"],
      ["snapshot-storage", "storage"],
    ];
    for (const [id, prefix] of states) {
      const column = c.columns.find((col) => col.id === id)! as { cases: (Case & { value: string })[] };
      column.cases.forEach((cs) => expect(cs.text, `${id} ${cs.value}`).toBe(en[`${prefix}.${cs.value}` as keyof typeof en]));
      for (const [language, texts] of Object.entries(translations)) {
        const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
        column.cases.forEach((cs, i) => expect(texts[`columns.${id}.cases.${i}.text`], `${language} ${id}`).toBe(catalog[`${prefix}.${cs.value}`]));
      }
    }
  });
});
