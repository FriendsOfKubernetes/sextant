// The period of a Loki read: the last hour, 6 hours, 24 hours, or a custom period of at most 24 hours.
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { LokiRange } from "../../../api";
import { fromLocalInput, presetRange, RANGE_PRESETS, rangeProblem, toLocalInput, type RangePreset } from "./model";

export interface RangeChoice {
  preset: RangePreset;
  /** The custom period (only with `custom`). */
  custom: { from: string; to: string };
}

const HOUR_MS = 3_600_000;

export function initialChoice(nowMs: number = Date.now()): RangeChoice {
  return { preset: "1h", custom: { from: toLocalInput(nowMs - HOUR_MS), to: toLocalInput(nowMs) } };
}

/**
 * The range of a choice; a preset ends at `endMs`. `problem` says why a custom period cannot be read.
 */
export function rangeOf(choice: RangeChoice, endMs: number, nowMs: number = Date.now()): { range: LokiRange | null; problem: ReturnType<typeof rangeProblem> } {
  if (choice.preset !== "custom") return { range: presetRange(choice.preset, endMs), problem: null };
  const range = { startMs: fromLocalInput(choice.custom.from), endMs: fromLocalInput(choice.custom.to) };
  const problem = rangeProblem(range, nowMs);
  return { range: problem ? null : range, problem };
}

export function RangePicker({
  choice,
  onChange,
  presets = RANGE_PRESETS,
}: {
  choice: RangeChoice;
  onChange: (choice: RangeChoice) => void;
  presets?: readonly RangePreset[];
}) {
  const { t } = useTranslation();
  const id = useId();
  const problem = choice.preset === "custom" ? rangeOf(choice, Date.now()).problem : null;
  return (
    <span className="loki-range">
      <label className="logs__field">
        <span>{t("loki:range.label")}</span>
        <select
          aria-label={t("loki:range.label")}
          value={choice.preset}
          onChange={(e) => onChange({ ...choice, preset: e.target.value as RangePreset })}
        >
          {presets.map((p) => (
            <option key={p} value={p}>
              {t(`loki:range.${p}`)}
            </option>
          ))}
        </select>
      </label>
      {choice.preset === "custom" && (
        <>
          <label className="logs__field">
            <span>{t("loki:range.from")}</span>
            <input
              type="datetime-local"
              value={choice.custom.from}
              aria-describedby={problem ? `${id}-problem` : undefined}
              onChange={(e) => onChange({ ...choice, custom: { ...choice.custom, from: e.target.value } })}
            />
          </label>
          <label className="logs__field">
            <span>{t("loki:range.to")}</span>
            <input
              type="datetime-local"
              value={choice.custom.to}
              aria-describedby={problem ? `${id}-problem` : undefined}
              onChange={(e) => onChange({ ...choice, custom: { ...choice.custom, to: e.target.value } })}
            />
          </label>
          {problem && (
            <span id={`${id}-problem`} className="loki-range__problem" role="alert">
              {t(`loki:range.problem.${problem}`)}
            </span>
          )}
        </>
      )}
    </span>
  );
}
