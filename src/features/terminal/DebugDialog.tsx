import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { updateSettings, useSettings, type ClusterId, type ObjectRef } from "../../api";
import type { DebugSpec } from "../../api/generated/DebugSpec";
import { Button, Checkbox, Dialog, Radio } from "../../components";
import { openDebugTab } from "./tabs";

/** Images offered for a debug container (`debug::PRESET_IMAGES` in Rust). */
export const DEBUG_PRESETS = ["busybox:stable", "nicolaka/netshoot:latest"] as const;
/** Used when the setting is empty (`debug::DEFAULT_IMAGE`). */
export const DEFAULT_DEBUG_IMAGE = "busybox:stable";

export interface DebugDialogProps {
  clusterId: ClusterId;
  pod: ObjectRef;
  /** The pod's regular containers (targets). */
  containers: string[];
  /** The container chosen at first; none (`undefined`): the first one. */
  target?: string;
  close: () => void;
}

/**
 * Splits a command line into words: spaces separate them, single or double quotes keep spaces in one word. No shell
 * runs it, so nothing else is special.
 */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * Asks how to debug a pod (`kubectl debug`): the image (presets, or any), the container whose processes it sees, and
 * whether to debug the pod itself (an ephemeral container) or a copy of it (optionally with the container's command
 * replaced, for a pod that crashes). Opens the debug tab; nothing is created before "Start".
 */
export function DebugDialog({ clusterId, pod, containers, target, close }: DebugDialogProps) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const saved = settings?.debugImage.trim() || DEFAULT_DEBUG_IMAGE;
  const [edited, setEdited] = useState<string | null>(null);
  const image = edited ?? saved;
  const [chosen, setChosen] = useState<string>(target ?? containers[0] ?? "");
  const [mode, setMode] = useState<"ephemeral" | "copy">("ephemeral");
  const [command, setCommand] = useState("");
  const [remember, setRemember] = useState(false);
  const imageId = useId();
  const commandId = useId();
  const words = mode === "copy" ? splitCommand(command) : [];
  const invalid = image.trim() === "" || /\s/.test(image.trim()) || (words.length > 0 && chosen === "");

  const start = () => {
    if (invalid) return;
    const trimmed = image.trim();
    const spec: DebugSpec = {
      image: trimmed,
      target: chosen || null,
      copy: mode === "copy" ? { command: words } : null,
    };
    if (remember && trimmed !== saved) void updateSettings((s) => ({ ...s, debugImage: trimmed })).catch(() => undefined);
    openDebugTab(clusterId, pod, spec);
    close();
  };

  return (
    <Dialog
      open
      title={t("terminal:debug.title", { pod: pod.name })}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={invalid} onClick={start}>
            {t("terminal:debug.start")}
          </Button>
        </>
      }
    >
      <div className="terminal-form">
        <div className="terminal-form__field">
          <label htmlFor={imageId}>{t("terminal:debug.image")}</label>
          <input
            id={imageId}
            type="text"
            value={image}
            spellCheck={false}
            autoFocus
            onChange={(e) => setEdited(e.target.value)}
          />
          <div className="terminal-form__presets" role="group" aria-label={t("terminal:debug.presets")}>
            {DEBUG_PRESETS.map((preset) => (
              <Button key={preset} size="compact" aria-pressed={image.trim() === preset} onClick={() => setEdited(preset)}>
                {preset}
              </Button>
            ))}
          </div>
          <label className="terminal-form__option">
            <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            {t("terminal:debug.remember")}
          </label>
        </div>

        <div className="terminal-form__field" role="radiogroup" aria-label={t("terminal:debug.target")}>
          <span className="terminal-form__label">{t("terminal:debug.target")}</span>
          {containers.map((name) => (
            <label key={name} className="terminal-form__option">
              <Radio name="debug-target" checked={chosen === name} onChange={() => setChosen(name)} />
              <span className="terminal-form__mono">{name}</span>
            </label>
          ))}
          <label className="terminal-form__option">
            <Radio name="debug-target" checked={chosen === ""} onChange={() => setChosen("")} />
            {t("terminal:debug.noTarget")}
          </label>
          <span className="terminal-form__hint">{t("terminal:debug.targetHint")}</span>
        </div>

        <div className="terminal-form__field" role="radiogroup" aria-label={t("terminal:debug.mode")}>
          <span className="terminal-form__label">{t("terminal:debug.mode")}</span>
          <label className="terminal-form__option">
            <Radio name="debug-mode" checked={mode === "ephemeral"} onChange={() => setMode("ephemeral")} />
            {t("terminal:debug.ephemeral")}
          </label>
          <label className="terminal-form__option">
            <Radio name="debug-mode" checked={mode === "copy"} onChange={() => setMode("copy")} />
            {t("terminal:debug.copy")}
          </label>
          <span className="terminal-form__hint">
            {mode === "ephemeral"
              ? t("terminal:debug.ephemeralHint")
              : t("terminal:debug.copyHint", { namespace: pod.namespace ?? "", pod: pod.name })}
          </span>
        </div>

        {mode === "copy" && (
          <div className="terminal-form__field">
            <label htmlFor={commandId}>{t("terminal:debug.command")}</label>
            <input
              id={commandId}
              type="text"
              value={command}
              spellCheck={false}
              placeholder={t("terminal:debug.commandPlaceholder")}
              onChange={(e) => setCommand(e.target.value)}
            />
            <span className="terminal-form__hint">
              {words.length > 0 && chosen === ""
                ? t("terminal:debug.commandNeedsTarget")
                : t("terminal:debug.commandHint")}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
