// URL templates of links to Grafana dashboards and traces (#266, ADR-0117). A template is a path under the base URL
// (`/d/<uid>?var-pod={pod}`) or an absolute URL of the base URL's origin, with `{variable}` placeholders from a fixed
// list. A literal brace is written `%7B`/`%7D`, so every `{…}` is a placeholder and an unknown one is an error. Values
// are URL-encoded when they are put in, and a value outside the characters Kubernetes names and times use gives no
// link at all. The finished URL is checked again: it must keep the base URL's origin, so a template can never lead to
// another site, a `javascript:` or `data:` URL, or a URL with credentials. Sextant never requests these URLs; they
// are opened in the system browser on a click.

/** Every variable a template may name. */
export const VARIABLES = [
  "namespace",
  "name",
  "kind",
  "pod",
  "container",
  "node",
  "service",
  "from",
  "to",
  "source",
  "destination",
] as const;
export type Variable = (typeof VARIABLES)[number];

/** What a template is for: a dashboard of an object kind or of a traffic edge, or traces. */
export type Target = "workload" | "pod" | "node" | "namespace" | "edge" | "traces";
export const DASHBOARD_TARGETS = ["workload", "pod", "node", "namespace", "edge"] as const;
export type DashboardTarget = (typeof DASHBOARD_TARGETS)[number];

/** The variables each target fills (a template naming another one could never be filled, so it is refused). */
export const TARGET_VARIABLES: Record<Target, readonly Variable[]> = {
  workload: ["namespace", "name", "kind", "service", "from", "to"],
  pod: ["namespace", "name", "kind", "pod", "container", "node", "service", "from", "to"],
  node: ["name", "kind", "node", "from", "to"],
  namespace: ["name", "kind", "namespace", "from", "to"],
  edge: ["namespace", "source", "destination", "service", "from", "to"],
  traces: ["namespace", "name", "service", "from", "to"],
};

/** Longest base URL or template, in characters (`MAX_LINK_CHARS` of the settings). */
export const MAX_LINK_CHARS = 2048;

export type Values = Partial<Record<Variable, string>>;

export type BaseUrlError = "empty" | "tooLong" | "invalid" | "scheme" | "credentials" | "query";
export type TemplateError = "empty" | "tooLong" | "invalid" | "brace" | "variable" | "origin" | "noBase";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Characters a value may have: Kubernetes names, label values and decimal times. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

function hasBadChars(text: string): boolean {
  // White space, control characters and a backslash (which the URL parser reads as a slash).
  return /[\s\p{Cc}\\]/u.test(text);
}

function parse(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Checks a base URL: https, or plain http to a loopback host (a port forward to Grafana); no user name or password,
 * no query or fragment. The normalized URL has no trailing slash.
 */
export function checkBaseUrl(text: string): { url: string } | { error: BaseUrlError } {
  const trimmed = text.trim();
  if (!trimmed) return { error: "empty" };
  if ([...trimmed].length > MAX_LINK_CHARS) return { error: "tooLong" };
  if (hasBadChars(trimmed)) return { error: "invalid" };
  const url = parse(trimmed);
  if (!url || !url.host) return { error: "invalid" };
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return { error: "scheme" };
  }
  if (url.username || url.password || /^[a-z]+:\/\/[^/]*@/i.test(trimmed)) return { error: "credentials" };
  if (url.search || url.hash || trimmed.includes("?") || trimmed.includes("#")) return { error: "query" };
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}` };
}

/** The placeholders of a template, or an error when a brace is not part of one. */
function placeholdersOf(template: string): string[] | null {
  const names = [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
  const rest = template.replace(PLACEHOLDER, "");
  return rest.includes("{") || rest.includes("}") ? null : names;
}

/** The template joined to the base URL (a path is put under it), before the values are put in. */
function joined(base: string, template: string): string {
  return template.startsWith("/") ? `${base}${template}` : template;
}

/** The finished URL when it keeps the base URL's origin and has no credentials, else null. */
function sameOrigin(base: string, text: string): string | null {
  const url = parse(text);
  const origin = parse(base)?.origin;
  if (!url || !origin || url.origin !== origin || url.username || url.password) return null;
  return url.href;
}

/** Checks a template for a target against a base URL (already checked by `checkBaseUrl`). */
export function checkTemplate(base: string | null, template: string, target: Target): TemplateError | null {
  const trimmed = template.trim();
  if (!trimmed) return "empty";
  if ([...trimmed].length > MAX_LINK_CHARS) return "tooLong";
  if (hasBadChars(trimmed)) return "invalid";
  const names = placeholdersOf(trimmed);
  if (!names) return "brace";
  const allowed: readonly string[] = TARGET_VARIABLES[target];
  if (names.some((n) => !allowed.includes(n))) return "variable";
  if (!base) return "noBase";
  const probe = trimmed.replace(PLACEHOLDER, "x");
  if (!trimmed.startsWith("/") && !/^https?:\/\//i.test(trimmed)) return "origin";
  return sameOrigin(base, joined(base, probe)) ? null : "origin";
}

/**
 * The link of a template with the values put in (URL-encoded), or null when the template or a value is not
 * acceptable or a value it names is missing.
 */
export function fillTemplate(base: string | null, template: string | null | undefined, target: Target, values: Values): string | null {
  if (!base || !template || checkTemplate(base, template, target) !== null) return null;
  const trimmed = template.trim();
  let missing = false;
  const filled = trimmed.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name as Variable];
    if (value === undefined || !SAFE_VALUE.test(value)) {
      missing = true;
      return "";
    }
    return encodeURIComponent(value);
  });
  if (missing) return null;
  return sameOrigin(base, joined(base, filled));
}
