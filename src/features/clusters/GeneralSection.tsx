// "General" cluster settings: display name, icon and color label in the rail (where the context comes from is in
// ConnectionSection, the "Connection" tab).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, useSettings, type ApiError, type AppSettings, type ClusterInfo } from "../../api";
import { Button } from "../../components";
import { SourceError } from "./AddClusterDialog";
import { ClusterAvatar } from "./ClusterAvatar";
import {
  CLUSTER_COLORS,
  clusterSettingsOf,
  normalizeIconText,
  updateClusterSettings,
  type ClusterIcon,
} from "./clusterSettings";
import { useClustersStore } from "./clustersStore";
import { ICON_IMAGE_ACCEPT, IconImageError, readIconImage, type IconImageErrorCode } from "./iconImage";
import type { ClusterSettingsSectionProps } from "./settingsRegistry";

export function GeneralSection({ clusterId, cluster }: ClusterSettingsSectionProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const current = clusterSettingsOf(settings, clusterId);
  const [name, setName] = useState(current.displayName ?? "");
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => setName(current.displayName ?? ""), [current.displayName]);

  const save = async (patch: Parameters<typeof updateClusterSettings>[1]) => {
    try {
      await updateClusterSettings(clusterId, patch);
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  };
  const saveName = () => {
    const next = name.trim() || null;
    if (next !== (current.displayName ?? null)) void save({ displayName: next });
  };

  return (
    <div className="cluster-settings__general">
      <label className="clusters-field">
        <span>{t("clusters:settings.displayName")}</span>
        <input
          type="text"
          value={name}
          placeholder={cluster.context}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => e.key === "Enter" && saveName()}
        />
      </label>
      <IconField clusterId={clusterId} cluster={cluster} settings={settings} save={save} />
      <div className="clusters-field">
        <span id={`color-${clusterId}`}>{t("clusters:settings.color")}</span>
        <div className="clusters-colors" role="radiogroup" aria-labelledby={`color-${clusterId}`}>
          <Button
            size="compact"
            role="radio"
            aria-checked={current.color === null}
            className="clusters-colors__none"
            onClick={() => void save({ color: null })}
          >
            {t("clusters:settings.autoColor")}
          </Button>
          {CLUSTER_COLORS.map((color, index) => (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={current.color === color}
              aria-label={t("clusters:settings.colorOption", { index: index + 1 })}
              className="clusters-colors__swatch"
              style={{ background: color }}
              onClick={() => void save({ color })}
            />
          ))}
        </div>
      </div>
      {error && <SourceError error={error} />}
    </div>
  );
}

/**
 * The rail icon: one or two letters or an emoji (saved on blur or Enter; empty — the initials), a picture from disk
 * (fitted into a 96×96 PNG) or, with "Reset icon", the automatic initials again. The preview follows the text being
 * typed. A refused file leaves the icon as it was.
 */
function IconField({
  clusterId,
  cluster,
  settings,
  save,
}: {
  clusterId: string;
  cluster: ClusterInfo;
  settings: AppSettings | null;
  save: (patch: { icon: ClusterIcon | null }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const icon = clusterSettingsOf(settings, clusterId).icon;
  const savedText = icon?.type === "text" ? icon.text : "";
  const [text, setText] = useState(savedText);
  const [fileError, setFileError] = useState<IconImageErrorCode | null>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusIcon = useClustersStore((s) => s.settingsFocus === "icon");

  useEffect(() => setText(savedText), [savedText]);
  useEffect(() => {
    if (focusIcon) textRef.current?.focus();
  }, [focusIcon]);

  const draft: ClusterIcon | null = text ? { type: "text", text } : icon?.type === "image" ? icon : null;
  const preview: AppSettings | null = settings && {
    ...settings,
    clusters: { ...settings.clusters, [clusterId]: { ...clusterSettingsOf(settings, clusterId), icon: draft } },
  };

  const saveText = () => {
    const next = normalizeIconText(text);
    if (next === savedText) return;
    // An empty field removes the text; a picture stays until "Reset icon" or another picture.
    if (!next && icon?.type !== "text") return;
    setFileError(null);
    void save({ icon: next ? { type: "text", text: next } : null });
  };
  const chooseFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const dataUrl = await readIconImage(file);
      setFileError(null);
      setText("");
      await save({ icon: { type: "image", dataUrl } });
    } catch (err) {
      setFileError(err instanceof IconImageError ? err.code : "read");
    }
  };
  const reset = () => {
    setText("");
    setFileError(null);
    void save({ icon: null });
  };

  return (
    <div className="clusters-field">
      <span id={`icon-${clusterId}`}>{t("clusters:settings.icon")}</span>
      <div className="clusters-icon" role="group" aria-labelledby={`icon-${clusterId}`}>
        <span className="clusters-icon__preview" role="img" aria-label={t("clusters:settings.iconPreview")}>
          <ClusterAvatar cluster={cluster} settings={preview} size={48} />
        </span>
        <div className="clusters-icon__controls">
          <label className="clusters-icon__text">
            <span>{t("clusters:settings.iconText")}</span>
            <input
              ref={textRef}
              type="text"
              value={text}
              placeholder={t("clusters:settings.iconTextPlaceholder")}
              onChange={(e) => setText(normalizeIconText(e.target.value))}
              onBlur={saveText}
              onKeyDown={(e) => e.key === "Enter" && saveText()}
            />
          </label>
          <div className="clusters-icon__buttons">
            <Button icon="image" onClick={() => fileRef.current?.click()}>
              {t("clusters:settings.iconChoose")}
            </Button>
            <Button icon="reset" disabled={icon === null && !text} onClick={reset}>
              {t("clusters:settings.iconReset")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept={ICON_IMAGE_ACCEPT}
              hidden
              tabIndex={-1}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // The same file can be chosen again after a refusal.
                e.target.value = "";
                void chooseFile(file);
              }}
            />
          </div>
        </div>
      </div>
      <p className="clusters-icon__hint">{t("clusters:settings.iconHint")}</p>
      {fileError && (
        <p className="clusters-icon__error" role="alert">
          {t(`clusters:settings.iconErrors.${fileError}`)}
        </p>
      )}
    </div>
  );
}
