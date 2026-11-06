// Sextant's own extensions in the e2e profile (ADR-0162): Flux, Argo CD and Argo Rollouts are extensions, so the GitOps
// scenarios need them installed. They are built (`npm run sdk:build`) and listed in the profile's settings as folder
// installs of their `dist/`, granted what their manifests ask — what Sextant's own install writes after the consent
// window (`src-tauri/src/extensions/manage.rs`), so the window opens on them as on any installed extension.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "./cluster";

export const OWN_EXTENSIONS = ["flux", "argo-cd", "argo-rollouts"] as const;

type Json = Record<string, unknown>;

/** Builds the extensions into `extensions/<name>/dist`. */
export function buildOwnExtensions(): void {
  for (const name of OWN_EXTENSIONS) {
    execFileSync("npm", ["run", "--silent", "sdk:build", "--", `extensions/${name}`], { cwd: ROOT, stdio: "inherit" });
  }
}

/** Every `{group, kind}` a problem rule judges or looks up (a superset of the core's `problem_kinds` is a grant too). */
function problemKinds(problems: Json[]): Json[] {
  const out: Json[] = [];
  const add = (k: Json) => {
    if (!out.some((o) => o.group === k.group && o.kind === k.kind)) out.push({ group: k.group, kind: k.kind });
  };
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== "object") return;
    const obj = value as Json;
    if (typeof obj.group === "string" && typeof obj.kind === "string") add(obj);
    Object.values(obj).forEach(scan);
  };
  for (const rule of problems) {
    add(rule.kind as Json);
    scan(rule.when);
  }
  return out;
}

/** The settings entry of a folder install of `extensions/<name>/dist`, granted what its manifest asks. */
export function installedEntry(name: (typeof OWN_EXTENSIONS)[number]): Json {
  const folder = path.join(ROOT, "extensions", name, "dist");
  const manifest = JSON.parse(readFileSync(path.join(folder, "sextant-extension.json"), "utf8")) as Json;
  const contributes = (manifest.contributes ?? {}) as Json;
  const list = (key: string): Json[] => (Array.isArray(contributes[key]) ? (contributes[key] as Json[]) : []);
  const backend = manifest.backend as Json | undefined;
  const entry: Json = {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    source: { type: "folder", path: folder },
    enabled: true,
    granted: manifest.permissions,
    installedAt: 0,
  };
  if (backend) entry.grantedBackend = { hosts: backend.hosts ?? [], credentials: backend.credentials ?? [] };
  if (list("problems").length > 0) entry.grantedProblems = problemKinds(list("problems"));
  for (const [key, field] of [
    ["metricQueries", "grantedMetricQueries"],
    ["commands", "grantedCommands"],
    ["services", "grantedServices"],
    ["agentTools", "grantedAgentTools"],
  ] as const) {
    if (list(key).length > 0) entry[field] = list(key);
  }
  return entry;
}
