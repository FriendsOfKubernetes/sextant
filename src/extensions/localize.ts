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
      actions: c.actions.map((a) => ({
        ...a,
        title: text(`actions.${a.id}.title`, a.title),
        ...(a.whyNot !== undefined ? { whyNot: text(`actions.${a.id}.whyNot`, a.whyNot) } : {}),
        ...(a.ask !== undefined
          ? {
              ask: {
                title: text(`actions.${a.id}.ask.title`, a.ask.title),
                text: text(`actions.${a.id}.ask.text`, a.ask.text),
                confirm: text(`actions.${a.id}.ask.confirm`, a.ask.confirm),
              },
            }
          : {}),
        ...(a.done !== undefined ? { done: text(`actions.${a.id}.done`, a.done) } : {}),
      })),
      columns: c.columns.map((col) => ({
        ...col,
        title: text(`columns.${col.id}.title`, col.title),
        ...(col.valueText !== undefined ? { valueText: text(`columns.${col.id}.valueText`, col.valueText) } : {}),
        ...(col.cases !== undefined
          ? {
              cases: col.cases.map((cs, i) => ({
                ...cs,
                text: text(`columns.${col.id}.cases.${i}.text`, cs.text),
                ...(cs.tooltip !== undefined ? { tooltip: text(`columns.${col.id}.cases.${i}.tooltip`, cs.tooltip) } : {}),
              })),
            }
          : {}),
      })),
      menuItems: c.menuItems.map((m) => ({ ...m, title: text(`menuItems.${m.id}.title`, m.title) })),
      // A counter's label: the language's own plural forms when it translates any, else the English ones (#398).
      sectionBadges: c.sectionBadges.map((b) => {
        if (!b.label) return b;
        const prefix = `sectionBadges.${b.section}.label.`;
        const forms = Object.fromEntries(
          Object.entries(texts)
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => [key.slice(prefix.length), value]),
        );
        return Object.keys(forms).length > 0 ? { ...b, label: forms } : b;
      }),
      sections: c.sections.map((s) => ({
        ...s,
        ...(s.title !== undefined ? { title: text(`sections.${s.section}.title`, s.title) } : {}),
      })),
      services: c.services.map((s) => ({
        ...s,
        title: text(`services.${s.id}.title`, s.title),
        ...(s.signIn
          ? {
              signIn: {
                fields: s.signIn.fields.map((f) => ({ ...f, label: text(`services.${s.id}.signIn.${f.id}.label`, f.label) })),
              },
            }
          : {}),
      })),
      kinds: c.kinds.map((k, i) => ({
        ...k,
        ...(k.title !== undefined ? { title: text(`kinds.${i}.title`, k.title) } : {}),
        ...(k.sectionTitle !== undefined ? { sectionTitle: text(`kinds.${i}.sectionTitle`, k.sectionTitle) } : {}),
      })),
      dockActions: c.dockActions.map((d) => ({ ...d, title: text(`dockActions.${d.id}.title`, d.title) })),
      problems: c.problems.map((r) => ({
        ...r,
        title: text(`problems.${r.id}.title`, r.title),
        message: text(`problems.${r.id}.message`, r.message),
      })),
      problemCategories: (c.problemCategories ?? []).map((pc) => ({ ...pc, title: text(`problemCategories.${pc.id}.title`, pc.title) })),
      metricQueries: c.metricQueries.map((q) => ({ ...q, title: text(`metricQueries.${q.id}.title`, q.title) })),
      commands: c.commands.map((command) => ({ ...command, title: text(`commands.${command.id}.title`, command.title) })),
    },
  };
  if (c.settings) localized.contributes.settings = { title: text("settings.title", c.settings.title) };
  if (c.clusterSettings) localized.contributes.clusterSettings = { title: text("clusterSettings.title", c.clusterSettings.title) };
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
