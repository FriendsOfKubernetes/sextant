// What a kubeconfig change would do (`EditPreview`): the file, the entries added, removed, renamed or changed with
// their non-secret fields (credentials come as `<hidden>` from the backend), and what the rewrite loses.
import { useTranslation } from "react-i18next";
import type { EditPreview, EntryChange, FieldChange } from "../../../api";

function fieldText(t: (key: string, values?: Record<string, unknown>) => string, f: FieldChange): string {
  const none = t("kubeconfig:change.none");
  if (f.before !== null && f.after !== null) {
    return t("kubeconfig:change.fieldChange", { field: f.field, before: f.before, after: f.after });
  }
  if (f.before !== null) return t("kubeconfig:change.fieldChange", { field: f.field, before: f.before, after: none });
  return t("kubeconfig:change.field", { field: f.field, value: f.after ?? none });
}

function ChangeItem({ change }: { change: EntryChange }) {
  const { t } = useTranslation();
  const name =
    change.newName === null
      ? change.name
      : change.change === "renamed"
        ? t("kubeconfig:change.renamedTo", { name: change.name, newName: change.newName })
        : t("kubeconfig:change.addedAs", { name: change.name, newName: change.newName });
  return (
    <li className="kc-preview__item" data-change={change.change}>
      <span className="kc-preview__kind">{t(`kubeconfig:change.kind.${change.change}`)}</span>
      <span className="kc-preview__entry">{t(`kubeconfig:change.entry.${change.entry}`)}</span>
      {name && <span className="kc-preview__name">{name}</span>}
      {change.origin && (
        <span className="kc-preview__origin">
          {change.entry === "currentContext"
            ? t("kubeconfig:change.inFile", { path: change.origin })
            : t("kubeconfig:change.from", { path: change.origin })}
        </span>
      )}
      {change.fields.length > 0 && (
        <ul className="kc-preview__fields">
          {change.fields.map((f) => (
            <li key={f.field}>{fieldText(t, f)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PreviewView({ preview }: { preview: EditPreview }) {
  const { t } = useTranslation();
  const { realPath, backupPattern, backupsKept } = preview.target;
  const unsetsCurrent = preview.changes.some(
    (c) => c.entry === "currentContext" && c.origin === null && c.fields.some((f) => f.before !== null && f.after === null),
  );
  return (
    <div className="kc-preview">
      <p className="kc-preview__path">
        {preview.createsFile
          ? t("kubeconfig:edit.createsFile", { path: preview.path })
          : t("kubeconfig:edit.file", { path: preview.path })}
      </p>
      {realPath !== preview.path && <p className="kc-preview__path">{t("kubeconfig:edit.realFile", { path: realPath })}</p>}
      {preview.unchanged ? (
        <p className="clusters-hint">{t("kubeconfig:edit.unchanged")}</p>
      ) : (
        <ul className="kc-preview__list" aria-label={t("kubeconfig:change.listLabel")}>
          {preview.changes.map((c, i) => (
            <ChangeItem key={`${c.entry}-${c.name}-${i}`} change={c} />
          ))}
        </ul>
      )}
      {unsetsCurrent && <p className="clusters-hint">{t("kubeconfig:edit.currentContextUnset")}</p>}
      {preview.currentContextElsewhere.length > 0 && (
        <div className="kc-preview__warning" role="note">
          <p>{t("kubeconfig:edit.currentContextElsewhere")}</p>
          <ul>
            {preview.currentContextElsewhere.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </div>
      )}
      {!preview.createsFile && (
        <p className="clusters-hint">
          {backupPattern
            ? t("kubeconfig:edit.backupAt", { path: backupPattern, max: backupsKept })
            : t("kubeconfig:edit.backupHint")}
        </p>
      )}
      {preview.commentsLost && (
        <p className="kc-preview__warning" role="note">
          {t("kubeconfig:edit.commentsLost")}
        </p>
      )}
      {preview.layoutChanges && <p className="clusters-hint">{t("kubeconfig:edit.layoutChanges")}</p>}
    </div>
  );
}
