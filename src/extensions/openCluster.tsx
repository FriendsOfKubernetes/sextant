// `ui.openCluster` of an extension (#413): a configured cluster whose API server is the address the extension names
// (a Cluster API workload cluster's `controlPlaneEndpoint`) is opened — connected first when it is not — only after the
// user picks it in Sextant's own dialog, every time. The extension never learns the user's clusters: it is told only
// whether one was opened, or that none matches (`found: 0`, without a question).
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, type ObjectRef } from "../api";
import { Button, Dialog } from "../components";
import { selectCluster, useClustersStore } from "../features/clusters/clustersStore";
import { openInCluster } from "../features/fleet/store";

export interface Endpoint {
  host: string;
  port: number;
}

interface Question {
  id: number;
  extension: string;
  extensionName: string;
  endpoint: Endpoint;
  node: string | undefined;
  clusters: readonly { id: string; context: string }[];
  answer: (opened: boolean) => void;
}

let questions: Question[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function changed(next: Question[]): void {
  questions = next;
  for (const listener of [...listeners]) listener();
}

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();

/** Whether a kubeconfig server URL is the endpoint (default port by scheme), as Cluster API's view compared them. */
export function serverIs(server: string, endpoint: Endpoint): boolean {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    return false;
  }
  const port = url.port ? Number(url.port) : url.protocol === "http:" ? 80 : 443;
  return bare(url.hostname) === bare(endpoint.host) && port === endpoint.port;
}

/** The endpoint and node asked for; throws `invalid` for anything else. */
export function checkedTarget(params: unknown): { endpoint: Endpoint; node: string | undefined } {
  const bad = (why: string) => new ApiError("invalid", `ui.openCluster: ${why}`);
  if (typeof params !== "object" || params === null) throw bad("needs {host, port}");
  const { host, port, node } = params as Record<string, unknown>;
  if (typeof host !== "string" || host.trim() === "" || host.length > 253 || /[\s/@?#]/.test(host)) throw bad("host is a host name or address");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw bad("port is 1 to 65535");
  if (node !== undefined && (typeof node !== "string" || !/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/.test(node))) throw bad("node is a Node name");
  return { endpoint: { host: host.trim(), port }, node };
}

/** Offers the user the configured clusters at the endpoint; `{opened}`, or `{opened: false, found: 0}` when none. */
export function askOpenCluster(extension: string, extensionName: string, params: unknown): Promise<{ opened: boolean; found?: number }> {
  const { endpoint, node } = checkedTarget(params);
  const clusters = useClustersStore
    .getState()
    .clusters.filter((c) => serverIs(c.server, endpoint))
    .map((c) => ({ id: c.id, context: c.context }));
  if (clusters.length === 0) return Promise.resolve({ opened: false, found: 0 });
  if (questions.some((q) => q.extension === extension)) {
    return Promise.reject(new ApiError("conflict", "ui.openCluster: the user is already asked about another cluster"));
  }
  return new Promise((resolve) => {
    const question: Question = {
      id: nextId++,
      extension,
      extensionName,
      endpoint,
      node,
      clusters,
      answer: (opened) => {
        changed(questions.filter((q) => q !== question));
        resolve({ opened });
      },
    };
    changed([...questions, question]);
  });
}

/** Declines every open question of `extension` (it went away). */
export function declineOpenCluster(extension: string): void {
  for (const q of questions.filter((q) => q.extension === extension)) q.answer(false);
}

/** The dialogs: the oldest question first, a button per matching cluster. */
export function OpenClusterHost() {
  const { t } = useTranslation();
  const list = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => questions,
  );
  const question = list[0];
  if (!question) return null;
  const address = `${question.endpoint.host}:${question.endpoint.port}`;
  const nodeRef: ObjectRef | null = question.node
    ? { kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: question.node }
    : null;
  const open = (id: string) => {
    if (nodeRef) openInCluster(id, nodeRef);
    else selectCluster(id);
    question.answer(true);
  };
  return (
    <Dialog open title={t("extensions:host.openCluster.title")} onClose={() => question.answer(false)}>
      <p>{t("extensions:host.openCluster.text", { extension: question.extensionName, address })}</p>
      <div className="ext-open-cluster">
        {question.clusters.map((c) => (
          <Button key={c.id} onClick={() => open(c.id)}>
            {nodeRef
              ? t("extensions:host.openCluster.openNode", { node: question.node, context: c.context })
              : t("extensions:host.openCluster.open", { context: c.context })}
          </Button>
        ))}
        <Button onClick={() => question.answer(false)}>{t("extensions:host.openCluster.cancel")}</Button>
      </div>
    </Dialog>
  );
}

/** Tests: no question left. */
export function resetOpenCluster(): void {
  changed([]);
}
