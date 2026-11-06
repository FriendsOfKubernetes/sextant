// Where Argo CD runs in a cluster, and the requests the extension sends to its API through Sextant
// (`sextant.service.request`, ADR-0158, ADR-0160, ADR-0161). No DOM here.
//
// The installation is the namespace of the `argocd-server` Service (by its label, so a Helm release's
// `<release>-argocd-server` is found too). With several, the extension picks none by itself: the user chooses one,
// and the choice is kept per cluster (`sextant.storage`) and taken only while that namespace still has such a Service.
// The API is one of the manifest's services, each the one Service of that label in the namespace: over HTTPS, or in
// plain HTTP when `argocd-cmd-params-cm` says `server.insecure: "true"` — never a fallback after an error.
//
// Nothing secret passes through the extension. Sextant keeps the session token (`capture`, `auth: "session"`), puts
// the admin password of `argocd-initial-admin-secret` into the sign-in itself (a key the services declare), and asks
// for a user and password, or an API token, in its own dialog (`ui.signIn`), filling them in as `{{signIn:…}}` or
// sending the token as the bearer (`auth: "signIn:token"`).
import type { ClusterId, JsonValue, KubeObject, ObjectRef, Sextant, ServiceAnswer, ServiceRequestParams } from "@sextant/extension-sdk";
import { arr, get, num, record, str } from "./fields";

/** Label of the `argocd-server` Service in the official manifests and the Helm chart. */
export const SERVER_SELECTOR = "app.kubernetes.io/name=argocd-server";
/**
 * The manifest's services: a user and password (with the admin Secret) or an API token, each over TLS (Argo CD's
 * default) or plain HTTP (`server.insecure`).
 */
export const SERVICES = {
  password: { https: "argocd-server", http: "argocd-server-http" },
  token: { https: "argocd-server-token", http: "argocd-server-token-http" },
} as const;
/** How the extension is signed in: a session Sextant keeps, or an API token Sextant sends with each request. */
export type SignInMode = keyof typeof SERVICES;
/** Argo CD's settings: `admin.enabled`, local `accounts.*`, SSO (`dex.config`, `oidc.config`). */
export const SETTINGS_CONFIG_MAP = "argocd-cm";
/** Parameters of Argo CD's components; `server.insecure: "true"` runs `argocd-server` without TLS. */
export const PARAMS_CONFIG_MAP = "argocd-cmd-params-cm";
/** The Secret Argo CD creates at installation with the first password of `admin` (key `password`). */
export const ADMIN_SECRET = "argocd-initial-admin-secret";

const SERVICE_KIND = { group: "", version: "v1", kind: "Service" };
const CONFIG_MAP_KIND = { group: "", version: "v1", kind: "ConfigMap" };

export type Lookup =
  | { type: "found"; namespace: string; server: KubeObject }
  | { type: "none" }
  | { type: "several"; namespaces: string[] };

/**
 * The installation among the `argocd-server` Services found: the only namespace that has one, or the remembered
 * choice when it is still one of several. In a namespace with more than one, the first by name.
 */
export function chooseInstallation(servers: readonly KubeObject[], remembered: string | null): Lookup {
  const byNamespace = new Map<string, KubeObject>();
  const sorted = [...servers].sort((a, b) => (a.metadata.name ?? "").localeCompare(b.metadata.name ?? ""));
  for (const server of sorted) {
    const namespace = server.metadata.namespace;
    if (namespace && !byNamespace.has(namespace)) byNamespace.set(namespace, server);
  }
  const namespaces = [...byNamespace.keys()].sort();
  if (namespaces.length === 0) return { type: "none" };
  const chosen = namespaces.length === 1 ? namespaces[0]! : remembered !== null && byNamespace.has(remembered) ? remembered : null;
  if (chosen === null) return { type: "several", namespaces };
  return { type: "found", namespace: chosen, server: byNamespace.get(chosen)! };
}

/** Where the choice among several installations is kept. */
export const installationKey = (clusterId: ClusterId): string => `installation/${clusterId}`;

/** Lists the `argocd-server` Services of every namespace the extension may read and chooses the installation. */
export async function findInstallation(sextant: Sextant, clusterId: ClusterId): Promise<Lookup> {
  const [list, remembered] = await Promise.all([
    sextant.resources.list({ clusterId, kind: SERVICE_KIND, labelSelector: SERVER_SELECTOR, limit: 100 }),
    sextant.storage.get(installationKey(clusterId)).catch(() => null),
  ]);
  return chooseInstallation(list.items, typeof remembered === "string" ? remembered : null);
}

export async function rememberInstallation(sextant: Sextant, clusterId: ClusterId, namespace: string): Promise<void> {
  await sextant.storage.set(installationKey(clusterId), namespace);
}

/** The Service port of the UI: the one named `https` or 443, else the first. */
export function uiPort(server: KubeObject | null): number {
  const ports = arr(get(server, "spec", "ports"));
  const https = ports.find((p) => str(get(p, "name")) === "https" || num(get(p, "port")) === 443);
  return num(get(https ?? ports[0], "port")) ?? 443;
}

/** A ConfigMap's data in the installation; empty when it is missing or cannot be read. */
async function configData(sextant: Sextant, clusterId: ClusterId, namespace: string, name: string): Promise<Record<string, string>> {
  try {
    const cm = await sextant.resources.get({ clusterId, ref: { kind: CONFIG_MAP_KIND, namespace, name } });
    return record(get(cm, "data")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** `server.insecure: "true"` in `argocd-cmd-params-cm`: the server speaks plain HTTP. */
export const isInsecure = (params: Record<string, unknown>): boolean =>
  (str(params["server.insecure"]) ?? "").trim().toLowerCase() === "true";

export interface LoginOptions {
  /** `admin` or another local account may sign in with a password. */
  localUsers: boolean;
  /** Admin sign-in is on (`admin.enabled` is not `"false"`). */
  admin: boolean;
  /** Dex or OIDC is configured (the extension cannot sign in through it). */
  sso: boolean;
}

/** What `argocd-cm` allows; Argo CD's defaults without it: `admin` may sign in, no SSO. */
export function loginOptionsOf(settings: Record<string, unknown>): LoginOptions {
  const text = (key: string) => str(settings[key])?.trim();
  const admin = text("admin.enabled") !== "false";
  const accountWithLogin = Object.entries(settings).some(([key, value]) => {
    if (!key.startsWith("accounts.")) return false;
    const name = key.slice("accounts.".length);
    return (
      !name.includes(".") &&
      (str(value) ?? "").split(",").some((cap) => cap.trim() === "login") &&
      text(`accounts.${name}.enabled`) !== "false"
    );
  });
  return { localUsers: admin || accountWithLogin, admin, sso: Boolean(text("dex.config")) || Boolean(text("oidc.config")) };
}

/** An installation with what the extension needs to talk to it. */
export interface ArgoServer {
  clusterId: ClusterId;
  namespace: string;
  server: KubeObject;
  insecure: boolean;
  options: LoginOptions;
}

/** Reads the installation's settings (both ConfigMaps) for `found`. */
export async function describeServer(sextant: Sextant, clusterId: ClusterId, namespace: string, server: KubeObject): Promise<ArgoServer> {
  const [params, settings] = await Promise.all([
    configData(sextant, clusterId, namespace, PARAMS_CONFIG_MAP),
    configData(sextant, clusterId, namespace, SETTINGS_CONFIG_MAP),
  ]);
  return { clusterId, namespace, server, insecure: isInsecure(params), options: loginOptionsOf(settings) };
}

/** The manifest's service for the installation's scheme and the way of signing in. */
export const serviceOf = (server: Pick<ArgoServer, "insecure">, mode: SignInMode = "password"): string =>
  SERVICES[mode][server.insecure ? "http" : "https"];

const base = (server: ArgoServer, mode: SignInMode = "password") => ({
  clusterId: server.clusterId,
  namespace: server.namespace,
  service: serviceOf(server, mode),
});

/** The placeholder Sextant replaces with the admin password; the extension never sees the value. */
export const ADMIN_PASSWORD = `{{secret:${ADMIN_SECRET}/password}}`;

/** Signs in as `admin` with the password of `argocd-initial-admin-secret`, Sextant keeping the token. */
export function adminSignIn(server: ArgoServer): ServiceRequestParams {
  return { ...base(server), method: "POST", path: "/api/v1/session", body: { username: "admin", password: ADMIN_PASSWORD }, capture: ".token" };
}

/**
 * Signs in with the user and password typed in Sextant's dialog (this run's, or the one remembered for the cluster),
 * Sextant filling them in and keeping the token. Sextant refuses (`unauthorized`) without one, sending nothing.
 */
export function typedSignIn(server: ArgoServer): ServiceRequestParams {
  return {
    ...base(server),
    method: "POST",
    path: "/api/v1/session",
    body: { username: "{{signIn:username}}", password: "{{signIn:password}}" },
    capture: ".token",
  };
}

/** How a request is authorized: the session, or the API token typed in Sextant's dialog. */
const authOf = (mode: SignInMode) => (mode === "token" ? ({ auth: "signIn:token" } as const) : ({ auth: "session" } as const));

/** Who the session (or the token) belongs to. */
export function userInfo(server: ArgoServer, mode: SignInMode = "password"): ServiceRequestParams {
  return { ...base(server, mode), method: "GET", path: "/api/v1/session/userinfo", ...authOf(mode) };
}

/** The desired and live states of an Application's resources (the app's own namespace as `appNamespace`). */
export function managedResourcesRequest(
  server: ArgoServer,
  app: Pick<ObjectRef, "namespace" | "name">,
  mode: SignInMode = "password",
): ServiceRequestParams {
  const request: ServiceRequestParams = {
    ...base(server, mode),
    method: "GET",
    path: `/api/v1/applications/${encodeURIComponent(app.name)}/managed-resources`,
    ...authOf(mode),
  };
  if (app.namespace) request.query = { appNamespace: app.namespace };
  return request;
}

/** Argo CD's own sentence of an error answer (`{"error":…,"message":…}`). */
export function answerMessage(answer: ServiceAnswer): string | null {
  const body = answer.body;
  if (typeof body === "string") return body.trim() || null;
  return str(get(body, "message")) || str(get(body, "error")) || null;
}

export type AnswerKind = "ok" | "unauthorized" | "forbidden" | "unreachable" | "other";

/** How to read an answer's status. */
export function answerKind(status: number): AnswerKind {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "unauthorized";
  // Argo CD answers "permission denied" for an application that does not exist, too.
  if (status === 403 || status === 404) return "forbidden";
  if (status >= 502 && status <= 504) return "unreachable";
  return "other";
}

/** The user name of a `userinfo` answer, when signed in. */
export function userOf(body: JsonValue): string | null {
  return get(body, "loggedIn") === true ? (str(get(body, "username")) ?? null) : null;
}
