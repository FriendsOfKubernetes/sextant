// The details sections and the "Distribution" page, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests drove them. Objects reach the frame as Sextant gives them to this extension, which may have
// their secret fields masked (`permissions.maskedSecrets`, ADR-0169; `mask_inline_secrets`, mirrored by
// `asSextantGivesIt` and kept equal to Rust by `src/resources/masking-cases.json`): a node's `node-args` with every
// secret value `********`, a HelmChart's `valuesContent` as masked JSON and its `set` masked, named in
// `sextant.dev/values-masked`; a node's `node-env`, and what does not read, blanked and named in
// `sextant.dev/values-hidden`.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { MAX_CHART_JOBS, startDetails } from "./details";
import { setLanguage } from "./i18n";
import { MAX_ADDONS, MAX_KUBE_SYSTEM, MAX_NODES, startPage } from "./page";
import { MAX_CHARTS, MAX_JOBS } from "./model";
import { parse } from "yaml";
import { HIDDEN, K3S_OMITTED, looksSecret, maskedValuesContent, maskValues, nodeArgs } from "./mask";
import { cleanText } from "./uri";

const f = fixtures as unknown as Record<string, KubeObject>;
const fx = (name: string): KubeObject => structuredClone(f[name]!);
const SECRETS = ["plain-old-secret", "abc123", "hunter2", "k3s-pass", "s3cr3t-value", "dbpass", "inline-pass", "repo-pass"];

/** The inline secret fields Sextant hides from extensions (`src/resources/inline-secrets.json`, these kinds). */
const INLINE: Record<string, string[][]> = {
  HelmChart: [
    ["spec", "valuesContent"],
    ["spec", "set"],
  ],
  HelmChartConfig: [["spec", "valuesContent"]],
  Node: [
    ["metadata", "annotations", "k3s.io/node-args"],
    ["metadata", "annotations", "rke2.io/node-args"],
    ["metadata", "annotations", "k3s.io/node-env"],
    ["metadata", "annotations", "rke2.io/node-env"],
  ],
};

/** The masked copy Sextant gives of one field (`masked_node_args`, `masked_values_content`, `masked_set`); none to blank it. */
function maskedCopy(path: string[], value: unknown): unknown {
  const last = path[path.length - 1]!;
  if (last.endsWith("/node-args")) {
    const args = typeof value === "string" ? nodeArgs(value) : null;
    if (!args) return undefined;
    return JSON.stringify(
      args.map((a) => (a.flag === undefined ? (a.hidden ? K3S_OMITTED : (a.value ?? "")) : a.hidden ? `${a.flag}=${K3S_OMITTED}` : a.value === undefined ? a.flag : `${a.flag}=${a.value}`)),
    );
  }
  if (last === "valuesContent") {
    if (typeof value !== "string") return undefined;
    const shown = maskedValuesContent(value);
    if (shown === undefined || shown === "") return shown;
    return JSON.stringify(maskValues(parse(value)));
  }
  if (last === "set") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k.split(".").some(looksSecret) ? HIDDEN : (cleanText(typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v)) ?? "")]),
    );
  }
  // `node-env`: never given.
  return undefined;
}

/** An object as Sextant gives it to this extension (`mask_inline_secrets`): masked copies where it can, `""` else, the paths named. */
function asSextantGivesIt(obj: KubeObject): KubeObject {
  const out = structuredClone(obj);
  const hidden: string[] = [];
  const masked: string[] = [];
  for (const path of INLINE[out.kind ?? ""] ?? []) {
    let at = out as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) at = (at?.[key] ?? undefined) as Record<string, unknown>;
    const last = path[path.length - 1]!;
    const value = at?.[last];
    if (value === undefined || value === null || value === "") continue;
    const shown = path.map((p, i) => (/^[A-Za-z0-9_]+$/.test(p) ? `${i > 0 ? "." : ""}${p}` : `[${JSON.stringify(p)}]`)).join("");
    hidden.push(shown);
    const copy = maskedCopy(path, value);
    if (copy !== undefined) {
      at[last] = copy;
      masked.push(shown);
    } else if (typeof value === "object") for (const k of Object.keys(value)) (value as Record<string, unknown>)[k] = "";
    else at[last] = "";
  }
  if (hidden.length > 0) out.metadata.annotations = { ...(out.metadata.annotations ?? {}), "sextant.dev/values-hidden": hidden.join(", ") };
  if (masked.length > 0) out.metadata.annotations = { ...(out.metadata.annotations ?? {}), "sextant.dev/values-masked": masked.join(", ") };
  return out;
}

const KINDS: Record<string, { group: string; version: string; kind: string }> = {
  HelmChart: { group: "helm.cattle.io", version: "v1", kind: "HelmChart" },
  HelmChartConfig: { group: "helm.cattle.io", version: "v1", kind: "HelmChartConfig" },
  Addon: { group: "k3s.cattle.io", version: "v1", kind: "Addon" },
  ETCDSnapshotFile: { group: "k3s.cattle.io", version: "v1", kind: "ETCDSnapshotFile" },
  Node: { group: "", version: "v1", kind: "Node" },
};
const ref = (o: KubeObject) => ({ kind: KINDS[o.kind!]!, namespace: o.metadata.namespace ?? null, name: o.metadata.name });

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};
let hiddenCalls: boolean[] = [];

async function open(obj: KubeObject, contribution: string, options: { language?: string; raw?: boolean; blocks?: Record<string, boolean> } = {}): Promise<void> {
  remembered = { ...(options.blocks ?? {}) };
  hiddenCalls = [];
  const given = options.raw ? structuredClone(obj) : asSextantGivesIt(obj);
  host = await startTestHost({
    context: { view: "details", contribution, selection: [ref(obj)], resourceVersion: "1", language: options.language ?? "en", blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(given),
      "resources.watch": () => null,
      "ui.openLogs": () => null,
      "ui.setHidden": ({ hidden }: { hidden: boolean }) => void hiddenCalls.push(hidden),
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage(options.language ?? "en");
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const watchParams = (w: TestWatch) => w.params as { kind: { kind: string }; namespaces?: string[]; labelSelector?: string; fieldSelector?: string; maxObjects?: number };
const watchOf = (kind: string, pick: (p: ReturnType<typeof watchParams>) => boolean = () => true) =>
  host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped && pick(watchParams(w)));
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const statusOf = (word: string) => [...root.querySelectorAll(".sx-status")].find((s) => s.textContent === word);
const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`)!;

describe("a HelmChart", () => {
  it("a failed one: helm-controller's message, its Job with logs, the Secrets of its values, its values kept from the extension", async () => {
    await open(fx("chartFailed"), "k3s");
    expect(root.querySelector(".k3s-note--danger")?.textContent).toBe("Job has reached configured number of retries without succeeding");
    expect(statusOf("Failed")?.className).toContain("sx-status--danger");
    expect(statusOf("Failed")?.getAttribute("title")).toBe("Job has reached configured number of retries without succeeding");
    // The repository without its credentials, the target namespace and the Secrets as links.
    expect(text()).toContain("https://charts.example.com/stable");
    expect(byLabel("Open Namespace apps")).toHaveLength(1);
    expect(byLabel("Open Secret chart-repo-auth")).toHaveLength(1);
    expect(byLabel("Open Secret my-app-values")).toHaveLength(1);
    // The Jobs of the chart by its label in its namespace, and its HelmChartConfig by name.
    await expect.poll(() => watchOf("Job")).toBeDefined();
    expect(watchParams(watchOf("Job")!)).toMatchObject({ namespaces: ["kube-system"], labelSelector: "helmcharts.helm.cattle.io/chart=my-app", maxObjects: MAX_CHART_JOBS });
    expect(watchParams(watchOf("HelmChartConfig")!)).toMatchObject({ namespaces: ["kube-system"], fieldSelector: "metadata.name=my-app", maxObjects: 1 });
    expect(text()).toContain("Loading…");
    watchOf("Job")!.emit(snapshot([fx("jobFailed")]));
    watchOf("HelmChartConfig")!.emit(snapshot([]));
    await expect.poll(() => byLabel("Open Job helm-install-my-app")).toHaveLength(1);
    expect(statusOf("Failed")).toBeDefined();
    expect(text()).toContain("Failed Pods6");
    expect(byLabel("Open HelmChartConfig my-app")).toHaveLength(0);
    // "Logs": the merged tab of the pods the chart label picks, titled with the Job's name.
    const logs = [...root.querySelectorAll("button")].find((b) => b.textContent === "Logs")!;
    logs.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openLogs")?.params).toEqual({
      namespace: "kube-system",
      labelSelector: "helmcharts.helm.cattle.io/chart=my-app",
      title: "helm-install-my-app",
    });
    // The built-in button's icon.
    expect(host.calls.some((c) => c.method === "ui.icon" && (c.params as { name: string }).name === "logs")).toBe(true);
    // Sextant gives valuesContent and set masked: the masked values, folded, as the built-in view showed them.
    expect([...root.querySelectorAll("details summary")].map((s) => s.textContent)).toEqual(["Show valuesContent", "Show the set values"]);
    for (const secret of SECRETS) expect(text()).not.toContain(secret);
  });

  it("masks the values as the built-in view did, the same from Sextant's masked copy as from the values themselves", async () => {
    const chart = fx("chartFailed");
    (chart.spec as Record<string, unknown>).values = { token: "k3s-pass", replicas: 3 };
    const shownOf = async (raw: boolean) => {
      await open(chart, "k3s", { raw });
      const out = {
        summaries: [...root.querySelectorAll("details summary")].map((s) => s.textContent),
        pres: [...root.querySelectorAll("details pre")].map((p) => p.textContent ?? ""),
        text: text(),
      };
      stop();
      host.close();
      root.remove();
      return out;
    };
    const given = await shownOf(false);
    const raw = await shownOf(true);
    expect(given.summaries).toEqual(["Show valuesContent", "Show values", "Show the set values"]);
    expect(given.pres[0]).toContain("apiToken: <hidden>");
    expect(given.pres[1]).toContain("token: <hidden>");
    expect(given.pres[2]).toBe("auth.password=<hidden>\ningress.enabled=true");
    expect(given.pres).toEqual(raw.pres);
    for (const secret of SECRETS) expect(given.text).not.toContain(secret);
    await open(chart, "k3s");
  });

  it("says the values cannot be read where Sextant could not read them safely", async () => {
    const chart = fx("chartFailed");
    (chart.spec as Record<string, unknown>).valuesContent = "a: [1, 2\nb: c\n";
    (chart.spec as Record<string, unknown>).set = "a=b";
    await open(chart, "k3s");
    expect(text()).toContain("The values are not shown: they cannot be read as YAML safely.");
    expect(text()).not.toContain("Show valuesContent");
    expect(text()).not.toContain("Show the set values");
  });

  it("a deployed one: its Job complete, the Addon that deployed it, its HelmChartConfig", async () => {
    await open(fx("chartTraefik"), "k3s");
    expect(text()).toContain("helm-controller created the install Job");
    await expect.poll(() => watchOf("Job")).toBeDefined();
    watchOf("Job")!.emit(snapshot([fx("jobTraefik")]));
    watchOf("HelmChartConfig")!.emit(snapshot([fx("chartConfigTraefik")]));
    await expect.poll(() => statusOf("Deployed")?.className).toContain("sx-status--success");
    expect(statusOf("Complete")?.className).toContain("sx-status--success");
    expect(byLabel("Open Addon traefik")).toHaveLength(1);
    expect(byLabel("Open HelmChartConfig traefik")).toHaveLength(1);
    expect(text()).toContain("Deployed from the server's manifests directory (Addon traefik)");
    expect(text()).not.toContain("helm-controller created the install Job");
  });

  it("a retrying one, and one whose Jobs cannot be read", async () => {
    await open(fx("chartRetrying"), "k3s");
    await expect.poll(() => watchOf("Job")).toBeDefined();
    watchOf("Job")!.emit(snapshot([fx("jobRetrying")]));
    await expect.poll(() => root.querySelector(".k3s-note--warning")?.textContent).toContain("keeps failing");
    expect(statusOf("Retrying")?.className).toContain("sx-status--warning");
    stop();
    host.close();
    root.remove();
    await open(fx("chartRetrying"), "k3s");
    await expect.poll(() => watchOf("Job")).toBeDefined();
    watchOf("Job")!.emit({ type: "error", message: "forbidden" } as unknown as WatchUpdate);
    await expect.poll(() => text()).toContain("The Jobs cannot be read.");
    expect(text()).toContain("No Job helm-install-rke2-ingress-nginx is listed.");
  });

  it("opens and closes its blocks in Sextant's memory", async () => {
    await open(fx("chartFailed"), "k3s", { blocks: { values: false } });
    expect(toggle("values").getAttribute("aria-expanded")).toBe("false");
    expect(toggle("job").getAttribute("aria-expanded")).toBe("true");
    toggle("job").click();
    await expect.poll(() => remembered.job).toBe(false);
    await expect.poll(() => toggle("job").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a HelmChartConfig", () => {
  it("the HelmChart it overrides, or a note when there is none", async () => {
    await open(fx("chartConfigTraefik"), "k3s");
    await expect.poll(() => watchOf("HelmChart")).toBeDefined();
    expect(watchParams(watchOf("HelmChart")!)).toMatchObject({ namespaces: ["kube-system"], fieldSelector: "metadata.name=traefik", maxObjects: 1 });
    watchOf("HelmChart")!.emit(snapshot([fx("chartTraefik")]));
    await expect.poll(() => byLabel("Open HelmChart traefik")).toHaveLength(1);
    expect(text()).toContain("overrides the values of the HelmChart of the same name");
    expect([...root.querySelectorAll("details pre")][0]?.textContent).toContain("log.level=DEBUG");
    stop();
    host.close();
    root.remove();
    await open(fx("chartConfigOrphan"), "k3s");
    await expect.poll(() => watchOf("HelmChart")).toBeDefined();
    watchOf("HelmChart")!.emit(snapshot([]));
    await expect.poll(() => root.querySelector(".k3s-note--warning")?.textContent).toBe(
      "There is no HelmChart rke2-canal in kube-system: this HelmChartConfig overrides nothing now.",
    );
  });

  it("a set it is given, masked; no values at all", async () => {
    const config = fx("chartConfigTraefik");
    (config.spec as Record<string, unknown>) = { set: { "auth.password": "inline-pass", replicas: 2 } };
    await open(config, "k3s");
    expect([...root.querySelectorAll("details pre")].map((p) => p.textContent)).toEqual(["auth.password=<hidden>\nreplicas=2"]);
    stop();
    host.close();
    root.remove();
    const none = fx("chartConfigTraefik");
    delete none.spec;
    await open(none, "k3s");
    expect(text()).toContain("No values are set here.");
  });
});

describe("Addons and etcd snapshots", () => {
  it("an Addon's manifest and checksum", async () => {
    await open(fx("addonCoredns"), "k3s");
    expect(text()).toContain("/var/lib/rancher/k3s/server/manifests/coredns.yaml");
    expect(text()).toContain("6b3a1d8f0e9c7b5a4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e");
    expect(text()).toContain("A manifest it cannot apply is reported as a Warning event of this Addon.");
  });

  it("a snapshot that failed to upload, and one that is ready", async () => {
    await open(fx("snapshotS3Failed"), "k3s");
    expect(root.querySelector(".k3s-note--danger")?.textContent).toContain("failed to upload snapshot");
    expect(text()).toContain("k3s-backups");
    expect(statusOf("Failed")?.className).toContain("sx-status--danger");
    stop();
    host.close();
    root.remove();
    await open(fx("snapshotLocal"), "k3s");
    expect(statusOf("Ready")?.className).toContain("sx-status--success");
    expect(text()).toContain("12.0MiB");
    expect(byLabel("Open Node k3s-server-1")).toHaveLength(1);
    expect(root.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-01T12:00:03Z");
  });
});

describe("a Node", () => {
  it("a k3s server: role, version, what told it, and its arguments as Sextant masks them", async () => {
    await open(fx("nodeK3sServer"), "k3s-node");
    expect(hiddenCalls).toEqual([false]);
    expect(root.querySelector('[data-block="distribution"]')?.getAttribute("aria-label")).toBe("k3s");
    expect(text()).toContain("v1.33.4+k3s1");
    expect(text()).toContain("Server");
    expect(text()).toContain("kubelet version");
    expect(text()).toContain("k3s-server-1-6d1f4a2b");
    expect(toggle("args").textContent).toBe("Arguments");
    expect(rows().find((r) => r[0] === "--token")).toEqual(["--token", "hidden"]);
    expect(rows().filter((r) => r[1] === "hidden")).toHaveLength(3);
    for (const secret of SECRETS) expect(text()).not.toContain(secret);
  });

  it("a node whose arguments Sextant could not read, and an agent whose role only its arguments tell", async () => {
    const odd = fx("nodeK3sServer");
    (odd.metadata.annotations as Record<string, string>)["k3s.io/node-args"] = "server --token x";
    await open(odd, "k3s-node");
    expect(text()).toContain("The arguments cannot be read.");
    stop();
    host.close();
    root.remove();
    // A server without the control-plane label: its first argument `server` tells it, as the built-in view read it.
    const server = fx("nodeK3sServer");
    delete (server.metadata.labels as Record<string, string>)["node-role.kubernetes.io/control-plane"];
    delete (server.metadata.labels as Record<string, string>)["node-role.kubernetes.io/etcd"];
    await open(server, "k3s-node");
    expect(text()).toContain("Server");
    expect(text()).not.toContain("Agent");
  });

  it("masks arguments it is given as the built-in view did", async () => {
    await open(fx("nodeK3sServer"), "k3s-node", { raw: true });
    expect(rows().find((r) => r[0] === "--token")).toEqual(["--token", "hidden"]);
    expect(rows().filter((r) => r[1] === "hidden")).toHaveLength(3);
    expect(rows().find((r) => r[0] === "--tls-san")).toEqual(["--tls-san", "k3s.example.com"]);
    expect(text()).toContain("The values of tokens, keys, passwords and datastore addresses are never shown.");
    for (const secret of SECRETS) expect(text()).not.toContain(secret);
  });

  it("an RKE2 server in Russian; a node that tells no distribution hides the section", async () => {
    await open(fx("nodeRke2"), "k3s-node", { language: "ru" });
    expect(root.querySelector('[data-block="distribution"]')?.getAttribute("aria-label")).toBe("RKE2");
    expect(text()).toContain("Аргументы");
    stop();
    host.close();
    root.remove();
    await open(fx("nodePlain"), "k3s-node");
    expect(hiddenCalls).toEqual([true]);
    expect(root.children).toHaveLength(0);
  });
});

describe("the Distribution page", () => {
  async function openPage(services: (refs: { namespace: string; name: string }[]) => unknown) {
    host = await startTestHost({
      context: { view: "page", contribution: "distribution", language: "en" },
      handlers: {
        "resources.watch": () => null,
        "resources.getMany": ({ refs }: { refs: { namespace: string; name: string }[] }) => services(refs),
      },
    });
    setLanguage("en");
    root = document.createElement("main");
    document.body.append(root);
    stop = startPage(host.sextant, root);
    await expect.poll(() => host.watches.length).toBe(6);
  }

  it("watches its lists capped as the built-in page did, and shows the distribution, the components and ServiceLB", async () => {
    await openPage((refs) => ({ items: refs.map((r) => (r.name === "traefik" ? { object: fx("svcTraefik") } : { error: { code: "notFound", message: "" } })) }));
    expect(host.watches.map((w) => watchParams(w))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: expect.objectContaining({ kind: "Node" }), maxObjects: MAX_NODES }),
        expect.objectContaining({ kind: expect.objectContaining({ kind: "Addon" }), namespaces: ["kube-system"], maxObjects: MAX_ADDONS }),
        expect.objectContaining({ kind: expect.objectContaining({ kind: "HelmChart" }), maxObjects: MAX_CHARTS }),
        expect.objectContaining({ kind: expect.objectContaining({ kind: "Job" }), labelSelector: "helmcharts.helm.cattle.io/chart", maxObjects: MAX_JOBS }),
        expect.objectContaining({ kind: expect.objectContaining({ kind: "Deployment" }), namespaces: ["kube-system"], maxObjects: MAX_KUBE_SYSTEM }),
        expect.objectContaining({ kind: expect.objectContaining({ kind: "DaemonSet" }), namespaces: ["kube-system"], maxObjects: MAX_KUBE_SYSTEM }),
      ]),
    );
    expect(text()).toContain("Loading…");
    watchOf("Node")!.emit(snapshot([asSextantGivesIt(fx("nodeK3sServer")), asSextantGivesIt(fx("nodeK3sAgent"))]));
    watchOf("Deployment")!.emit(snapshot([fx("deployCoredns"), fx("deployTraefik"), fx("deployLocalPath")]));
    watchOf("DaemonSet")!.emit(snapshot([fx("dsSvclb"), fx("dsOther")]));
    watchOf("Addon")!.emit(snapshot([fx("addonCoredns"), fx("addonTraefik")]));
    watchOf("HelmChart")!.emit(snapshot([asSextantGivesIt(fx("chartTraefik"))]));
    watchOf("Job")!.emit(snapshot([fx("jobTraefik")]));
    await expect.poll(() => text()).toContain("Servers: 1, agents: 1");
    expect(text()).not.toContain("Loading…");
    expect(text()).toContain("Embedded etcd");
    expect(text()).toContain("2 of 2 nodes");
    expect(rows().find((r) => r[0] === "k3s-server-1")).toEqual(["k3s-server-1", "k3s", "v1.33.4+k3s1", "Server", "control planeetcd"]);
    expect(rows().find((r) => r[0] === "CoreDNS")?.[1]).toBe("Ready");
    expect(text()).toContain("Not found (disabled with --disable metrics-server?)");
    expect(statusOf("0 of 1 available")?.className).toContain("sx-status--warning");
    expect(byLabel("Open Addon coredns")).toHaveLength(1);
    expect(byLabel("Open HelmChart traefik")).toHaveLength(1);
    await expect.poll(() => text()).toContain("10.0.0.21");
    expect(host.calls.find((c) => c.method === "resources.getMany")?.params).toMatchObject({ refs: [{ kind: { kind: "Service" }, namespace: "kube-system", name: "traefik" }] });
    expect(byLabel("Open Service traefik")).toHaveLength(1);
    expect(byLabel("Open Service traefik")[0]!.textContent).toBe("kube-system/traefik");
    // In the components' workloads and in the ServiceLB table, as the built-in page listed it.
    expect(byLabel("Open DaemonSet svclb-traefik-5d3e1c2a")).toHaveLength(2);
  });

  it("says what it cannot read: nodes cut or refused, a Service that cannot be read, no ServiceLB", async () => {
    await openPage((refs) => ({ items: refs.map(() => ({ error: { code: "forbidden", message: "no" } })) }));
    watchOf("Node")!.emit({ type: "capped", total: MAX_NODES + 5 } as unknown as WatchUpdate);
    watchOf("Node")!.emit(snapshot([fx("nodeRke2")]));
    for (const kind of ["Deployment", "Addon", "Job"]) watchOf(kind)!.emit(snapshot([]));
    watchOf("HelmChart")!.emit(snapshot([]));
    watchOf("DaemonSet")!.emit(snapshot([fx("dsSvclb")]));
    await expect.poll(() => text()).toContain(`Only the first ${MAX_NODES} nodes are read.`);
    expect(text()).toContain("The charts RKE2 installs in kube-system.");
    await expect.poll(() => text()).toContain("The Service cannot be read");
    stop();
    host.close();
    root.remove();
    await openPage(() => ({ items: [] }));
    watchOf("Node")!.emit({ type: "error", message: "forbidden" } as unknown as WatchUpdate);
    for (const kind of ["Deployment", "Addon", "Job", "HelmChart", "DaemonSet"]) watchOf(kind)!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("The nodes cannot be read.");
    expect(text()).toContain("No node tells k3s or RKE2");
    expect(text()).toContain("No ServiceLB DaemonSet in kube-system.");
    expect(host.calls.some((c) => c.method === "resources.getMany")).toBe(false);
  });
});
