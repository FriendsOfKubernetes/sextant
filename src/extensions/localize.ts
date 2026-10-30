// An extension's texts in the UI language (ADR-0140): its manifest's `translations` for the language Sextant shows,
// chosen as Sextant chooses its own (`matchLanguage`), English (the manifest itself) for whatever is not translated.
// Rust has checked every translation when it read the manifest: keys of real texts, their limits, a problem message
// with exactly the English placeholders. Ids, kinds, paths and metric queries are never translated.
import type { ExtensionInfo, ExtensionManifest } from "../api";
import { matchLanguage } from "../i18n";

/** The manifest's texts for `language` (a UI language such as `pt-BR`); the manifest itself when none fits. */
export function localizeManifest(manifest: ExtensionManifest, language: string): ExtensionManifest {
  const translations = manifest.translations ?? {};
  const chosen = matchLanguage([language], Object.keys(translations));
  const texts = chosen === undefined ? undefined : translations[chosen];
  if (!texts) return manifest;
  const text = (key: string, english: string) => texts[key] ?? english;
  const c = manifest.contributes;
  const localized: ExtensionManifest = {
    ...manifest,
    name: text("name", manifest.name),
    description: text("description", manifest.description),
    contributes: {
      ...c,
      pages: c.pages.map((p) => ({
        ...p,
        title: text(`pages.${p.id}.title`, p.title),
        ...(p.sectionTitle !== undefined ? { sectionTitle: text(`pages.${p.id}.sectionTitle`, p.sectionTitle) } : {}),
      })),
      detailsSections: c.detailsSections.map((s) => ({ ...s, title: text(`detailsSections.${s.id}.title`, s.title) })),
      actions: c.actions.map((a) => ({ ...a, title: text(`actions.${a.id}.title`, a.title) })),
      columns: c.columns.map((col) => ({ ...col, title: text(`columns.${col.id}.title`, col.title) })),
      dockActions: c.dockActions.map((d) => ({ ...d, title: text(`dockActions.${d.id}.title`, d.title) })),
      problems: c.problems.map((r) => ({
        ...r,
        title: text(`problems.${r.id}.title`, r.title),
        message: text(`problems.${r.id}.message`, r.message),
      })),
      metricQueries: c.metricQueries.map((q) => ({ ...q, title: text(`metricQueries.${q.id}.title`, q.title) })),
    },
  };
  if (c.settings) localized.contributes.settings = { title: text("settings.title", c.settings.title) };
  if (manifest.backend) {
    localized.backend = {
      ...manifest.backend,
      credentials: manifest.backend.credentials.map((cred) => ({
        ...cred,
        label: text(`backend.credentials.${cred.id}.label`, cred.label),
      })),
    };
  }
  return localized;
}

/** An installed extension with its texts in `language`. */
export function localizeExtension(info: ExtensionInfo, language: string): ExtensionInfo {
  if (!info.manifest?.translations) return info;
  const manifest = localizeManifest(info.manifest, language);
  return manifest === info.manifest ? info : { ...info, name: manifest.name, manifest };
}
