// Where Argo CD runs in a cluster and how to reach its web UI: the namespace the backend found Argo CD installed in
// (`argocd_status`, the same server the sign-in uses), the `argocd-server` Service there (by its label), a local port
// forwarded to it, and `https://localhost:<port>` (plain `http` when the server runs without TLS). A Service with the
// same label in any other namespace is never used. When several namespaces look like Argo CD and the backend cannot
// tell the real one, nothing is opened: the error names them, and the user may choose one of them
// (`chooseArgocdNamespace`, saved as `clusters[id].argocdNamespace`; the backend takes it only among its candidates).
import {
  api,
  ApiError,
  toApiError,
  events,
  openStream,
  type ClusterId,
  type ForwardInfo,
  type KubeObject,
  type WatchSpec,
  type WatchUpdate,
} from "../../api";
import { i18n } from "../../i18n";
import { updateClusterSettings } from "../clusters/clusterSettings";
import { urlOf, type UrlScheme } from "../portforward";
import { status } from "../../resources";

const { arr, get, num, str } = status;

/** Where Argo CD's own manifests install it. */
export const DEFAULT_ARGOCD_NAMESPACE = "argocd";
export const ARGOCD_SERVER = "argocd-server";
export const ARGOCD_SERVER_SELECTOR = "app.kubernetes.io/name=argocd-server";
/** Argo CD's settings of its components; `server.insecure: "true"` turns TLS off. */
const PARAMS_CONFIG_MAP = "argocd-cmd-params-cm";
/** How long to wait for the list of Services before falling back to the default namespace. */
const LOOKUP_TIMEOUT_MS = 10_000;

const serverWatch = (namespace: string): WatchSpec => ({
  kind: { group: "", version: "v1", kind: "Service" },
  namespaces: [namespace],
  labelSelector: ARGOCD_SERVER_SELECTOR,
  fieldSelector: null,
});

/** How the backend's `notFound` error begins when several namespaces look like Argo CD (`AMBIGUOUS_INSTALLATION`). */
const AMBIGUOUS_INSTALLATION = "ambiguous Argo CD installation";

/** The backend found several namespaces that look like an Argo CD installation and picked none of them. */
export function isAmbiguousInstallation(err: unknown): boolean {
  const error = toApiError(err);
  return error.code === "notFound" && error.message.startsWith(AMBIGUOUS_INSTALLATION);
}

/** The namespaces the backend listed in its ambiguous-installation error (`(aaa, gitops)`); empty for other errors. */
export function ambiguousNamespaces(err: unknown): string[] {
  if (!isAmbiguousInstallation(err)) return [];
  const listed = /\(([^)]*)\)/.exec(toApiError(err).message)?.[1] ?? "";
  return listed
    .split(",")
    .map((ns) => ns.trim())
    .filter((ns) => ns !== "");
}

/** The plain-words text of an ambiguous installation, with the namespaces the backend listed ("aaa, gitops"). */
export function ambiguousInstallationText(err: unknown): string {
  const listed = ambiguousNamespaces(err).join(", ") || "?";
  return i18n.t("argocd:installation.ambiguous", { namespaces: listed });
}

/**
 * Saves the user's choice among the namespaces of an ambiguous installation for the cluster. The backend reads it on
 * its next call and takes it only when it is one of the candidates it finds itself.
 */
export async function chooseArgocdNamespace(clusterId: ClusterId, namespace: string): Promise<void> {
  await updateClusterSettings(clusterId, { argocdNamespace: namespace });
}

/**
 * The namespace Argo CD is installed in, as the backend found it (where it signs in, honouring the user's choice);
 * `argocd` when the backend cannot find Argo CD. Several look-alike installations are not resolved here: the
 * backend's error is thrown as is (`isAmbiguousInstallation`, `ambiguousNamespaces`).
 */
export async function argocdNamespace(clusterId: ClusterId): Promise<string> {
  try {
    return (await api.argocd.status(clusterId)).namespace;
  } catch (err) {
    if (isAmbiguousInstallation(err)) {
      const error = toApiError(err);
      throw new ApiError(error.code, error.message);
    }
    return DEFAULT_ARGOCD_NAMESPACE;
  }
}

/**
 * The `argocd-server` Service in the namespace Argo CD is installed in, listed once by its label (the first by name,
 * as the backend picks it); `null` when none is found or listable there, or the installation is ambiguous.
 */
export async function findArgocdServer(clusterId: ClusterId): Promise<KubeObject | null> {
  let namespace: string;
  try {
    namespace = await argocdNamespace(clusterId);
  } catch {
    return null;
  }
  return serverIn(clusterId, namespace);
}

function serverIn(clusterId: ClusterId, namespace: string): Promise<KubeObject | null> {
  return new Promise((resolve) => {
    let done = false;
    let close: () => void = () => undefined;
    const finish = (server: KubeObject | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      close();
      resolve(server);
    };
    const timer = setTimeout(() => finish(null), LOOKUP_TIMEOUT_MS);
    close = openStream<WatchUpdate>({
      start: (id) => api.resources.watchStart(clusterId, serverWatch(namespace), id),
      listen: events.onWatch,
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (update.type === "snapshot") {
          const name = (s: KubeObject) => s.metadata?.name ?? "";
          const here = (update.items as KubeObject[])
            .filter((s) => s.metadata?.namespace === namespace)
            .sort((a, b) => name(a).localeCompare(name(b)));
          finish(here[0] ?? null);
        } else if (update.type === "error") {
          finish(null);
        }
      },
      onStartError: () => finish(null),
    });
    if (done) close();
  });
}

/** The Service port of the UI: the one named `https` or 443, else the first. */
function uiPort(server: KubeObject | null): number {
  const ports = arr(get(server, "spec", "ports"));
  const https = ports.find((p) => str(get(p, "name")) === "https" || num(get(p, "port")) === 443);
  return num(get(https ?? ports[0], "port")) ?? 443;
}

async function uiScheme(clusterId: ClusterId, namespace: string): Promise<UrlScheme> {
  try {
    const params = await api.resources.get(clusterId, {
      kind: { group: "", version: "v1", kind: "ConfigMap" },
      namespace,
      name: PARAMS_CONFIG_MAP,
    });
    return str(get(params, "data", "server.insecure")) === "true" ? "http" : "https";
  } catch {
    return "https";
  }
}

/**
 * Opens the Argo CD web UI in the system browser at `path` (e.g. `/applications/argocd/guestbook`), forwarding a
 * local port to `argocd-server` first unless such a forward is already running. Rejects, opening nothing, when the
 * backend cannot tell which of several namespaces is the installation (the caller offers the choice).
 */
export async function openArgoUi(clusterId: ClusterId, path = ""): Promise<void> {
  const namespace = await argocdNamespace(clusterId);
  const server = await serverIn(clusterId, namespace);
  const name = server?.metadata?.name ?? ARGOCD_SERVER;
  const port = uiPort(server);
  const [scheme, forwards] = await Promise.all([uiScheme(clusterId, namespace), api.portForward.list()]);
  const running = forwards.find(
    (f: ForwardInfo) =>
      f.cluster === clusterId &&
      f.target.type === "service" &&
      f.target.namespace === namespace &&
      f.target.name === name &&
      f.remotePort === port &&
      f.status.state === "active",
  );
  const forward = running ?? (await api.portForward.start(clusterId, { type: "service", namespace, name }, port));
  await api.shell.openUrl(`${urlOf(forward, scheme)}${path}`);
}
