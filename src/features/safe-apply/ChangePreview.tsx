// What a save or an apply would do, from the server's dry run (#141): the objects it names (when there are several)
// and, for the chosen one, the live object against what the API server would store, side by side. Secrets come
// without their values (the core strips them); which of their values change is told by key name.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BadgeTone } from "../../components";
import { Badge, ErrorState } from "../../components";
import { toApiError, type DryRunChange, type DryRunObject, type DryRunResult, type ObjectRef } from "../../api";
import { formatList } from "../../i18n/format";
import { toYaml } from "../details";
import { TemplateDiff } from "../rollouts/TemplateDiff";
import { refusalsOf } from "./refusals";

const TONES: Record<DryRunChange, BadgeTone> = { create: "info", update: "warning", unchanged: "neutral", failed: "danger" };

/** "Deployment demo/web", "Namespace demo". */
export function describeObject(r: ObjectRef): string {
  return r.namespace ? `${r.kind.kind} ${r.namespace}/${r.name}` : `${r.kind.kind} ${r.name}`;
}

const yamlOf = (value: unknown): string => (value === null || value === undefined ? "" : toYaml(value));

export function ChangePreview({ result }: { result: DryRunResult }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(0);
  const objects = result.objects;
  const current = objects[selected] ?? objects[0];
  const { blocking, awaitingNamespace } = useMemo(() => refusalsOf(result), [result]);
  if (!current) return null;
  return (
    <div className="safe-apply-preview" aria-label={t("safeapply:diff.title")} role="region">
      {blocking.length > 0 && (
        <p className="safe-apply-preview__warning" role="alert">
          {t("safeapply:diff.refused", { count: blocking.length })}
        </p>
      )}
      {awaitingNamespace.map(({ object, namespace }) => (
        <p key={`${object.label}:${describeObject(object.object)}`} className="safe-apply-preview__warning">
          {t("safeapply:diff.waitsForNamespace", { object: describeObject(object.object), namespace })}
        </p>
      ))}
      <div className="safe-apply-preview__body">
        {objects.length > 1 && (
          <ul className="safe-apply-preview__list" aria-label={t("safeapply:diff.objects")}>
            {objects.map((o, index) => (
              <li key={`${o.label}:${describeObject(o.object)}`}>
                <button
                  type="button"
                  className="safe-apply-preview__item"
                  aria-current={o === current ? "true" : undefined}
                  onClick={() => setSelected(index)}
                >
                  <span className="safe-apply-preview__name">{describeObject(o.object)}</span>
                  <Badge tone={TONES[o.change]}>{t(`safeapply:diff.state.${o.change}`)}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ObjectDiff key={selected} object={current} />
      </div>
    </div>
  );
}

function ObjectDiff({ object }: { object: DryRunObject }) {
  const { t } = useTranslation();
  const left = useMemo(() => yamlOf(object.before), [object.before]);
  const right = useMemo(() => yamlOf(object.after), [object.after]);
  const name = describeObject(object.object);
  if (object.error) {
    return (
      <div className="safe-apply-preview__object">
        <ErrorState error={toApiError(object.error)} title={t("safeapply:diff.refusedObject", { object: name })} />
      </div>
    );
  }
  const keys = object.secretKeys;
  return (
    <div className="safe-apply-preview__object">
      <div className="safe-apply-preview__notes">
        {object.change === "create" && <p>{t("safeapply:diff.created", { object: name })}</p>}
        {object.change === "unchanged" && <p>{t("safeapply:diff.unchanged", { object: name })}</p>}
        {keys && <p>{t("safeapply:diff.secretHidden")}</p>}
        {keys && keys.added.length > 0 && <p>{t("safeapply:diff.secretAdded", { keys: formatList(keys.added) })}</p>}
        {keys && keys.changed.length > 0 && (
          <p>{t("safeapply:diff.secretChanged", { keys: formatList(keys.changed) })}</p>
        )}
        {keys && keys.removed.length > 0 && (
          <p>{t("safeapply:diff.secretRemoved", { keys: formatList(keys.removed) })}</p>
        )}
      </div>
      <TemplateDiff
        left={left}
        right={right}
        leftTitle={t("safeapply:diff.live")}
        rightTitle={t("safeapply:diff.after")}
      />
    </div>
  );
}
