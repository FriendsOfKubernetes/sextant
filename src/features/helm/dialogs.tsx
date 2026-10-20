// Dialogs of the Helm pages. Nothing reaches `helm` before the user presses the confirm button; uninstall and
// rollback also need the release name typed in. A failure keeps the dialog open with Helm's own text (stderr).
// Upgrade and install offer "Preview changes" (#141): the release's manifest against the one Helm renders with
// `--dry-run=server`; on a cluster that asks for a preview, confirming needs a preview of the current input.
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ClusterId, type HelmRelease, type HelmRepo } from "../../api";
import { ConfirmAction } from "../actions";
import { YamlEditor } from "../editor";
import { HelmPreview, useAlwaysPreview, useHelmPreview } from "../safe-apply";

/** Release names Helm accepts. */
export const RELEASE_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export function isValidReleaseName(name: string): boolean {
  return name.length <= 53 && RELEASE_NAME.test(name);
}

/** "Type the release name to confirm" field; reports whether the typed text matches. */
function ConfirmName({ name, onMatch }: { name: string; onMatch: (ok: boolean) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const [typed, setTyped] = useState("");
  return (
    <div className="action-dialog__field">
      <label htmlFor={id}>{t("helm:confirmName.label", { name })}</label>
      <input
        id={id}
        value={typed}
        autoFocus
        spellCheck={false}
        onChange={(e) => {
          setTyped(e.target.value);
          onMatch(e.target.value === name);
        }}
      />
      {typed !== "" && typed !== name && <span className="action-dialog__hint">{t("helm:confirmName.mismatch")}</span>}
    </div>
  );
}

export function UninstallDialog({
  clusterId,
  release,
  close,
  onDone,
}: {
  clusterId: ClusterId;
  release: HelmRelease;
  close: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [match, setMatch] = useState(false);
  return (
    <ConfirmAction
      title={t("helm:uninstall.title", { name: release.name })}
      confirmLabel={t("helm:uninstall.confirm")}
      danger
      close={close}
      canConfirm={match}
      errorTitle={() => t("helm:uninstall.failed")}
      onConfirm={async () => {
        await api.helm.uninstall(clusterId, release.namespace, release.name);
        onDone();
      }}
    >
      <p>{t("helm:uninstall.text", { name: release.name, namespace: release.namespace })}</p>
      <ConfirmName name={release.name} onMatch={setMatch} />
    </ConfirmAction>
  );
}

export function RollbackDialog({
  clusterId,
  release,
  revision,
  close,
  onDone,
}: {
  clusterId: ClusterId;
  release: HelmRelease;
  revision: number;
  close: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [match, setMatch] = useState(false);
  return (
    <ConfirmAction
      title={t("helm:rollback.title", { name: release.name })}
      confirmLabel={t("helm:rollback.confirm")}
      danger
      close={close}
      canConfirm={match}
      errorTitle={() => t("helm:rollback.failed")}
      onConfirm={async () => {
        await api.helm.rollback(clusterId, release.namespace, release.name, revision);
        onDone();
      }}
    >
      <p>{t("helm:rollback.text", { name: release.name, revision })}</p>
      <ConfirmName name={release.name} onMatch={setMatch} />
    </ConfirmAction>
  );
}

/** `repo/chart` of an added repository that has the release's chart, or "" (the backend then reuses the stored chart). */
async function findChartRef(chart: string): Promise<string> {
  try {
    const hits = await api.helm.search(chart);
    return hits.find((h) => h.name.endsWith(`/${chart}`))?.name ?? "";
  } catch {
    return "";
  }
}

export function UpgradeDialog({
  clusterId,
  release,
  values,
  target = null,
  close,
  onDone,
}: {
  clusterId: ClusterId;
  release: HelmRelease;
  /** The release's current user values. */
  values: string;
  /** A newer chart picked in the release list (#209): its reference and version are filled in. */
  target?: { chartRef: string; version: string } | null;
  close: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const refId = useId();
  const versionId = useId();
  const [text, setText] = useState(values);
  const [chartRef, setChartRef] = useState(target?.chartRef ?? "");
  const [version, setVersion] = useState(target?.version ?? "");
  const refTouched = useRef(target !== null);
  const required = useAlwaysPreview(clusterId);
  // Without a picked version the release keeps its chart version (the backend pins it).
  const pinned = target ? version.trim() || null : null;
  const preview = useHelmPreview(JSON.stringify([text, chartRef.trim(), pinned]), (previewId) =>
    api.helm.upgradePreview(clusterId, release.namespace, release.name, chartRef.trim(), text, previewId, pinned),
  );

  // Suggest the repository reference once; what the user typed (or picked in the list) wins.
  useEffect(() => {
    if (refTouched.current) return;
    let alive = true;
    void findChartRef(release.chart).then((found) => {
      if (alive && !refTouched.current) setChartRef(found);
    });
    return () => {
      alive = false;
    };
  }, [release.chart]);

  return (
    <ConfirmAction
      title={
        target
          ? t("helm:upgrade.titleVersion", { name: release.name, chart: release.chart, version: target.version })
          : t("helm:upgrade.title", { name: release.name })
      }
      confirmLabel={t("helm:upgrade.confirm")}
      close={close}
      errorTitle={() => t("helm:upgrade.failed")}
      canConfirm={(!required || preview.diff !== null) && (!target || (pinned !== null && chartRef.trim() !== ""))}
      onConfirm={async () => {
        await api.helm.upgrade(clusterId, release.namespace, release.name, chartRef.trim(), text, pinned);
        onDone();
        return t("helm:upgrade.done", { name: release.name });
      }}
    >
      <div className="helm-dialog__editor">
        <YamlEditor value={text} onChange={setText} label={t("helm:upgrade.valuesLabel", { name: release.name })} />
      </div>
      <div className="action-dialog__field">
        <label htmlFor={refId}>{t("helm:upgrade.chartRef")}</label>
        <input
          id={refId}
          value={chartRef}
          spellCheck={false}
          onChange={(e) => {
            refTouched.current = true;
            setChartRef(e.target.value);
          }}
        />
        <span className="action-dialog__hint">
          {target
            ? t("helm:upgrade.chartRefVersionHint", { chart: release.chart })
            : t("helm:upgrade.chartRefHint", { chart: release.chart, version: release.chartVersion })}
        </span>
      </div>
      {target && (
        <div className="action-dialog__field">
          <label htmlFor={versionId}>{t("helm:upgrade.version")}</label>
          <input id={versionId} value={version} spellCheck={false} onChange={(e) => setVersion(e.target.value)} />
          <span className="action-dialog__hint">
            {t("helm:upgrade.versionHint", { chart: release.chart, version: release.chartVersion })}
          </span>
        </div>
      )}
      <HelmPreview release={release.name} preview={preview} required={required} />
    </ConfirmAction>
  );
}

export function RemoveRepoDialog({ repo, close, onDone }: { repo: HelmRepo; close: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  return (
    <ConfirmAction
      title={t("helm:charts.removeTitle", { name: repo.name })}
      confirmLabel={t("helm:charts.remove")}
      danger
      close={close}
      onConfirm={async () => {
        await api.helm.repoRemove(repo.name);
        onDone();
      }}
    >
      <p>{t("helm:charts.removeText", { name: repo.name, url: repo.url })}</p>
    </ConfirmAction>
  );
}

export function InstallDialog({
  clusterId,
  chart,
  version,
  defaultValues,
  defaultNamespace,
  close,
}: {
  clusterId: ClusterId;
  /** `repo/chart` */
  chart: string;
  version: string;
  defaultValues: string;
  defaultNamespace: string;
  close: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const nsId = useId();
  const short = chart.split("/").pop() ?? chart;
  const [release, setRelease] = useState(isValidReleaseName(short) ? short : "");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [values, setValues] = useState(defaultValues);
  const nameOk = isValidReleaseName(release);
  const nsOk = namespace.trim() !== "";
  const required = useAlwaysPreview(clusterId);
  const preview = useHelmPreview(JSON.stringify([release, namespace.trim(), values]), (previewId) =>
    api.helm.installPreview(clusterId, namespace.trim(), release, chart, version || null, values, previewId),
  );

  return (
    <ConfirmAction
      title={t("helm:install.title", { chart, version })}
      confirmLabel={t("helm:install.confirm")}
      close={close}
      canConfirm={nameOk && nsOk && (!required || preview.diff !== null)}
      errorTitle={() => t("helm:install.failed")}
      onConfirm={async () => {
        const ns = namespace.trim();
        await api.helm.install(clusterId, ns, release, chart, version || null, values);
        return t("helm:install.done", { release, namespace: ns });
      }}
    >
      <div className="action-dialog__field">
        <label htmlFor={nameId}>{t("helm:install.release")}</label>
        <input id={nameId} value={release} spellCheck={false} autoFocus onChange={(e) => setRelease(e.target.value.trim())} />
        {!nameOk && release !== "" && <span className="action-dialog__hint">{t("helm:install.invalidName")}</span>}
      </div>
      <div className="action-dialog__field">
        <label htmlFor={nsId}>{t("helm:install.namespace")}</label>
        <input id={nsId} value={namespace} spellCheck={false} onChange={(e) => setNamespace(e.target.value)} />
      </div>
      <div className="helm-dialog__editor">
        <YamlEditor value={values} onChange={setValues} label={t("helm:install.valuesLabel", { chart })} />
      </div>
      <span className="action-dialog__hint">{t("helm:install.valuesHint")}</span>
      <HelmPreview release={release} preview={preview} required={required} canRun={nameOk && nsOk} />
    </ConfirmAction>
  );
}
