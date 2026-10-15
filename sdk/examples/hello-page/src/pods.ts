// The "Hello pods" page: pods kept live by a watch. By default it shows the namespaces selected in Sextant's namespace
// filter (`context.namespaces`, `null` for all) and follows them; a namespace picked on the page overrides the filter
// and is remembered in the extension's storage until "Sextant's filter" is picked again. The page follows the cluster
// Sextant shows.
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
/** The picker's value for "follow Sextant's namespace filter". */
const FOLLOW = "";

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
  table.innerHTML =
    "<thead><tr><th>Name</th><th>Namespace</th><th>Ready</th><th>Status</th><th>Restarts</th><th>Age</th></tr></thead>";
  const body = document.createElement("tbody");
  table.append(body);
  root.replaceChildren(header, error, table);

  // The namespace picked on the page; `null` follows Sextant's filter.
  let picked: string | null = null;
  let known: string[] = [];
  let watch: Watch | null = null;
  let stopped = false;

  /** The namespaces to show: the picked one, else Sextant's filter (`null`: every namespace). */
  const shown = (): string[] | null => (picked !== null ? [picked] : sextant.context.namespaces);

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
            namespace: pod.metadata.namespace ?? null,
            name: pod.metadata.name,
          });
        });
        const nameCell = document.createElement("td");
        nameCell.append(name);
        const good = state === "Running" || state === "Succeeded" || state === "Completed";
        const row = document.createElement("tr");
        row.append(
          nameCell,
          cell(pod.metadata.namespace ?? ""),
          cell(ready),
          cell(state, good ? "good" : "bad"),
          cell(String(restarts)),
          cell(age(pod.metadata.creationTimestamp)),
        );
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
    const namespaces = shown();
    watch = sextant.resources.watch(
      namespaces === null ? { kind: POD } : { kind: POD, namespaces },
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

  const option = (value: string, text: string) => {
    const element = document.createElement("option");
    element.value = value;
    element.textContent = text;
    return element;
  };

  /** The picker: "Sextant's filter" first, then the cluster's namespaces (and the picked one). */
  const drawPicker = () => {
    const filter = sextant.context.namespaces;
    const names = new Set(known);
    if (picked !== null) names.add(picked);
    select.replaceChildren(
      option(FOLLOW, `Sextant's filter (${filter === null ? "all namespaces" : filter.join(", ")})`),
      ...[...names].sort().map((name) => option(name, name)),
    );
    select.value = picked ?? FOLLOW;
  };

  const loadNamespaces = async () => {
    let names: string[] = [];
    try {
      const list = await sextant.resources.list({ kind: { group: "", kind: "Namespace" } });
      names = list.items.map((ns) => ns.metadata.name);
    } catch {
      // The page still works with Sextant's filter and the namespace it has.
    }
    if (stopped) return;
    known = names;
    drawPicker();
  };

  select.addEventListener("change", () => {
    picked = select.value === FOLLOW ? null : select.value;
    const saved = picked === null ? sextant.storage.remove(STORAGE_KEY) : sextant.storage.set(STORAGE_KEY, picked);
    void saved.catch(() => undefined);
    watchPods();
  });

  let cluster = sextant.context.clusterId;
  let filter = JSON.stringify(sextant.context.namespaces);
  const offContext = sextant.onContextChange((context) => {
    const nextFilter = JSON.stringify(context.namespaces);
    const filterChanged = nextFilter !== filter;
    filter = nextFilter;
    if (context.clusterId !== cluster) {
      cluster = context.clusterId;
      watchPods();
      void loadNamespaces();
      return;
    }
    if (!filterChanged) return;
    drawPicker();
    // A picked namespace overrides the filter: only the picker's label changes.
    if (picked === null) watchPods();
  });

  drawPicker();
  void (async () => {
    const stored = await sextant.storage.get<string>(STORAGE_KEY).catch(() => null);
    if (stopped) return;
    if (typeof stored === "string" && stored !== "") picked = stored;
    drawPicker();
    watchPods();
    await loadNamespaces();
  })();

  return () => {
    stopped = true;
    offContext();
    void watch?.unwatch();
  };
}
