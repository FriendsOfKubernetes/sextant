// The "Image files" page (Workloads section, #216): an image reference (typed, or a pod's container from its details),
// the image opened from its registry, then its files (a lazy tree, search by path, a file's facts, text and download)
// and its layers.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { api, updateSettings, useSettings, type ImageEntry, type ImagePlatform, type ImageSummary } from "../../api";
import { Button, Checkbox, ErrorState, LoadingIndicator, Tabs } from "../../components";
import { formatList } from "../../i18n/format";
import type { PageProps } from "../../layout/pages";
import { formatBytes } from "../metrics";
import { FileTree } from "./FileTree";
import { FileView } from "./FileView";
import { parentFolders } from "./format";
import { useOpenImage, type OpenStatus } from "./hooks";
import { LayersTable } from "./LayersTable";
import { SearchPanel } from "./SearchPanel";
import { closeSource, openSource, useImageFilesState, useImageFilesStore } from "./state";

const TABS = ["files", "layers"] as const;

function platformLabel(p: ImagePlatform): string {
  return [p.os, p.architecture, p.variant].filter(Boolean).join("/");
}

function Progress({ state, onStop }: { state: Extract<OpenStatus, { status: "opening" }>; onStop(): void }) {
  const { t } = useTranslation();
  const event = state.progress;
  let text = t("imagefiles:progress.resolving");
  if (event?.type === "layer") {
    const args = { index: event.index + 1, count: event.layers };
    if (event.state === "cached") text = t("imagefiles:progress.cached", args);
    else if (event.state === "indexed") text = t("imagefiles:progress.indexed", args);
    else text = t("imagefiles:progress.downloading", { ...args, done: formatBytes(event.bytes), total: formatBytes(event.total) });
  }
  return (
    <div className="imgf-progress">
      <LoadingIndicator className="imgf-loading" text={text} />
      <Button onClick={onStop}>{t("imagefiles:progress.stop")}</Button>
    </div>
  );
}

function Summary({ summary }: { summary: ImageSummary }) {
  const { t } = useTranslation();
  const credentials =
    summary.credentials.type === "pullSecret"
      ? t("imagefiles:summary.pullSecret", { name: summary.credentials.name })
      : summary.credentials.type === "dockerConfig"
        ? t("imagefiles:summary.dockerConfig")
        : t("imagefiles:summary.anonymous");
  return (
    <section className="imgf-summary" aria-label={t("imagefiles:summary.label")}>
      <p className="imgf-summary__reference">{summary.reference}</p>
      <dl className="imgf-view__facts">
        <div className="imgf-view__fact">
          <dt>{t("imagefiles:summary.digest")}</dt>
          <dd className="imgf-mono">{summary.digest}</dd>
        </div>
        <div className="imgf-view__fact">
          <dt>{t("imagefiles:summary.platform")}</dt>
          <dd>{platformLabel(summary.platform)}</dd>
        </div>
        <div className="imgf-view__fact">
          <dt>{t("imagefiles:summary.credentials")}</dt>
          <dd>{credentials}</dd>
        </div>
      </dl>
      <p className="imgf-note">{t("imagefiles:summary.files", { count: summary.files })}</p>
      {summary.skipped > 0 && <p className="imgf-note imgf-note--warning">{t("imagefiles:summary.skipped", { count: summary.skipped })}</p>}
      {summary.unreadableSecrets.length > 0 && (
        <p className="imgf-note imgf-note--warning">
          {t("imagefiles:summary.unreadableSecrets", { names: formatList(summary.unreadableSecrets) })}
        </p>
      )}
    </section>
  );
}

function OpenImage({ summary }: { summary: ImageSummary }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0]);
  const [selected, setSelected] = useState<ImageEntry | null>(null);
  const [reveal, setReveal] = useState<readonly string[]>([]);
  const show = (entry: ImageEntry) => {
    setSelected(entry);
    setReveal(parentFolders(entry.path));
  };
  const goTo = (path: string) => {
    api.imageFiles.list(summary.sessionId, parentFolders(path).at(-1) ?? "/").then(
      (dir) => {
        const found = dir.entries.find((e) => e.path === path);
        if (found) show(found);
      },
      () => undefined,
    );
  };
  return (
    <Tabs
      label={t("imagefiles:tabs.label")}
      selected={tab}
      onSelect={setTab}
      tabs={TABS.map((id) => ({ id, label: t(`imagefiles:tabs.${id}`) }))}
    >
      {tab === "files" ? (
        <div className="imgf-files">
          <div className="imgf-files__side">
            <SearchPanel sessionId={summary.sessionId} onSelect={show} />
            <FileTree sessionId={summary.sessionId} selected={selected?.path ?? null} reveal={reveal} onSelect={setSelected} />
          </div>
          <div className="imgf-files__main">
            <FileView sessionId={summary.sessionId} entry={selected} onGoTo={goTo} />
          </div>
        </div>
      ) : (
        <LayersTable layers={summary.layers} />
      )}
    </Tabs>
  );
}

export function ImageFilesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const state = useImageFilesState(clusterId);
  const { settings } = useSettings();
  const [platform, setPlatform] = useState<ImagePlatform | null>(null);
  const openKey = state.open ? `${state.open.key}:${platform ? platformLabel(platform) : ""}` : "";
  const opened = useOpenImage(state.open?.source ?? null, platform, openKey);
  useEffect(() => setPlatform(null), [state.open?.key]);
  const dockerCredentials = settings?.imageFiles.dockerCredentials ?? false;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const reference = state.reference.trim();
    if (reference) openSource(clusterId, { type: "reference", reference });
  };
  const platforms = useMemo(() => (opened?.status === "open" ? opened.summary.platforms : []), [opened]);

  return (
    <div className="imgf-page">
      <h2 className="imgf-page__title">{t("imagefiles:title")}</h2>
      <p className="imgf-note">{t("imagefiles:intro")}</p>
      <form className="imgf-toolbar" onSubmit={submit}>
        <label className="imgf-field">
          <span>{t("imagefiles:form.reference")}</span>
          <input
            className="imgf-input"
            value={state.reference}
            placeholder={t("imagefiles:form.placeholder")}
            spellCheck={false}
            onChange={(e) => useImageFilesStore.getState().patch(clusterId, { reference: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" disabled={!state.reference.trim()}>
          {t("imagefiles:form.open")}
        </Button>
        {state.open && <Button onClick={() => closeSource(clusterId)}>{t("imagefiles:form.close")}</Button>}
      </form>
      {state.pod && (
        <div className="imgf-toolbar">
          <span className="imgf-note">
            {t("imagefiles:form.podSource", { container: state.pod.container, namespace: state.pod.namespace, pod: state.pod.pod })}
          </span>
          <Button onClick={() => state.pod && openSource(clusterId, state.pod)}>{t("imagefiles:form.openPod")}</Button>
        </div>
      )}
      <label className="imgf-check">
        <Checkbox
          checked={dockerCredentials}
          onChange={(e) => {
            const on = e.target.checked;
            void updateSettings((s) => ({ ...s, imageFiles: { ...s.imageFiles, dockerCredentials: on } }));
          }}
        />
        <span>{t("imagefiles:form.dockerCredentials")}</span>
      </label>
      <p className="imgf-note imgf-note--small">{t("imagefiles:form.dockerCredentialsHint")}</p>
      {platforms.length > 1 && opened?.status === "open" && (
        <label className="imgf-field">
          <span>{t("imagefiles:form.platform")}</span>
          <select
            className="imgf-select"
            value={platformLabel(opened.summary.platform)}
            onChange={(e) => setPlatform(platforms.find((p) => platformLabel(p) === e.target.value) ?? null)}
          >
            {platforms.map((p) => (
              <option key={platformLabel(p)} value={platformLabel(p)}>
                {platformLabel(p)}
              </option>
            ))}
          </select>
        </label>
      )}
      {opened?.status === "opening" && <Progress state={opened} onStop={() => closeSource(clusterId)} />}
      {opened?.status === "error" && <ErrorState className="imgf-error" error={opened.error} />}
      {opened?.status === "open" && (
        <>
          <Summary summary={opened.summary} />
          <OpenImage key={opened.summary.sessionId} summary={opened.summary} />
        </>
      )}
    </div>
  );
}
