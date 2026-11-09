// The details section, driven through the SDK's stand-in for Sextant's window, as the built-in section's tests drove it.
import { SextantError, type KubeObject, type WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import clusterSecretStoreJson from "../fixtures/clustersecretstore.json";
import externalSecretJson from "../fixtures/externalsecret.json";
import pushSecretJson from "../fixtures/pushsecret.json";
import { startDetails, storeSpec } from "./details";
import { setLanguage } from "./i18n";

const externalSecret = externalSecretJson as unknown as KubeObject;
const clusterSecretStore = clusterSecretStoreJson as unknown as KubeObject;
const pushSecret = pushSecretJson as unknown as KubeObject;
const clusterExternalSecret = {
  apiVersion: "external-secrets.io/v1",
  kind: "ClusterExternalSecret",
  metadata: { name: "everywhere", uid: "ces-1" },
  spec: { externalSecretName: "shared", refreshTime: "1m" },
  status: {
    provisionedNamespaces: ["shop", "billing"],
    failedNamespaces: [{ namespace: "legacy", reason: "namespace is terminating" }],
    conditions: [{ type: "Ready", status: "False", reason: "PartiallyReady", message: "one namespace failed" }],
  },
} as unknown as KubeObject;

const ref = (o: KubeObject) => ({
  kind: { group: "external-secrets.io", version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, options: TestHostOptions = {}) {
  host = await startTestHost({
    ...options,
    context: { view: "details", contribution: "external-secrets", selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: { "resources.get": () => structuredClone(obj), ...options.handlers },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "external-secrets");
  await expect.poll(() => root.querySelector(".sx-fields")).not.toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const fields = (within: ParentNode = root) =>
  Object.fromEntries([...within.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
const links = () => [...root.querySelectorAll<HTMLButtonElement>("button.sx-link")];
const blocks = () => [...root.querySelectorAll("section.sx-block")].map((b) => b.getAttribute("aria-label"));
const live = () => host.watches.filter((w) => !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items }) as unknown as WatchUpdate;
const storeWatch = async (): Promise<TestWatch> => {
  await expect.poll(() => live().length).toBe(1);
  return live()[0]!;
};

describe("an ExternalSecret's details", () => {
  it("its state, store with the store's own state, target Secret as a link, refresh, the last error and the keys by name", async () => {
    await open(externalSecret);
    expect(fields()).toMatchObject({
      Status: "Failed",
      Store: "ClusterSecretStore/vault-backend",
      "Store status": "Loading…",
      "Target Secret": "secret-to-be-created",
      "Creation policy": "Owner",
      "Refresh interval": "1h",
    });
    expect(Object.keys(fields())).toContain("Last sync");
    expect(root.querySelector(".sx-status--danger")?.getAttribute("title")).toBe("SecretSyncedError: could not get secret data from provider");
    expect(blocks()).toEqual(["Last error", "Keys"]);
    expect(root.querySelector(".eso-message")?.textContent).toBe("could not get secret data from provider");
    expect(text()).toContain("Only the names of the keys are shown, never their values.");
    expect([...root.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["username", "provider-key", "username"],
      ["password", "provider-key", "password"],
    ]);
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["Every property of remote-key-in-the-provider"]);
  });

  it("watches its store by name while open and says whether it is ready, missing or not there to tell", async () => {
    await open(externalSecret);
    const watch = await storeWatch();
    expect(watch.params).toMatchObject({ kind: { group: "external-secrets.io", kind: "ClusterSecretStore" }, fieldSelector: "metadata.name=vault-backend" });
    expect((watch.params as { namespaces?: string[] }).namespaces).toBeUndefined();
    watch.emit(snapshot([clusterSecretStore]));
    await expect.poll(() => fields()["Store status"]).toBe("Failed");
    watch.emit(snapshot([]));
    await expect.poll(() => fields()["Store status"]).toBe("Store not found");
    stop();
    expect(live()).toHaveLength(0);
  });

  it("a namespaced store is watched in the ExternalSecret's namespace; a refused list reads as not found", async () => {
    const es = structuredClone(externalSecret);
    (es.spec as Record<string, unknown>).secretStoreRef = { name: "aws" };
    expect(storeSpec(es)).toEqual({ kind: { group: "external-secrets.io", kind: "SecretStore" }, namespaces: ["shop"], fieldSelector: "metadata.name=aws" });
    await open(es);
    expect(fields().Store).toBe("SecretStore/aws");
    const watch = await storeWatch();
    watch.emit({ type: "forbidden", message: "no" } as unknown as WatchUpdate);
    await expect.poll(() => fields()["Store status"]).toBe("Store not found");
  });

  it("leaves the store's state out where the cluster does not serve the store's kind", async () => {
    await open(externalSecret, {
      handlers: {
        "resources.watch": () => {
          throw new SextantError("notFound", "the cluster does not serve ClusterSecretStore");
        },
      },
    });
    await expect.poll(() => fields()["Store status"]).toBeUndefined();
    expect(fields().Store).toBe("ClusterSecretStore/vault-backend");
  });

  it("links the store and the target Secret, never reading the Secret", async () => {
    const calls: unknown[] = [];
    await open(externalSecret, { handlers: { "ui.openDetails": (params) => void calls.push(params) } });
    for (const l of links()) l.click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls).toEqual([
      { kind: { group: "external-secrets.io", version: "v1", kind: "ClusterSecretStore" }, namespace: null, name: "vault-backend" },
      { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "shop", name: "secret-to-be-created" },
    ]);
    expect(host.calls.filter((c) => c.method === "resources.get").map((c) => (c.params as { ref: { kind: { kind: string } } }).ref.kind.kind)).toEqual(["ExternalSecret"]);
    expect(host.calls.some((c) => c.method.startsWith("secrets."))).toBe(false);
  });

  it("says a refresh interval of 0 means fetched once, and the bulk keys in words", async () => {
    const es = structuredClone(externalSecret);
    const spec = es.spec as Record<string, unknown>;
    spec.refreshInterval = "0";
    spec.data = [];
    spec.dataFrom = [{ find: { name: { regexp: "^db-" } } }, { find: { tags: { env: "prod" } } }, { find: {} }, { sourceRef: { generatorRef: { name: "pw" } } }, {}];
    await open(es);
    expect(fields()["Refresh interval"]).toBe("Fetched once (interval 0)");
    expect(root.querySelector("table")).toBeNull();
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual([
      "Keys found by ^db-",
      "Keys found by env=prod",
      "Every key of the store",
      "Generated by pw",
      "Another source",
    ]);
  });
});

describe("the other kinds' details", () => {
  it("a ClusterExternalSecret: its name, refresh, the namespaces it reached and the ones it failed in", async () => {
    await open(clusterExternalSecret);
    expect(fields()).toEqual({ Status: "Failed", "ExternalSecret name": "shared", "Refresh interval": "1m", "Created in": "shopbilling" });
    expect(blocks()).toEqual(["Last error", "Failed namespaces"]);
    expect([...root.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual(["legacy", "namespace is terminating"]);
    expect(live()).toHaveLength(0);
  });

  it("a store: its validation with the reason, provider and capabilities", async () => {
    await open(clusterSecretStore);
    expect(fields()).toEqual({ Status: "Failed", Reason: "InvalidProviderConfig", Provider: "vault", Capabilities: "ReadWrite" });
    expect(root.querySelector(".eso-message")?.textContent).toBe("unable to validate store: invalid vault credentials");
  });

  it("a PushSecret: its source Secret and stores as links, refresh, last sync and the pushed keys", async () => {
    const calls: unknown[] = [];
    await open(pushSecret, { handlers: { "ui.openDetails": (params) => void calls.push(params) } });
    expect(fields()).toMatchObject({ Status: "Ready", "Source Secret": "pokedex-credentials", Stores: "SecretStore/aws-parameterstore", "Refresh interval": "10s" });
    expect(blocks()).toEqual(["Pushed keys"]);
    expect([...root.querySelectorAll("tbody td")].map((td) => td.textContent)).toEqual(["best-pokemon", "my-first-parameter", ""]);
    for (const l of links()) l.click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls).toEqual([
      { kind: { group: "", version: "v1", kind: "Secret" }, namespace: "shop", name: "pokedex-credentials" },
      { kind: { group: "external-secrets.io", version: "v1", kind: "SecretStore" }, namespace: "shop", name: "aws-parameterstore" },
    ]);
  });

  it("speaks Sextant's language", async () => {
    setLanguage("ru");
    await open(clusterSecretStore, { context: { language: "ru" } });
    expect(fields()).toMatchObject({ Статус: "Ошибка", Провайдер: "vault" });
  });
});
