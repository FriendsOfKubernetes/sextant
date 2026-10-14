// What the views share: the Widget kind of the test cluster (scripts/fixtures/40-crd.yaml) and the scale settings
// kept in the extension's storage.
import type { KubeObject, ObjectRef, Sextant } from "@sextant/extension-sdk";

export const WIDGET = { group: "demo.sextant.dev", kind: "Widget" };

export type Widget = KubeObject<{ size?: string; replicas?: number }>;

export interface ScaleSettings {
  /** What − and + change the replicas by. */
  step: number;
  /** The most replicas the action lets you ask for. */
  maxReplicas: number;
}

export const DEFAULT_SETTINGS: ScaleSettings = { step: 1, maxReplicas: 10 };
export const SETTINGS_KEY = "scale";

const isCount = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= 1000;

/** The settings in storage, or the defaults for what is missing or malformed. */
export async function readSettings(sextant: Sextant): Promise<ScaleSettings> {
  const stored = await sextant.storage.get(SETTINGS_KEY).catch(() => null);
  const value = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  return {
    step: isCount(value.step, 1) ? value.step : DEFAULT_SETTINGS.step,
    maxReplicas: isCount(value.maxReplicas, 1) ? value.maxReplicas : DEFAULT_SETTINGS.maxReplicas,
  };
}

/** A whole number from `min` to `max` typed in a field, else `null`. */
export function parseCount(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : null;
}

/** The widget the frame is about (the details panel's object, the action's selection). */
export function selectedWidget(sextant: Sextant): ObjectRef | null {
  return sextant.context.selection[0] ?? null;
}

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
