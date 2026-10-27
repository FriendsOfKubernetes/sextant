// Settings → Clusters → Kubeconfig: per source, whether Sextant may edit it ("Allow Sextant to edit", off by default,
// turned on only after a warning; Sextant's own files are always editable — the backend checks the same rule), the
// "Merge files…" button and how early expiring credentials are flagged.
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, useSettings, type EditTarget, type KubeconfigSource, type SourceKind } from "../../../api";
import { Checkbox, ConfirmDialog } from "../../../components";
import { clampCredentialDays, credentialDaysOf, MAX_CREDENTIAL_EXPIRY_DAYS, MIN_CREDENTIAL_EXPIRY_DAYS } from "./credentials";
import { MergeButton } from "./MergeDialog";

/** Sextant's own files (pasted, cloud, merged): the backend lets Sextant edit them without the flag. */
export function isOwnSource(kind: SourceKind): boolean {
  return kind === "pasted" || kind === "cloud" || kind === "merged" || kind === "vcluster";
}

export function SourceWritable({ source }: { source: KubeconfigSource }) {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const [asking, setAsking] = useState(false);
  const [target, setTarget] = useState<EditTarget | null>(null);
  // Where the change would really go (a symlink's target) and where the copies are made, asked when the question opens.
  useEffect(() => {
    if (!asking) return;
    let live = true;
    setTarget(null);
    api.kubeconfig
      .editTarget(source.id)
      .then((found) => live && setTarget(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [asking, source.id]);
  if (isOwnSource(source.kind)) {
    return <span className="kc-source__own">{t("kubeconfig:sources.own")}</span>;
  }
  const allowed = settings?.kubeconfig?.writableSources.includes(source.id) ?? false;
  const save = (on: boolean) =>
    void update((s) => {
      const others = (s.kubeconfig?.writableSources ?? []).filter((id) => id !== source.id);
      return {
        ...s,
        kubeconfig: { ...s.kubeconfig, writableSources: on ? [...others, source.id] : others },
      };
    }).catch(() => undefined);
  return (
    <>
      <label className="settings__choice kc-source__allow">
        <Checkbox
          checked={allowed}
          disabled={!settings}
          aria-label={t("kubeconfig:sources.allowNamed", { path: source.path })}
          onChange={(e) => (e.target.checked ? setAsking(true) : save(false))}
        />
        {t("kubeconfig:sources.allow")}
      </label>
      <ConfirmDialog
        open={asking}
        title={t("kubeconfig:sources.warningTitle")}
        confirmLabel={t("kubeconfig:sources.confirm")}
        danger
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          save(true);
        }}
      >
        <p>{t("kubeconfig:sources.warning")}</p>
        <p className="settings__source-path">{source.path}</p>
        {target && target.realPath !== source.path && (
          <p className="settings__source-path">{t("kubeconfig:sources.target", { path: target.realPath })}</p>
        )}
        {target?.backupPattern && (
          <p className="settings__source-path">
            {t("kubeconfig:sources.backups", { path: target.backupPattern, max: target.backupsKept })}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

function CredentialDaysField() {
  const { t } = useTranslation();
  const { settings, update } = useSettings();
  const days = credentialDaysOf(settings);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) return;
    const next = clampCredentialDays(n);
    if (next !== days) {
      void update((s) => ({ ...s, kubeconfig: { ...s.kubeconfig, credentialExpiryDays: next } })).catch(() => undefined);
    }
  };
  return (
    <label className="kc-days" htmlFor={id}>
      {t("kubeconfig:expiry.days")}
      <input
        id={id}
        type="number"
        className="settings__input"
        min={MIN_CREDENTIAL_EXPIRY_DAYS}
        max={MAX_CREDENTIAL_EXPIRY_DAYS}
        step={1}
        disabled={!settings}
        value={draft ?? String(days)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </label>
  );
}

/** Below the list of sources: merging and the expiry warning. */
export function KubeconfigTools() {
  const { t } = useTranslation();
  return (
    <div className="kc-tools">
      <div className="settings__row">
        <MergeButton />
      </div>
      <CredentialDaysField />
      <p className="settings__hint">{t("kubeconfig:expiry.daysHint")}</p>
    </div>
  );
}
