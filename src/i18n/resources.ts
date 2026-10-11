// Builds i18next resources from translation files `src/locales/<lang>/<namespace>.json`.
// A new language is a new directory; nothing else has to change.

export type Translations = Record<string, unknown>;
export type Resources = Record<string, Record<string, Translations>>;

const LOCALE_FILE = /\/locales\/([^/]+)\/([^/]+)\.json$/;

/** `modules` is the result of `import.meta.glob("…/locales/*\/*.json", { eager: true })`. */
export function buildResources(modules: Record<string, unknown>): Resources {
  const resources: Resources = {};
  for (const [path, mod] of Object.entries(modules)) {
    const match = LOCALE_FILE.exec(path);
    if (!match) continue;
    const [, lang, ns] = match as unknown as [string, string, string];
    const data = (mod && typeof mod === "object" && "default" in mod ? mod.default : mod) as Translations;
    (resources[lang] ??= {})[ns] = data;
  }
  return resources;
}

export function languagesOf(resources: Resources): string[] {
  return Object.keys(resources).sort();
}

export function namespacesOf(resources: Resources): string[] {
  const all = new Set<string>();
  for (const byNs of Object.values(resources)) for (const ns of Object.keys(byNs)) all.add(ns);
  return [...all].sort();
}
