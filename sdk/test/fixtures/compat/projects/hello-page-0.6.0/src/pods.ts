// The "Hello pods" page: the pods of one namespace, kept live by a watch. The namespace is picked on the page and
// remembered in the extension's storage; the page follows the cluster Sextant shows.
import { trackObjects, type KubeObject, type Sextant, type Watch } from "@sextant/extension-sdk";

interface ContainerStatus {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
}

type Pod = KubeObject<Record<string, unknown>, { phase?: string; containerStatuses?: ContainerStatus[] }>;

const POD = { group: "", kind: "Pod" };
const STORAGE_KEY = "namespace";

/** Ready containers, the status to show (a waiting or terminated reason first) and restarts. */
export function podSummary(pod: Pod): { ready: string; status: string; restarts: number } {
  const containers = pod.status?.containerStatuses ?? [];
  const ready = containers.filter((c) => c.ready).length;
  const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  const reason = containers.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean);
  const status = pod.metadata.deletionTimestamp ? "Terminating" : (reason ?? pod.status?.phase ?? "Unknown");
  return { ready: `${ready}/${containers.length}`, status, restarts };
}

/** `5s`, `12m`, `3h`, `4d`. */
function age(created: string | undefined, now = Date.now()): string {
  if (!created) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

/** Draws the page into `root`; returns the function that stops it. */
export function startPodsPage(sextant: Sextant, root: HTMLElement): () => void {
  const title = document.createElement("h1");
  title.textContent = "Pods in";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Namespace");
  const status = document.createElement("span");
  status.className = "status";
  const header = document.createElement("header");
  header.append(title, select, status);
  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;
  const table = document.createElement("table");
  table.innerHTML = "<thead><tr><th>Name</th><th>Ready</th><th>Status</th><th>Restarts</th><th>Age</th></tr></thead>";
  const body = document.createElement("tbody");
  table.append(body);
  root.replaceChildren(header, error, table);

  let namespace = "default";
  let watch: Watch | null = null;
  let stopped = false;

  const showError = (message: string | null) => {
    error.hidden = message === null;
    error.textContent = message ?? "";
  };

  const render = (pods: Pod[]) => {
    status.textContent = `${pods.length} ${pods.length === 1 ? "pod" : "pods"}`;
    body.replaceChildren(
      ...pods.map((pod) => {
        const { ready, status: state, restarts } = podSummary(pod);
        const name = document.createElement("button");
        name.className = "link";
        name.textContent = pod.metadata.name;
        name.addEventListener("click", () => {
          void sextant.ui.openDetails({
            kind: { group: "", version: "v1", kind: "Pod" },
            namespace: pod.metadata.namespace ?? namespace,
            name: pod.metadata.name,
          });
        });
        const nameCell = document.createElement("td");
        nameCell.append(name);
        const good = state === "Running" || state === "Succeeded" || state === "Completed";
        const row = document.createElement("tr");
        row.append(nameCell, cell(ready), cell(state, good ? "good" : "bad"), cell(String(restarts)), cell(age(pod.metadata.creationTimestamp)));
        return row;
      }),
    );
  };

  const watchPods = () => {
    void watch?.unwatch();
    body.replaceChildren();
    status.textContent = "Loading…";
    showError(null);
    if (!sextant.context.clusterId) {
      watch = null;
      status.textContent = "";
      showError("No cluster is open.");
      return;
    }
    watch = sextant.resources.watch(
      { kind: POD, namespaces: [namespace] },
      {
        onUpdate: trackObjects<Pod>(render, (update) => {
          if (update.type === "reconnecting") status.textContent = "Reconnecting…";
          if (update.type === "error") showError(update.message);
          if (update.type === "forbidden") showError(`The cluster does not let you list pods in ${update.namespaces.join(", ")}.`);
        }),
        onError: (err) => {
          status.textContent = "";
          showError(err.message);
        },
      },
    );
  };

  const loadNamespaces = async () => {
    const names = new Set([namespace]);
    try {
      const list = await sextant.resources.list({ kind: { group: "", kind: "Namespace" } });
      for (const ns of list.items) names.add(ns.metadata.name);
    } catch {
      // The page still works for the namespace it has.
    }
    if (stopped) return;
    select.replaceChildren(
      ...[...names].sort().map((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        return option;
      }),
    );
    select.value = namespace;
  };

  select.addEventListener("change", () => {
    namespace = select.value;
    void sextant.storage.set(STORAGE_KEY, namespace).catch(() => undefined);
    watchPods();
  });

  let cluster = sextant.context.clusterId;
  const offContext = sextant.onContextChange((context) => {
    if (context.clusterId === cluster) return;
    cluster = context.clusterId;
    watchPods();
    void loadNamespaces();
  });

  void (async () => {
    const stored = await sextant.storage.get<string>(STORAGE_KEY).catch(() => null);
    if (stopped) return;
    if (typeof stored === "string" && stored !== "") namespace = stored;
    watchPods();
    await loadNamespaces();
  })();

  return () => {
    stopped = true;
    offContext();
    void watch?.unwatch();
  };
}
