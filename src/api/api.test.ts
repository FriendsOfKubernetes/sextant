import { afterEach, describe, expect, it } from "vitest";
import type { ObjectRef } from "./generated/ObjectRef";
import { api, ApiError, events, mockBackend, type MockBackend } from "./index";

// Command names and argument names from the IPC contract (interfaces.md, «Команды»).
const ref: ObjectRef = { kind: { group: "apps", version: "v1", kind: "Deployment" }, namespace: "ns", name: "web" };
const pod: ObjectRef = { kind: { group: "", version: "v1", kind: "Pod" }, namespace: "ns", name: "web-1" };
const spec = { kind: pod.kind, namespaces: null, labelSelector: null, fieldSelector: null };
const opts = { container: "c", follow: true, previous: false, timestamps: false, tailLines: 1000 };
const target = { type: "pod" as const, namespace: "ns", name: "web-1" };

const cases: Array<[string, () => Promise<unknown>, Record<string, unknown> | undefined]> = [
  ["clusters_list", () => api.clusters.list(), undefined],
  ["kubeconfig_sources", () => api.clusters.sources(), undefined],
  ["kubeconfig_add_file", () => api.clusters.addFile("/k.yaml"), { path: "/k.yaml" }],
  ["kubeconfig_add_pasted", () => api.clusters.addPasted("apiVersion: v1"), { text: "apiVersion: v1" }],
  ["kubeconfig_remove", () => api.clusters.removeSource("s1"), { sourceId: "s1" }],
  ["cluster_connect", () => api.clusters.connect("c1"), { clusterId: "c1" }],
  ["cluster_disconnect", () => api.clusters.disconnect("c1"), { clusterId: "c1" }],
  ["cluster_state", () => api.clusters.state("c1"), { clusterId: "c1" }],
  ["cluster_kinds", () => api.clusters.kinds("c1"), { clusterId: "c1" }],
  ["watch_start", () => api.resources.watchStart("c1", spec), { clusterId: "c1", spec }],
  ["watch_stop", () => api.resources.watchStop("w1"), { subscriptionId: "w1" }],
  ["resource_get", () => api.resources.get("c1", ref), { clusterId: "c1", ref }],
  ["resource_replace", () => api.resources.replace("c1", "y"), { clusterId: "c1", yaml: "y" }],
  ["resource_apply", () => api.resources.apply("c1", "y"), { clusterId: "c1", yaml: "y" }],
  ["resource_delete", () => api.resources.delete("c1", ref), { clusterId: "c1", ref }],
  ["workload_scale", () => api.actions.scale("c1", ref, 3), { clusterId: "c1", ref, replicas: 3 }],
  ["workload_restart", () => api.actions.restart("c1", ref), { clusterId: "c1", ref }],
  ["node_cordon", () => api.actions.cordon("c1", "n1", true), { clusterId: "c1", name: "n1", unschedulable: true }],
  ["node_drain", () => api.actions.drain("c1", "n1"), { clusterId: "c1", name: "n1" }],
  ["cronjob_trigger", () => api.actions.triggerCronJob("c1", ref), { clusterId: "c1", ref }],
  ["cronjob_suspend", () => api.actions.suspendCronJob("c1", ref, true), { clusterId: "c1", ref, suspend: true }],
  ["logs_start", () => api.logs.start("c1", pod, opts), { clusterId: "c1", pod, opts }],
  ["logs_stop", () => api.logs.stop("l1"), { streamId: "l1" }],
  [
    "exec_start",
    () => api.terminal.exec("c1", pod, "c", 80, 24),
    { clusterId: "c1", pod, container: "c", cols: 80, rows: 24 },
  ],
  ["terminal_start", () => api.terminal.local("c1", 80, 24), { clusterId: "c1", cols: 80, rows: 24 }],
  ["term_input", () => api.terminal.input("t1", "ls\r"), { sessionId: "t1", data: "ls\r" }],
  ["term_resize", () => api.terminal.resize("t1", 100, 30), { sessionId: "t1", cols: 100, rows: 30 }],
  ["term_stop", () => api.terminal.stop("t1"), { sessionId: "t1" }],
  [
    "portforward_start",
    () => api.portForward.start("c1", target, 80, 8080),
    { clusterId: "c1", target, remotePort: 80, localPort: 8080 },
  ],
  ["portforward_list", () => api.portForward.list(), undefined],
  ["portforward_stop", () => api.portForward.stop("pf1"), { id: "pf1" }],
  ["metrics_pods", () => api.metrics.pods("c1", ["ns"]), { clusterId: "c1", namespaces: ["ns"] }],
  ["metrics_nodes", () => api.metrics.nodes("c1"), { clusterId: "c1" }],
  ["metrics_status", () => api.metrics.status("c1"), { clusterId: "c1" }],
  [
    "metrics_charts",
    () => api.metrics.charts("c1", { type: "cluster" }, 3600),
    { clusterId: "c1", chart: { type: "cluster" }, rangeSecs: 3600 },
  ],
  ["helm_status", () => api.helm.status(), undefined],
  ["helm_releases", () => api.helm.releases("c1", null), { clusterId: "c1", namespaces: null }],
  [
    "helm_release_detail",
    () => api.helm.releaseDetail("c1", "ns", "r", 2),
    { clusterId: "c1", namespace: "ns", name: "r", revision: 2 },
  ],
  [
    "helm_release_history",
    () => api.helm.releaseHistory("c1", "ns", "r"),
    { clusterId: "c1", namespace: "ns", name: "r" },
  ],
  [
    "helm_upgrade",
    () => api.helm.upgrade("c1", "ns", "r", "repo/chart", "a: 1"),
    { clusterId: "c1", namespace: "ns", release: "r", chartRef: "repo/chart", valuesYaml: "a: 1" },
  ],
  [
    "helm_rollback",
    () => api.helm.rollback("c1", "ns", "r", 1),
    { clusterId: "c1", namespace: "ns", release: "r", revision: 1 },
  ],
  ["helm_uninstall", () => api.helm.uninstall("c1", "ns", "r"), { clusterId: "c1", namespace: "ns", release: "r" }],
  [
    "helm_install",
    () => api.helm.install("c1", "ns", "r", "repo/chart", "1.0.0", "a: 1"),
    { clusterId: "c1", namespace: "ns", release: "r", chart: "repo/chart", version: "1.0.0", valuesYaml: "a: 1" },
  ],
  ["helm_repos", () => api.helm.repos(), undefined],
  ["helm_repo_add", () => api.helm.repoAdd("bitnami", "https://x"), { name: "bitnami", url: "https://x" }],
  ["helm_repo_remove", () => api.helm.repoRemove("bitnami"), { name: "bitnami" }],
  ["helm_repo_update", () => api.helm.repoUpdate(), undefined],
  ["helm_search", () => api.helm.search("nginx"), { query: "nginx" }],
  ["helm_show_values", () => api.helm.showValues("repo/chart", null), { chart: "repo/chart", version: null }],
  ["settings_get", () => api.settings.get(), undefined],
  ["file_save", () => api.files.save("/tmp/x.log", "text"), { path: "/tmp/x.log", contents: "text" }],
];

let backend: MockBackend | undefined;
afterEach(() => backend?.restore());

describe("src/api commands", () => {
  it.each(cases)("%s is invoked with the contract argument names", async (cmd, call, args) => {
    backend = mockBackend({ [cmd]: () => "ok" });
    await call();
    expect(backend.calls).toEqual([{ cmd, args: args ?? {} }]);
  });

  it("covers every command of the contract", () => {
    const covered = new Set(cases.map(([cmd]) => cmd));
    covered.add("settings_update"); // checked below with a real settings object
    expect(covered.size).toBe(52);
  });

  it("settings_update sends the whole settings object", async () => {
    backend = mockBackend();
    const current = await api.settings.get();
    const saved = await api.settings.update({ ...current, theme: "dark" });
    expect(saved.theme).toBe("dark");
    expect(backend.calls.at(-1)).toEqual({ cmd: "settings_update", args: { settings: { ...current, theme: "dark" } } });
  });

  it("an unimplemented command rejects with ApiError code 'other'", async () => {
    backend = mockBackend();
    const err = await api.clusters.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "other", message: "not implemented" });
  });

  it("a CoreError from the backend becomes an ApiError with the same code", async () => {
    backend = mockBackend({
      cluster_connect: () => {
        throw { code: "unreachable", message: "connection refused" };
      },
    });
    await expect(api.clusters.connect("c1")).rejects.toMatchObject({
      name: "ApiError",
      code: "unreachable",
      message: "connection refused",
    });
  });

  it("a plain string error (e.g. bad arguments) becomes code 'other'", async () => {
    backend = mockBackend({
      cluster_connect: () => {
        throw "invalid args `clusterId` for command `cluster_connect`";
      },
    });
    await expect(api.clusters.connect("c1")).rejects.toMatchObject({ code: "other" });
  });
});

describe("src/api events", () => {
  it("delivers payloads of named events and unsubscribes", async () => {
    backend = mockBackend();
    const seen: unknown[] = [];
    const unlisten = await events.onWatch("w1", (u) => seen.push(u));
    backend.emit("watch:w1", { type: "reconnecting" });
    backend.emit("watch:other", { type: "reconnecting" });
    expect(seen).toEqual([{ type: "reconnecting" }]);
    unlisten();
    backend.emit("watch:w1", { type: "reconnecting" });
    expect(seen).toHaveLength(1);
    expect(backend.listenerCount("watch:w1")).toBe(0);
  });

  it("uses the contract event names", async () => {
    backend = mockBackend();
    await events.onClusterState(() => {});
    await events.onLogs("l1", () => {});
    await events.onTerm("t1", () => {});
    await events.onPortForwards(() => {});
    for (const name of ["cluster-state", "logs:l1", "term:t1", "portforwards"]) {
      expect(backend.listenerCount(name)).toBe(1);
    }
  });
});
