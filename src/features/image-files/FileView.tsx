// One entry of the image: its type, size, mode, owner, time, link target and layer; a file's text (the first MiB) and
// its download; a symbolic link's target inside the image.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type ImageEntry } from "../../api";
import { Button, ErrorState, LoadingIndicator } from "../../components";
import { formatDateTime } from "../../i18n/format";
import { formatBytes } from "../metrics";
import { modeOctal, modeString } from "./format";
import { startDownload, useFileText, type DownloadStatus } from "./hooks";

export interface FileViewProps {
  sessionId: string;
  entry: ImageEntry | null;
  /** Shows another path of the image (a link's target). */
  onGoTo(path: string): void;
}

function readable(entry: ImageEntry): boolean {
  return entry.kind === "file" || entry.kind === "hardlink";
}

export function FileView({ sessionId, entry, onGoTo }: FileViewProps) {
  const { t } = useTranslation();
  const text = useFileText(sessionId, entry && readable(entry) ? entry.path : null);
  const [download, setDownload] = useState<DownloadStatus | null>(null);
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => {
    setDownload(null);
    setTarget(undefined);
    if (entry?.kind === "symlink") {
      api.imageFiles.resolve(sessionId, entry.path).then(setTarget, () => setTarget(null));
    }
    return () => {
      cancel.current?.();
      cancel.current = null;
    };
  }, [sessionId, entry]);

  if (!entry) return <p className="imgf-note imgf-view__empty">{t("imagefiles:file.none")}</p>;

  const owner = [entry.user ?? String(entry.uid), entry.group ?? String(entry.gid)].join(":");
  const rows: Array<[string, string]> = [
    [t("imagefiles:file.path"), entry.path],
    [t("imagefiles:file.kind"), t(`imagefiles:kind.${entry.kind}`)],
    [t("imagefiles:file.size"), formatBytes(entry.size)],
    [t("imagefiles:file.mode"), `${modeString(entry.kind, entry.mode)} (${modeOctal(entry.mode)})`],
    [t("imagefiles:file.owner"), owner],
    [t("imagefiles:file.modified"), entry.mtime > 0 ? formatDateTime(entry.mtime * 1000) : "—"],
    [t("imagefiles:file.layer"), t("imagefiles:file.layerNumber", { index: entry.layer + 1 })],
  ];
  if (entry.link !== null) rows.splice(2, 0, [t("imagefiles:file.target"), entry.link]);

  const onDownload = () => {
    cancel.current?.();
    setDownload({ status: "running", done: 0, total: 0 });
    cancel.current = startDownload(sessionId, entry.path, t("imagefiles:file.saveTitle"), setDownload);
  };

  return (
    <div className="imgf-view">
      <h3 className="imgf-view__title">{entry.name || "/"}</h3>
      <dl className="imgf-view__facts">
        {rows.map(([label, value]) => (
          <div key={label} className="imgf-view__fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {entry.kind === "symlink" && target !== undefined && (
        <div className="imgf-view__actions">
          {target === null ? (
            <p className="imgf-note">{t("imagefiles:file.targetOutside")}</p>
          ) : (
            <Button icon="imageSymlink" onClick={() => onGoTo(target)}>
              {t("imagefiles:file.goToTarget")}
            </Button>
          )}
        </div>
      )}
      {readable(entry) && (
        <div className="imgf-view__actions">
          <Button icon="download" disabled={download?.status === "running"} onClick={onDownload}>
            {t("imagefiles:file.download")}
          </Button>
          {download?.status === "running" && (
            <span className="imgf-note" role="status">
              {t("imagefiles:file.downloading", { done: formatBytes(download.done), total: formatBytes(download.total) })}
            </span>
          )}
          {download?.status === "done" && (
            <span className="imgf-note" role="status">
              {t("imagefiles:file.downloaded")}
            </span>
          )}
        </div>
      )}
      {download?.status === "error" && <ErrorState className="imgf-error" error={download.error} />}
      {text?.status === "reading" && (
        <LoadingIndicator
          className="imgf-loading"
          text={t("imagefiles:file.reading", { done: formatBytes(text.done), total: formatBytes(text.total) })}
        />
      )}
      {text?.status === "error" && <ErrorState className="imgf-error" error={text.error} />}
      {text?.status === "done" &&
        (text.file.binary ? (
          <p className="imgf-note">{t("imagefiles:file.binary")}</p>
        ) : (
          <>
            {text.file.truncated && <p className="imgf-note">{t("imagefiles:file.truncated")}</p>}
            <pre className="imgf-view__text" tabIndex={0} aria-label={t("imagefiles:file.text", { name: entry.name })}>
              {text.file.text}
            </pre>
          </>
        ))}
    </div>
  );
}
