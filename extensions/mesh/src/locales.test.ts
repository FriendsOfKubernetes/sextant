// The extension's texts in every language Sextant has (ADR-0140): a catalog per language with English's keys,
// placeholders and each language's plural forms, every key the code asks for, and the manifest translated whole.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogProblems } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import { OPERATION_FIELDS, SOURCE_FIELDS } from "./engine/authz";
import { CATALOGS } from "./i18n";
import en from "./locales/en.json";

const here = dirname(fileURLToPath(import.meta.url));
/** Sextant's own UI languages: the directories of `src/locales`. */
const SEXTANT_LANGUAGES = readdirSync(join(here, "../../../src/locales"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const has = (key: string) => Object.hasOwn(en, key) || Object.hasOwn(en, `${key}_other`);
const each = (prefix: string, names: readonly string[]) => names.map((n) => `${prefix}.${n}`);

describe("catalogs", () => {
  it("exist for every language Sextant has", () => {
    expect(Object.keys(CATALOGS).sort()).toEqual(SEXTANT_LANGUAGES);
  });

  it("have English's keys, placeholders and each language's plural forms", () => {
    expect(catalogProblems(CATALOGS)).toEqual([]);
  });

  it("have every key the code asks for", () => {
    const sources = [...readdirSync(here), ...readdirSync(join(here, "engine")).map((f) => `engine/${f}`)].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const keys = sources.flatMap((f) => {
      const text = readFileSync(join(here, f), "utf8");
      return [
        ...[...text.matchAll(/\bt\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // `t(cond ? "a" : "b")`, phrases `p("a", …)` and keys chosen by a condition.
        ...[...text.matchAll(/\bt\([^()"]*\? "([a-zA-Z0-9_.]+)" : "([a-zA-Z0-9_.]+)"/g)].flatMap((m) => [m[1]!, m[2]!]),
        ...[...text.matchAll(/\bp\(\s*"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        ...[...text.matchAll(/"((?:membership|check)\.[a-zA-Z0-9_.]+)"/g)].map((m) => m[1]!),
        // The rows of `fieldsOf`, labelled `fields.<key>`.
        ...(f.startsWith("engine/") ? [] : [...text.matchAll(/^\s*\["([a-zA-Z]+)", (?!")/gm)].map((m) => `fields.${m[1]!}`)),
      ];
    });
    const built = [
      ...each("mtls.meaning", ["STRICT", "PERMISSIVE", "DISABLE", "UNSET"]),
      ...each("mtls.source", ["workload", "namespace", "mesh", "default"]),
      ...each("authz.decision", ["allowed", "denied", "unknown", "external"]),
      ...each("authz.reason", ["noPolicies", "allowMatched", "noAllowMatched", "denyMatched", "denyMayMatch", "allowMayMatch", "customMatched", "customMayMatch", "invalidPolicy", "targetRefNotEvaluated"]),
      ...each("authz.match", ["yes", "no", "unknown"]),
      ...each("authz.fields", [...SOURCE_FIELDS, ...OPERATION_FIELDS]),
      ...each("authz.caller", ["namespace", "serviceAccount", "method", "path", "port", "ip", "remoteIp"]),
      ...each("authz.scope", ["targetRef", "workloads", "mesh", "namespace"]),
      ...each("authz.action", ["ALLOW", "DENY", "AUDIT", "CUSTOM", "INVALID"]),
      ...each("membership.istio", ["sidecar", "nativeSidecar", "ambient", "none"]),
      ...each("membership.linkerd", ["proxy", "nativeProxy", "none"]),
      ...each("membership.via", ["pod", "namespace"]),
      ...each("membership.injectOn", ["pod", "namespace"]),
      ...each("check.outcome", ["routed", "defaultRoute", "redirected", "directResponse", "noRoute", "passthrough", "noGatewayServer", "unknownGateway", "delegateMissing", "l4Only", "notEvaluated"]),
      ...each("check.answer", ["redirected", "directResponse", "noRoute", "passthrough", "noGatewayServer", "delegateMissing"]),
      ...each("check.skipped", ["uri", "scheme", "method", "authority", "headers", "withoutHeaders", "queryParams", "port", "sourceLabels", "sourceNamespace", "gateways"]),
      ...each("check.candidate", ["notExported", "lessSpecificHost", "duplicateIgnored", "invalidMeshWildcard"]),
      ...each("check.notes", ["regexDialect", "sidecarScope", "l4NotChecked", "gatewayPort", "gatewaySourceLabels"]),
      ...each("check.problem", ["unknownHost", "noDestinationRule", "missingSubset"]),
      ...each("problem", ["UnknownHost", "MissingDestinationRule", "MissingSubset", "MissingGateway", "TlsConflict", "InvalidVirtualService", "ConflictingVirtualService"]),
      ...each("match.uri", ["exact", "prefix", "regex"]),
      ...each("match.header", ["exact", "prefix", "regex"]),
      ...each("blocks", ["virtualService", "httpRoutes", "l4Routes", "destinationRule", "portTls", "subsets", "gateway", "servers", "boundVirtualServices", "serviceEntry", "sidecar", "workloadEntry", "telemetry", "peerAuthentication", "portMtls", "requestAuthentication", "authorizationPolicy", "serviceProfile", "profileRoutes", "server", "serverAuthorizations", "serverAuthorization", "linkerdAuthorizationPolicy", "meshTlsAuthentication", "networkAuthentication", "linkerdHttpRoute", "istioMembership", "mtls", "whoMayCall", "linkerdMembership"]),
      "tls.auto",
      "list.separator",
    ];
    expect(keys.length).toBeGreaterThan(100);
    const missing = [...new Set([...keys, ...built])].filter((key) => !has(key));
    expect(missing).toEqual([]);
  });
});

describe("the manifest's translations", () => {
  type Case = { text: string };
  const c = manifest.contributes;
  const translations = manifest.translations as Record<string, Record<string, string>>;
  const english = new Map<string, string>([
    ["name", manifest.name],
    ["description", manifest.description],
    ...c.kinds.map((k, i) => [`kinds.${i}.title`, k.title] as const),
    ...c.sections.map((s) => [`sections.${s.section}.title`, s.title] as const),
    ...c.pages.map((p) => [`pages.${p.id}.title`, p.title] as const),
    ...c.detailsSections.map((d) => [`detailsSections.${d.id}.title`, d.title] as const),
    ...c.columns.flatMap((col) => [
      [`columns.${col.id}.title`, col.title] as const,
      ...(((col as { cases?: Case[] }).cases ?? []).map((cs, i) => [`columns.${col.id}.cases.${i}.text`, cs.text] as const)),
      ...(((col as { items?: { cases: Case[] } }).items?.cases ?? []).map((cs, i) => [`columns.${col.id}.items.${i}.text`, cs.text] as const)),
    ]),
    ...c.problems.flatMap((r) => [[`problems.${r.id}.title`, r.title] as const, [`problems.${r.id}.message`, r.message] as const]),
  ]);
  /**
   * Texts a language may write as English does, left out of `translations` (the window then shows the English): the
   * built-in catalogs' texts a language kept in English (Istio's and Linkerd's kind names, field names), Istio's own
   * values, a blank cell, and texts made only of placeholders.
   */
  const sameAllowed = (key: string, text: string, language: string) => {
    if (!/\p{L}/u.test(text.replace(/\{\{[^}]+\}\}/g, "")) || /^(mesh|UNSET|ALLOW|INVALID|Istio|Linkerd)$/.test(text)) return true;
    // A column's or kind's title the built-in catalog of the language wrote as English.
    return /^(columns\.[a-z-]+\.title|kinds\.\d+\.title|pages\..+|detailsSections\..+|name)$/.test(key) && language !== "";
  };

  it("translate every text of the manifest into every language Sextant has", () => {
    expect(Object.keys(translations).sort()).toEqual(SEXTANT_LANGUAGES.filter((l) => l !== "en"));
    const badge = (key: string) => key.startsWith("sectionBadges.");
    for (const [language, texts] of Object.entries(translations)) {
      for (const key of Object.keys(texts).filter((k) => !badge(k))) expect(english.has(key), `${language} ${key}`).toBe(true);
      for (const [key, text] of english) {
        if (!Object.hasOwn(texts, key)) expect(sameAllowed(key, text, language), `${language} leaves out ${key}: ${text}`).toBe(true);
        // What a language translates differs from English (the same text is left out, not repeated).
        else if (!key.startsWith("problems.")) expect(texts[key], `${language} ${key}`).not.toBe(text);
      }
      // The description and the rules' own texts are the extension's: every language has them.
      expect(texts.description, language).toBeDefined();
      // The counter's label in exactly the language's plural forms (ADR-0167), the built-in counter's words.
      const forms = Object.keys(texts)
        .filter(badge)
        .map((k) => k.slice("sectionBadges.istio.label.".length))
        .sort();
      expect(forms, language).toEqual([...new Intl.PluralRules(language).resolvedOptions().pluralCategories].sort());
      for (const k of Object.keys(texts).filter(badge)) expect(texts[k], `${language} ${k}`).toContain("{{count}}");
      for (const [k, v] of Object.entries(texts)) expect(v.trim(), `${language} ${k}`).not.toBe("");
    }
  });

  it("the kinds, columns and scope texts are the built-in catalogs' words", () => {
    const c = manifest.contributes;
    const ru = translations.ru!;
    c.kinds.forEach((k, i) => expect(ru[`kinds.${i}.title`] ?? k.title).toBe(CATALOGS.ru![`sidebar.${["virtualServices", "destinationRules", "gateways", "serviceEntries", "sidecars", "workloadEntries", "peerAuthentications", "requestAuthentications", "authorizationPolicies", "telemetries", "serviceProfiles", "servers", "httpRoutes", "authorizationPolicies", "serverAuthorizations", "meshTlsAuthentications", "networkAuthentications"][i]}`]));
    expect(ru["columns.pa-applies.cases.1.text"]).toBe(CATALOGS.ru!["scope.namespace"]);
    expect(ru["columns.vs-hosts.title"]).toBe(CATALOGS.ru!["columns.hosts"]);
    expect(ru["pages.request-check.title"]).toBe(CATALOGS.ru!["sidebar.requestCheck"]);
    expect(ru.name).toBe("Сервисная сеть");
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
