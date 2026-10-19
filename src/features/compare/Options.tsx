// "Hide defaults" and the ignore paths of a kind (saved in the settings, per kind).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { KindRef } from "../../api";
import { Button, Checkbox } from "../../components";
import { useIgnorePaths } from "./hooks";
import { MAX_IGNORE_PATHS, parsePath } from "./paths";

export interface CompareOptionsProps {
  kind: Pick<KindRef, "group" | "kind">;
  hideDefaults: boolean;
  onHideDefaults: (value: boolean) => void;
}

export function CompareOptions({ kind, hideDefaults, onHideDefaults }: CompareOptionsProps) {
  const { t } = useTranslation();
  return (
    <div className="compare-options">
      <label className="compare-check" title={t("compare:options.hideDefaultsHint")}>
        <Checkbox checked={hideDefaults} onChange={(e) => onHideDefaults(e.target.checked)} />
        {t("compare:options.hideDefaults")}
      </label>
      <IgnorePathsEditor kind={kind} />
    </div>
  );
}

/** The saved ignore paths of `kind`: remove one, add one (checked as a path first). */
export function IgnorePathsEditor({ kind }: { kind: Pick<KindRef, "group" | "kind"> }) {
  const { t } = useTranslation();
  const { paths, add, remove, error } = useIgnorePaths(kind);
  const [draft, setDraft] = useState("");
  const text = draft.trim();
  const invalid = text !== "" && parsePath(text) === null;
  const full = paths.length >= MAX_IGNORE_PATHS;
  const submit = () => {
    if (text === "" || invalid || full) return;
    add(text);
    setDraft("");
  };
  return (
    <div className="compare-ignore">
      <span className="compare-ignore__title">{t("compare:options.ignoreTitle", { kind: kind.kind })}</span>
      {paths.length === 0 ? (
        <span className="compare-muted">{t("compare:options.ignoreNone")}</span>
      ) : (
        <ul className="compare-ignore__list">
          {paths.map((path) => (
            <li key={path}>
              <code>{path}</code>
              <Button size="compact" iconOnly icon="close" label={t("compare:options.ignoreRemove", { path })} onClick={() => remove(path)} />
            </li>
          ))}
        </ul>
      )}
      <form
        className="compare-ignore__add"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          className="compare-input compare-mono"
          value={draft}
          placeholder={t("compare:options.ignorePlaceholder")}
          aria-label={t("compare:options.ignoreAdd")}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button size="compact" type="submit" icon="add" disabled={text === "" || invalid || full}>
          {t("compare:options.ignoreAddButton")}
        </Button>
      </form>
      {invalid && <span className="compare-error">{t("compare:options.ignoreInvalid")}</span>}
      {full && <span className="compare-muted">{t("compare:options.ignoreFull", { max: MAX_IGNORE_PATHS })}</span>}
      {error && <span className="compare-error">{error.message}</span>}
    </div>
  );
}
