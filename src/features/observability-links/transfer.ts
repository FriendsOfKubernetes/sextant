// A cluster's dashboard and trace links in an export of views (#149, #266): written only when the user ticks "Include
// dashboard and trace links", read strictly — an unknown field, a base URL or a template that fails its check is a
// problem of the import, named by its path, never a link that is kept.
import type { ObservabilityLinks } from "../../api/generated/ObservabilityLinks";
import { checkBaseUrl, checkTemplate, DASHBOARD_TARGETS, MAX_LINK_CHARS } from "./template";

const FIELDS = ["grafanaUrl", "dashboards", "tracesUrl", "traces"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The links of an import file at `path`, and the problems found. */
export function readObservabilityLinks(value: unknown, path: string): { links: ObservabilityLinks | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(value)) return { links: null, problems: [`${path}: not an object`] };
  for (const key of Object.keys(value)) if (!FIELDS.includes(key)) problems.push(`${path}.${key}: unknown field`);
  for (const key of FIELDS) if (!(key in value)) problems.push(`${path}.${key}: missing`);
  const base = (key: "grafanaUrl" | "tracesUrl"): string | null => {
    const text = value[key];
    if (text === null || text === undefined) return null;
    if (typeof text !== "string") {
      problems.push(`${path}.${key}: not a string`);
      return null;
    }
    const checked = checkBaseUrl(text);
    if ("error" in checked) {
      problems.push(`${path}.${key}: not an accepted URL (${checked.error})`);
      return null;
    }
    return checked.url;
  };
  const grafanaUrl = base("grafanaUrl");
  const tracesUrl = base("tracesUrl");
  const template = (text: unknown, at: string, target: Parameters<typeof checkTemplate>[2], against: string | null) => {
    if (typeof text !== "string" || [...text].length > MAX_LINK_CHARS) {
      problems.push(`${at}: not a string of at most ${MAX_LINK_CHARS} characters`);
      return null;
    }
    const error = checkTemplate(against, text, target);
    if (error) problems.push(`${at}: not an accepted template (${error})`);
    return error ? null : text.trim();
  };
  const dashboards: Record<string, string> = {};
  if (!isObject(value.dashboards)) problems.push(`${path}.dashboards: not an object`);
  else {
    for (const [key, text] of Object.entries(value.dashboards)) {
      const target = DASHBOARD_TARGETS.find((t) => t === key);
      if (!target) {
        problems.push(`${path}.dashboards.${key}: unknown field`);
        continue;
      }
      const kept = template(text, `${path}.dashboards.${key}`, target, grafanaUrl);
      if (kept) dashboards[target] = kept;
    }
  }
  const traces =
    value.traces === null || value.traces === undefined
      ? null
      : template(value.traces, `${path}.traces`, "traces", tracesUrl ?? grafanaUrl);
  if (problems.length > 0) return { links: null, problems };
  return { links: { grafanaUrl, dashboards, tracesUrl, traces }, problems };
}
