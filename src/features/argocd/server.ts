// Where Argo CD runs in a cluster and how to reach its web UI: the `argocd-server` Service (found by its label), a
// local port forwarded to it, and `https://localhost:<port>` (plain `http` when the server runs without TLS).
import {
  api,
  events,
  openStream,
  type ClusterId,
  type ForwardInfo,
  type KubeObject,
  type WatchSpec,
  type WatchUpdate,
} from "../../api";
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

const SERVER_WATCH: WatchSpec = {
  kind: { group: "", version: "v1", kind: "Service" },
  namespaces: null,
  labelSelector: ARGOCD_SERVER_SELECTOR,
  fieldSelector: null,
};

/** The `argocd-server` Service of the cluster, listed once by its label; `null` when none is found or listable. */
export function findArgocdServer(clusterId: ClusterId): Promise<KubeObject | null> {
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
      start: (id) => api.resources.watchStart(clusterId, SERVER_WATCH, id),
      listen: events.onWatch,
      stop: api.resources.watchStop,
      onEvent: (update) => {
        if (update.type === "snapshot") {
          const items = update.items as KubeObject[];
          // Several matches (a second instance): the one named as Argo CD names it, else the first.
          finish(items.find((s) => s.metadata?.name === ARGOCD_SERVER) ?? items[0] ?? null);
        } else if (update.type === "error") {
          finish(null);
        }
      },
      onStartError: () => finish(null),
    });
    if (done) close();
  });
}

/** The namespace Argo CD runs in: that of its `argocd-server` Service, `argocd` when it cannot be found. */
export async function argocdNamespace(clusterId: ClusterId): Promise<string> {
  const server = await findArgocdServer(clusterId);
  return server?.metadata?.namespace ?? DEFAULT_ARGOCD_NAMESPACE;
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
 * local port to `argocd-server` first unless such a forward is already running.
 */
export async function openArgoUi(clusterId: ClusterId, path = ""): Promise<void> {
  const server = await findArgocdServer(clusterId);
  const namespace = server?.metadata?.namespace ?? DEFAULT_ARGOCD_NAMESPACE;
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
