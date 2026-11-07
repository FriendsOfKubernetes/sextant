// The details sections and the action windows against a stand-in for Sextant's window (the SDK's test host).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SextantError, type KubeObject, type ObjectRef, type WatchParams } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startAction } from "./actions";
import { startFields } from "./fields";
import { setLanguage, t } from "./i18n";
import { startInventory, startResources, startUsedBy } from "./related";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, `../fixtures/${name}.json`), "utf8")) as KubeObject;
const KUSTOMIZATION = fixture("kustomization");
const RELEASE = fixture("helmrelease");
const GIT = fixture("gitrepository");
const BUCKET = fixture("bucket");
const DEPLOYMENT = fixture("helm-deployment");
const EXTRA = {
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "podinfo-helm-extra", namespace: "sextant-flux", uid: "cm-1", labels: DEPLOYMENT.metadata.labels },
} as KubeObject;
const ALL = [KUSTOMIZATION, RELEASE, GIT, BUCKET, DEPLOYMENT, EXTRA];

const refOf = (obj: KubeObject): ObjectRef => {
  const [group, version] = obj.apiVersion!.includes("/") ? obj.apiVersion!.split("/") : ["", obj.apiVersion!];
  return { kind: { group: group!, version: version!, kind: obj.kind! }, namespace: obj.metadata.namespace ?? null, name: obj.metadata.name };
};

const SERVED = [
  ["source.toolkit.fluxcd.io", "GitRepository"],
  ["source.toolkit.fluxcd.io", "HelmRepository"],
  ["source.toolkit.fluxcd.io", "HelmChart"],
  ["source.toolkit.fluxcd.io", "Bucket"],
  ["kustomize.toolkit.fluxcd.io", "Kustomization"],
  ["helm.toolkit.fluxcd.io", "HelmRelease"],
  ["apps", "Deployment"],
  ["", "ConfigMap"],
  ["", "Service"],
  ["networking.k8s.io", "Ingress"],
].map(([group, kind]) => ({ kindRef: { group: group!, version: "v1", kind: kind! }, plural: "", namespaced: true, verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function start(options: TestHostOptions = {}) {
  host = await startTestHost({
    ...options,
    handlers: {
      kinds: () => SERVED,
      "resources.get": ({ ref }) => ALL.find((o) => o.kind === ref.kind.kind && o.metadata.name === ref.name),
      "resources.patchMany": ({ items }) => ({ items: (items as unknown[]).map(() => ({ object: {} })), sent: (items as unknown[]).length }),
      "ui.setHidden": () => null,
      ...options.handlers,
    },
  });
  root = document.createElement("main");
  document.body.append(root);
}

/** Answers each watch with the fixtures of its kind (and labels). */
function answer(params: WatchParams): KubeObject[] {
  const selector = params.labelSelector?.split(",").map((pair) => pair.split("=") as [string, string]);
  return ALL.filter(
    (o) =>
      o.kind === params.kind.kind &&
      (!params.namespaces || params.namespaces.includes(o.metadata.namespace ?? "")) &&
      (!selector || selector.every(([k, v]) => o.metadata.labels?.[k] === v)),
  );
}
async function answerWatches(count: number, skip: (params: WatchParams) => boolean = () => false) {
  await expect.poll(() => host.watches.length).toBe(count);
  for (const watch of host.watches) {
    const params = watch.params as WatchParams;
    if (!skip(params)) watch.emit({ type: "snapshot", items: answer(params) as never[] });
  }
}
const text = () => root.textContent ?? "";
/** What the frame asked of `ui.setHidden`, in order. */
const hiding = () => host.calls.filter((c) => c.method === "ui.setHidden").map((c) => (c.params as { hidden: boolean }).hidden);

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
  vi.useRealTimers();
});

describe("the Flux section of the details", () => {
  it("shows Ready, the revision, the interval and the source as a link", async () => {
    await start({ context: { view: "details", contribution: "fields", selection: [refOf(KUSTOMIZATION)], resourceVersion: "1" } });
    stop = startFields(host.sextant, root);
    await expect.poll(text).toContain("ReconciliationSucceeded");
    const rows = Object.fromEntries([...root.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(rows.Ready).toBe("True ReconciliationSucceeded");
    expect(rows.Revision).toBe("master@sha1:3e0ff8ae123b710bc91de1315cba0f996a8896c2");
    expect(rows.Interval).toBe("10m");
    expect(rows.Prune).toBe("true");
    expect(rows["Last attempted revision"]).toBeUndefined();
    // Sextant's own look: the UI kit's fields, status word and link.
    expect(root.querySelector("dl.sx-fields")).not.toBeNull();
    expect(root.querySelector(".sx-status--success")?.textContent).toBe("True");
    expect(hiding()).toEqual([false]);
    const source = [...root.querySelectorAll("button.sx-link")].find((b) => b.textContent === "GitRepository podinfo") as HTMLButtonElement;
    source.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "source.toolkit.fluxcd.io", kind: "GitRepository" },
      namespace: "sextant-flux",
      name: "podinfo",
    });
  });

  it("reads the object again when Sextant says it changed, and speaks the UI language", async () => {
    setLanguage("de");
    await start({ context: { view: "details", contribution: "fields", selection: [refOf(BUCKET)], resourceVersion: "1", language: "de" } });
    stop = startFields(host.sextant, root);
    await expect.poll(text).toContain("BucketOperationFailed");
    expect([...root.querySelectorAll("dt")].map((dt) => dt.textContent)).toContain("Endpunkt");
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("False");
    const reads = () => host.calls.filter((c) => c.method === "resources.get").length;
    expect(reads()).toBe(1);
    host.setContext({ resourceVersion: "2" });
    await expect.poll(reads).toBe(2);
  });
});

describe("related objects", () => {
  it("a Kustomization lists what it applied as links", async () => {
    await start({ context: { view: "details", contribution: "inventory", selection: [refOf(KUSTOMIZATION)], resourceVersion: "1" } });
    stop = startInventory(host.sextant, root);
    await expect.poll(() => root.querySelectorAll("tbody tr").length).toBe(3);
    expect([...root.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual([
      "Servicepodinfosextant-flux",
      "Deploymentpodinfosextant-flux",
      "HorizontalPodAutoscalerpodinfosextant-flux",
    ]);
    expect(hiding()).toEqual([false]);
    // A link opens the object in the version its inventory entry names.
    (root.querySelectorAll("tbody button.sx-link")[2] as HTMLButtonElement).click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler" },
      namespace: "sextant-flux",
      name: "podinfo",
    });
  });

  it("a Kustomization that applied nothing hides the section, as the built-in view showed none", async () => {
    const empty = { ...KUSTOMIZATION, metadata: { ...KUSTOMIZATION.metadata, name: "empty" }, status: { ...KUSTOMIZATION.status, inventory: { entries: [] } } };
    await start({
      context: { view: "details", contribution: "inventory", selection: [refOf(empty)], resourceVersion: "1" },
      handlers: { "resources.get": () => empty },
    });
    stop = startInventory(host.sextant, root);
    await expect.poll(hiding).toEqual([true]);
    // Applied something since: shown again.
    host.setContext({ resourceVersion: "2" });
    (empty.status as { inventory: { entries: unknown[] } }).inventory.entries = [{ id: "sextant-flux_podinfo__Service", v: "v1" }];
    await expect.poll(hiding).toEqual([true, false]);
    await expect.poll(() => root.querySelectorAll("tbody tr").length).toBe(1);
  });

  it("a source lists the Kustomizations and HelmReleases that use it, from every namespace", async () => {
    await start({ context: { view: "details", contribution: "used-by", selection: [refOf(GIT)], resourceVersion: "1" } });
    stop = startUsedBy(host.sextant, root);
    await expect.poll(text).toContain(t("related.loading"));
    await answerWatches(2);
    await expect.poll(() => root.querySelectorAll("tbody tr").length).toBe(1);
    expect(root.querySelector("tbody tr")?.textContent).toBe("Kustomizationpodinfosextant-flux");
    expect(host.watches.map((w) => (w.params as WatchParams).namespaces)).toEqual([undefined, undefined]);
  });

  it("a source nobody uses says so; a failed list is shown with Retry, which lists again", async () => {
    await start({ context: { view: "details", contribution: "used-by", selection: [refOf(BUCKET)], resourceVersion: "1" } });
    stop = startUsedBy(host.sextant, root);
    await answerWatches(2, (p) => p.kind.kind === "HelmRelease");
    host.watches[1]!.emit({ type: "error", code: "other", message: "the cluster cannot be reached" });
    await expect.poll(text).toContain("the cluster cannot be reached");
    expect(root.querySelector(".failure .sx-error")?.getAttribute("role")).toBe("alert");
    (root.querySelector(".failure button") as HTMLButtonElement).click();
    await answerWatches(4);
    await expect.poll(text).toContain(t("related.notUsed"));
  });

  it("a HelmRelease lists its inventory and its labelled objects, only in its namespaces, metadata only", async () => {
    await start({ context: { view: "details", contribution: "resources", selection: [refOf(RELEASE)], resourceVersion: "1" } });
    stop = startResources(host.sextant, root);
    // Of the labelled kinds, the four the cluster serves.
    await answerWatches(4, (p) => p.kind.kind === "Ingress");
    for (const watch of host.watches) {
      expect(watch.params).toMatchObject({
        namespaces: ["sextant-flux"],
        labelSelector: "helm.toolkit.fluxcd.io/name=podinfo-helm,helm.toolkit.fluxcd.io/namespace=sextant-flux",
        metadataOnly: true,
      });
    }
    await expect.poll(() => root.querySelectorAll("tbody tr").length).toBe(3);
    // The Deployment is in the inventory already: it is listed once.
    expect([...root.querySelectorAll("tbody tr")].map((tr) => tr.textContent)).toEqual([
      "Servicepodinfo-helmsextant-flux",
      "Deploymentpodinfo-helmsextant-flux",
      "ConfigMappodinfo-helm-extrasextant-flux",
    ]);
    expect(text()).toContain(t("related.loading"));
    host.watches.find((w) => (w.params as WatchParams).kind.kind === "Ingress")!.emit({ type: "error", code: "forbidden", message: "no" });
    await expect.poll(text).toContain(t("related.forbidden", { kind: "Ingress" }));
    expect(text()).not.toContain(t("related.loading"));
  });
});

describe("the headless action", () => {
  type Item = { ref: { kind: { kind: string }; name: string }; patch: unknown; patchType: string };
  /** The `resources.patchMany` calls: one decision each. */
  const batches = () => host.calls.filter((c) => c.method === "resources.patchMany").map((c) => (c.params as { items: Item[] }).items);
  const patches = () => batches().flat();

  it("Reconcile with source sends a HelmRelease's repository, then its HelmChart, then the release, and closes with nothing drawn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-06T10:00:00Z"));
    await start({ context: { view: "action", contribution: "reconcile-with-source", selection: [refOf(RELEASE)] } });
    stop = startAction(host.sextant, root, "reconcile-with-source");
    await expect.poll(() => host.closedByFrame).toBe(true);
    // Out of sight: the frame draws nothing at all.
    expect(root.childNodes).toHaveLength(0);
    expect(batches()).toHaveLength(1);
    expect(host.calls.some((c) => c.method === "resources.patch")).toBe(false);
    expect(patches().map((p) => [`${p.ref.kind.kind}/${p.ref.name}`, p.patchType, p.patch])).toEqual(
      ["HelmRepository/podinfo", "HelmChart/sextant-flux-podinfo-helm", "HelmRelease/podinfo-helm"].map((name) => [
        name,
        "merge",
        { metadata: { annotations: { "reconcile.fluxcd.io/requestedAt": "2026-11-06T10:00:00.000Z" } } },
      ]),
    );
    // Silent, as the built-in action was.
    expect(host.notices).toEqual([]);
  });

  it("a failure stops before the next object, names the one that failed in a notice, and closes", async () => {
    await start({
      context: { view: "action", contribution: "reconcile-with-source", selection: [refOf(KUSTOMIZATION)] },
      handlers: {
        // The GitRepository is refused by the cluster and the Kustomization never sent.
        "resources.patchMany": () => ({ items: [{ error: { code: "forbidden", message: "no" } }], sent: 0 }),
      },
    });
    stop = startAction(host.sextant, root, "reconcile-with-source");
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.notices).toEqual([
      t("reconcileWithSource.failedAt", { kind: "GitRepository", name: "podinfo", message: t("error.forbidden", { message: "no" }) }),
    ]);
    expect(host.notices[0]).toBe("Reconcile with source stopped at GitRepository podinfo: The cluster refused your credentials: no");
    expect(patches().map((p) => `${p.ref.kind.kind}/${p.ref.name}`)).toEqual(["GitRepository/podinfo", "Kustomization/podinfo"]);
    expect(batches()).toHaveLength(1);
    expect(root.childNodes).toHaveLength(0);
  });

  it("an object it cannot read is named in a notice, and nothing is sent", async () => {
    await start({
      context: { view: "action", contribution: "reconcile-with-source", selection: [refOf(KUSTOMIZATION)] },
      handlers: {
        "resources.get": () => {
          throw new SextantError("notFound", "gone");
        },
      },
    });
    stop = startAction(host.sextant, root, "reconcile-with-source");
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.notices).toEqual([t("reconcileWithSource.failedAt", { kind: "Kustomization", name: "podinfo", message: "gone" })]);
    expect(patches()).toEqual([]);
  });

  it("Sextant's refusal of the whole change is told; the user's own refusal closes silently", async () => {
    await start({
      context: { view: "action", contribution: "reconcile-with-source", selection: [refOf(KUSTOMIZATION)] },
      handlers: {
        "resources.patchMany": () => {
          throw new SextantError("denied", "Sextant denied modify on Kustomization sextant-flux/podinfo.");
        },
      },
    });
    stop = startAction(host.sextant, root, "reconcile-with-source");
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.notices).toEqual(["Reconcile with source: Sextant refused: Sextant denied modify on Kustomization sextant-flux/podinfo."]);
    host.close();
    root.remove();

    await start({
      context: { view: "action", contribution: "reconcile-with-source", selection: [refOf(KUSTOMIZATION)] },
      handlers: {
        "resources.patchMany": () => {
          throw new SextantError("denied", "The user declined resources.patchMany on Kustomization sextant-flux/podinfo in cluster kind.", "resources.patchMany", "declined");
        },
      },
    });
    stop = startAction(host.sextant, root, "reconcile-with-source");
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.notices).toEqual([]);
    expect(root.childNodes).toHaveLength(0);
  });

  it("Reconcile now, Suspend and Resume have no frame: Sextant sends their patches itself", async () => {
    for (const contribution of ["reconcile", "suspend", "resume"]) {
      await start({ context: { view: "action", contribution, selection: [refOf(KUSTOMIZATION)] } });
      stop = startAction(host.sextant, root, contribution);
      expect(text()).toContain(t("common.nothingToShow", { view: contribution }));
      expect(patches()).toEqual([]);
      expect(host.closedByFrame).toBe(false);
      root.remove();
      host.close();
    }
  });
});
