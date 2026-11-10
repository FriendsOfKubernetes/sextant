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
import { CERT_READY_REASONS, ISSUER_REASONS, ISSUER_TYPES, ORDER_STATES, REQUEST_REASONS } from "./model";

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
        // The rows of the views, labelled `fields.<key>`.
        ...(f === "details.ts" ? [...text.matchAll(/^\s*\["([a-zA-Z]+)",/gm)].map((m) => `fields.${m[1]!}`) : []),
      ];
    });
    const built = [
      ...CERT_READY_REASONS.map((r) => `explain.certificate.${r}`),
      "explain.certificate.failed",
      "explain.certificate.issuing",
      "explain.certificate.notReady",
      ...REQUEST_REASONS.filter((r) => r !== "Issued").map((r) => `explain.request.${r}`),
      "explain.request.InvalidRequest",
      "explain.request.notApproved",
      ...ISSUER_REASONS.map((r) => `explain.issuer.${r}`),
      "explain.issuer.notReady",
      ...ORDER_STATES.map((s) => `explain.order.${s}`),
      ...["httpStatus", "noHost", "unreachable", "dnsPropagation", "invalid", "errored", "expired", "presented", "pending"].map((s) => `explain.challenge.${s}`),
      ...["approved", "denied", "pending"].map((s) => `approval.${s}`),
      ...ISSUER_TYPES.map((s) => `issuerTypes.${s}`),
      "chain.loading",
      "chain.noCertificate",
      "chain.noRequests",
    ];
    expect(keys.length).toBeGreaterThan(40);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string; tooltip?: string; pluralBy?: string; textForms?: Record<string, string> };
  const FORMS = ["zero", "one", "two", "few", "many"];
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const placeholders = (text: string) => [...text.matchAll(/\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]).sort();
  /** A text without words: placeholders, punctuation and digits only. */
  const wordless = (text: string) => !/\p{L}/u.test(text.replace(/\{\{[\s\S]*?\}\}/g, ""));
  /** Values as cert-manager writes them, shown untranslated as the built-in columns showed them. */
  const RAW = new Set(["Unknown", "acme", "ca", "selfSigned", "vault", "venafi"]);
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as [string, string]),
    ...c.detailsSections.map((s) => [`detailsSections.${s.id}.title`, s.title] as [string, string]),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as [string, string]),
    // The main category's title, the built-in category's "Certificates" (ADR-0167).
    ["problemsTitle", c.problemsTitle],
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as [string, string],
      ...((col as { cases?: Case[] }).cases ?? []).flatMap((cs, i) => [
        [`columns.${col.id}.cases.${i}.text`, cs.text] as [string, string],
        ...(cs.tooltip === undefined ? [] : [[`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip] as [string, string]]),
        // A text by plural form: each form a language needs besides `other` (ADR-0167).
        ...(cs.pluralBy === undefined ? [] : FORMS.map((f) => [`columns.${col.id}.cases.${i}.textForms.${f}`, cs.textForms?.[f] ?? cs.text] as [string, string])),
      ]),
    ]),
    ...c.problems.flatMap((r) => [
      [`problems.${r.id}.title`, r.title] as [string, string],
      [`problems.${r.id}.message`, r.message] as [string, string],
    ]),
  ]);

  it("translate every text of the manifest with words into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const form = (key: string) => /\.textForms\.([a-z]+)$/.exec(key)?.[1];
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories as readonly string[];
      const needed = [...english]
        .filter(([key, text]) => !wordless(text) && !RAW.has(text) && (form(key) === undefined || categories.includes(form(key)!)))
        .map(([key]) => key)
        .sort();
      const keys = Object.keys(texts).filter((k) => !badge(k));
      expect(keys.filter((k) => !english.has(k)), language).toEqual([]);
      expect(keys.sort(), language).toEqual(needed);
      // The counter's label in exactly the language's plural forms (ADR-0167).
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.certManager.label.".length))
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

  it("say the approval and expiry as the details do", () => {
    const approval = (c.columns.find((col) => col.id === "cr-approved") as { cases: Case[] }).cases.map((cs) => cs.text);
    expect(approval).toEqual(["denied", "approved", "pending"].map((s) => en[`approval.${s}` as keyof typeof en]));
    for (const [language, texts] of Object.entries(translations)) {
      const catalog = CATALOGS[language as keyof typeof CATALOGS] as Record<string, string>;
      ["denied", "approved", "pending"].forEach((s, i) => expect(texts[`columns.cr-approved.cases.${i}.text`], language).toBe(catalog[`approval.${s}`]));
    }
  });
});
