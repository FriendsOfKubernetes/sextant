// "Add column…" of a resource table's Columns menu (#214): a label key, an annotation key or a simple field path,
// a header, and whether the column is for this cluster or every cluster. Checked as it is typed (`checkSpec`); the
// column is stored in `AppSettings.customColumns`.
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings, type ClusterId, type KubeObject } from "../../api";
import { Button, Dialog, Radio } from "../../components";
import { withColumn, MAX_COLUMNS_PER_KIND, type AddProblem } from "./model";
import { checkSpec, MAX_FIELD_PATH_CHARS, MAX_KEY_CHARS, MAX_TITLE_CHARS, type ColumnSource, type SpecTarget } from "./path";
import "./customColumns.css";

export interface AddColumnDialogProps {
  clusterId: ClusterId;
  target: SpecTarget;
  /** Objects of the table, for key suggestions (only their label and annotation keys are read). */
  objects?: ReadonlyMap<string, KubeObject>;
  onClose: () => void;
}

/** Most keys suggested per source. */
const MAX_SUGGESTIONS = 200;

function keysOf(objects: ReadonlyMap<string, KubeObject> | undefined, source: "labels" | "annotations"): string[] {
  const keys = new Set<string>();
  for (const obj of objects?.values() ?? []) {
    const map = obj.metadata?.[source];
    if (map && typeof map === "object") for (const key of Object.keys(map)) keys.add(key);
    if (keys.size >= MAX_SUGGESTIONS) break;
  }
  return [...keys].sort();
}

export function AddColumnDialog({ clusterId, target, objects, onClose }: AddColumnDialogProps) {
  const { t } = useTranslation();
  const ids = { input: useId(), list: useId(), hint: useId(), error: useId() };
  const [source, setSource] = useState<ColumnSource>("label");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"cluster" | "all">("cluster");
  const [saveProblem, setSaveProblem] = useState<AddProblem | null>(null);
  const [touched, setTouched] = useState(false);
  const suggestions = useMemo(
    () => (source === "field" ? [] : keysOf(objects, source === "label" ? "labels" : "annotations")),
    [objects, source],
  );

  const checked = checkSpec(target, source, text, title);
  const problem = "problem" in checked ? checked.problem : null;
  // An empty field is not an error until the user tried to add.
  const shownProblem = problem && (touched || !problem.endsWith("Empty")) ? problem : null;
  const errorText = shownProblem
    ? t(`customcolumns:errors.${shownProblem}`)
    : saveProblem
      ? t(`customcolumns:errors.${saveProblem}`, { max: MAX_COLUMNS_PER_KIND })
      : null;

  const submit = () => {
    setTouched(true);
    if (!("spec" in checked)) return;
    const kind = { group: target.group, kind: target.kind };
    let refused: AddProblem | null = null;
    void updateSettings((current) => {
      const next = withColumn(current, scope === "cluster" ? clusterId : null, kind, checked.spec);
      if ("problem" in next) {
        refused = next.problem;
        return current;
      }
      return next;
    }).then(
      () => (refused ? setSaveProblem(refused) : onClose()),
      () => undefined,
    );
  };

  const field = source === "field";
  const sources: [ColumnSource, string][] = [
    ["label", t("customcolumns:dialog.sourceLabel")],
    ["annotation", t("customcolumns:dialog.sourceAnnotation")],
    ["field", t("customcolumns:dialog.sourceField")],
  ];
  return (
    <Dialog
      open
      title={t("customcolumns:dialog.heading")}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t("customcolumns:dialog.cancel")}</Button>
          <Button variant="primary" disabled={problem !== null && touched} onClick={submit}>
            {t("customcolumns:dialog.add")}
          </Button>
        </>
      }
    >
      <form
        className="cc-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="cc-form__field">
          <legend>{t("customcolumns:dialog.source")}</legend>
          <div className="cc-form__choices">
            {sources.map(([value, label]) => (
              <label key={value} className="cc-form__choice">
                <Radio
                  name="cc-source"
                  checked={source === value}
                  onChange={() => {
                    setSource(value);
                    setSaveProblem(null);
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="cc-form__field">
          <label htmlFor={ids.input}>{field ? t("customcolumns:dialog.path") : t("customcolumns:dialog.key")}</label>
          <input
            id={ids.input}
            data-autofocus
            className="cc-form__mono"
            value={text}
            spellCheck={false}
            autoComplete="off"
            maxLength={field ? MAX_FIELD_PATH_CHARS : MAX_KEY_CHARS}
            list={suggestions.length > 0 ? ids.list : undefined}
            aria-invalid={shownProblem !== null || undefined}
            aria-describedby={`${ids.hint}${errorText ? ` ${ids.error}` : ""}`}
            onChange={(e) => {
              setText(e.target.value);
              setSaveProblem(null);
            }}
          />
          {suggestions.length > 0 && (
            <datalist id={ids.list}>
              {suggestions.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          )}
          <small id={ids.hint}>{field ? t("customcolumns:dialog.pathHint") : t("customcolumns:dialog.keyHint")}</small>
          {field && target.metadataOnly && <small>{t("customcolumns:dialog.metadataOnlyHint")}</small>}
        </div>
        {errorText && (
          <p id={ids.error} className="cc-form__error" role="alert">
            {errorText}
          </p>
        )}
        <label className="cc-form__field">
          <span>{t("customcolumns:dialog.header")}</span>
          <input
            value={title}
            maxLength={MAX_TITLE_CHARS}
            placeholder={t("customcolumns:dialog.titlePlaceholder")}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <fieldset className="cc-form__field">
          <legend>{t("customcolumns:dialog.scope")}</legend>
          <div className="cc-form__choices">
            <label className="cc-form__choice">
              <Radio name="cc-scope" checked={scope === "cluster"} onChange={() => setScope("cluster")} />
              {t("customcolumns:dialog.scopeCluster")}
            </label>
            <label className="cc-form__choice">
              <Radio name="cc-scope" checked={scope === "all"} onChange={() => setScope("all")} />
              {t("customcolumns:dialog.scopeAll")}
            </label>
          </div>
        </fieldset>
        {target.group === "" && target.kind === "Secret" && <p className="cc-form__note">{t("customcolumns:dialog.secretNote")}</p>}
      </form>
    </Dialog>
  );
}
