// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestHostOptions, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import delegationJson from "../fixtures/delegation.json";
import extensionJson from "../fixtures/extension.json";
import proxiesJson from "../fixtures/proxies.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";
import { MAX_PROXY_ROWS } from "./model";

const proxies = proxiesJson as unknown as KubeObject[];
const [root, blog, orphan, duplicate, fresh] = proxies as [KubeObject, KubeObject, KubeObject, KubeObject, KubeObject];
const delegation = delegationJson as unknown as KubeObject;
const extension = extensionJson as unknown as KubeObject;

const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});
const sectionOf = (o: KubeObject) => manifest.contributes.detailsSections.find((d) => d.kinds[0]!.kind === o.kind)!.id;

const SERVED = [
  ["projectcontour.io", "v1", "HTTPProxy"],
  ["projectcontour.io", "v1", "TLSCertificateDelegation"],
  ["projectcontour.io", "v1alpha1", "ExtensionService"],
] as const;
const kinds = (served: readonly (readonly [string, string, string])[]) =>
  served.map(([group, version, kind]) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root_: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, options: TestHostOptions & { served?: readonly (readonly [string, string, string])[] } = {}): Promise<void> {
  const served = options.served ?? SERVED;
  host = await startTestHost({
    ...options,
    context: { view: "details", contribution: sectionOf(obj), selection: [ref(obj)], resourceVersion: "1", ...options.context },
    handlers: { "resources.get": () => structuredClone(obj), kinds: () => kinds(served), ...options.handlers },
  });
  root_ = document.createElement("main");
  document.body.append(root_);
  stop = startDetails(host.sextant, root_);
  await expect.poll(() => root_.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root_?.remove();
  host?.close();
});

const text = () => root_.textContent ?? "";
const byLabel = (label: string) => [...root_.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { group?: string; version?: string; kind: string }; namespaces?: string[]; maxObjects?: number };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rowsOf = (table: string) => [...root_.querySelectorAll(`[data-table='${table}'] tbody tr`)].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
const callOf = (method: string) => host.calls.filter((c) => c.method === method).at(-1)?.params;
const blockOf = (id: string) => root_.querySelector<HTMLElement>(`[data-block='${id}']`);

describe("details of an HTTPProxy", () => {
  it("of a root: Contour's error, the delegated Secret with its delegation, routes, includes and the tree", async () => {
    await open(root);
    expect(text()).toContain("Contour serves the proxy in part (IncludeNotFound)");
    expect(root_.querySelector(".ct-explain--danger")).not.toBeNull();
    // Contour's description, said apart only when it differs from the first error's message.
    expect(root_.querySelector(".ct-message")?.textContent).toBe("At least one error present, see Errors for details");
    expect(rowsOf("issues")).toEqual([["Error", "IncludeError", "IncludeNotFound", "include marketing/missing-site not found"]]);
    expect(byLabel("Open Secret example-com-wildcard").map((b) => b.textContent)).toEqual(["www-admin/example-com-wildcard"]);
    expect(byLabel("Open ExtensionService authserver")).toHaveLength(1);
    expect(text()).toContain("203.0.113.10");
    expect(text()).toContain("rateLimitPolicy");
    expect(text()).toContain("Looking for the TLSCertificateDelegation…");
    // The delegation of the Secret's namespace.
    await expect.poll(() => watchOf("TLSCertificateDelegation")).toBeDefined();
    expect(watchParams(watchOf("TLSCertificateDelegation")!)).toMatchObject({ kind: { group: "projectcontour.io", version: "v1" }, namespaces: ["www-admin"] });
    watchOf("TLSCertificateDelegation")!.emit(snapshot([structuredClone(delegation)]));
    await expect.poll(() => byLabel("Open TLSCertificateDelegation example-com-wildcard")).toHaveLength(1);
    // Every HTTPProxy of the cluster, capped as the built-in tap was.
    const index = watchOf("HTTPProxy")!;
    expect(watchParams(index)).toEqual({ clusterId: "test-cluster", kind: { group: "projectcontour.io", version: "v1", kind: "HTTPProxy" }, maxObjects: MAX_PROXY_ROWS });
    expect(text()).toContain("Reading the HTTPProxies…");
    index.emit(snapshot(proxies.map((p) => structuredClone(p))));
    await expect.poll(() => text()).toContain("Does not exist: Contour answers 502");
    expect(rowsOf("includes")).toEqual([
      ["marketing/blogsite", "prefix=/blog", "Valid"],
      ["marketing/missing-site", "prefix=/missing", "Does not exist: Contour answers 502"],
    ]);
    expect(byLabel("Open HTTPProxy blogsite")).toHaveLength(2);
    expect([...root_.querySelectorAll(".ct-chain code")].map((c) => c.textContent)).toEqual(["root.bar.com", "/blog", "/missing"]);
    expect(root_.querySelector("[aria-current='true'] strong")?.textContent).toBe("roots/root-blog");
    expect(rowsOf("routes")).toEqual([["1", "prefix=/", "rootapp:80100% of requests", "", ""]]);
  });

  it("of an included proxy: shares and mirror per service, the roots that reach it", async () => {
    await open(blog);
    expect(text()).toContain("a root proxy includes it");
    expect(text()).toContain("90% of requests");
    expect(text()).toContain("Mirror: a copy of 20% of requests");
    expect(text().match(/50% of requests/g)).toHaveLength(2);
    expect(byLabel("Open Service blog-shadow").map((b) => b.textContent)).toEqual(["blog-shadow:80"]);
    expect(rowsOf("routes").map((r) => [r[0], r[1], r[3]])).toEqual([
      ["1", "prefix=/", "timeoutPolicy"],
      ["2", "prefix=/adminheader x-env exact=staging", ""],
    ]);
    // A valid proxy: Contour's description is not repeated.
    expect(root_.querySelector(".ct-message")).toBeNull();
    // No delegated Secret: no delegation is read.
    expect(watchOf("TLSCertificateDelegation")).toBeUndefined();
    await expect.poll(() => watchOf("HTTPProxy")).toBeDefined();
    watchOf("HTTPProxy")!.emit(snapshot(proxies.map((p) => structuredClone(p))));
    await expect.poll(() => byLabel("Open HTTPProxy root-blog")).toHaveLength(1);
    expect(root_.querySelector("[aria-current='true'] strong")?.textContent).toBe("marketing/blogsite");
  });

  it("of an orphan, a duplicate host and a proxy no Contour processed", async () => {
    await open(orphan);
    expect(text()).toContain("No root HTTPProxy includes this proxy, so Contour ignores it");
    await expect.poll(() => watchOf("HTTPProxy")).toBeDefined();
    watchOf("HTTPProxy")!.emit(snapshot(proxies.map((p) => structuredClone(p))));
    await expect.poll(() => text()).toContain("No root HTTPProxy includes this proxy.");
    stop();
    host.close();
    await open(duplicate);
    expect(text()).toContain("Another HTTPProxy uses the same host root.bar.com, so Contour serves neither of them (DuplicateVhost).");
    stop();
    host.close();
    await open(fresh);
    expect(text()).toContain("no Contour serves the ingress class contour-internal");
    expect(root_.querySelector(".sx-status--warning")?.textContent).toBe("Waiting for Contour");
    expect(root_.querySelector(".ct-message")?.textContent).toBe("Waiting for controller");
  });

  it("says when the delegation's kind is not served, the HTTPProxies cannot be read, or are more than it reads", async () => {
    await open(root, { served: [SERVED[0], SERVED[2]] });
    await expect.poll(() => text()).toContain("The cluster does not serve TLSCertificateDelegation.");
    expect(watchOf("TLSCertificateDelegation")).toBeUndefined();
    const index = watchOf("HTTPProxy")!;
    index.emit({ type: "error", kind: "forbidden", message: "no" } as never);
    await expect.poll(() => text()).toContain("The HTTPProxies of the cluster cannot be read, so the delegation tree is not known.");
    stop();
    host.close();
    await open(root);
    await expect.poll(() => watchOf("TLSCertificateDelegation")).toBeDefined();
    watchOf("TLSCertificateDelegation")!.emit({ type: "forbidden", namespaces: ["www-admin"] });
    await expect.poll(() => text()).toContain("The TLSCertificateDelegations of the Secret's namespace cannot be read.");
    watchOf("HTTPProxy")!.emit({ type: "capped", total: MAX_PROXY_ROWS + 1 } as never);
    watchOf("HTTPProxy")!.emit(snapshot(proxies.map((p) => structuredClone(p))));
    await expect.poll(() => text()).toContain("The cluster has more HTTPProxies than Sextant reads at once: the tree may be incomplete.");
  });

  it("names a missing delegation", async () => {
    await open(root);
    await expect.poll(() => watchOf("TLSCertificateDelegation")).toBeDefined();
    watchOf("TLSCertificateDelegation")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("No TLSCertificateDelegation in namespace www-admin lets namespace roots use this Secret.");
  });

  it("of a TCP proxy: its services and its include", async () => {
    const tcp = structuredClone(blog);
    tcp.spec = { virtualhost: { fqdn: "db.example.com", tls: { passthrough: true } }, tcpproxy: { services: [{ name: "db", port: 5432 }], include: { name: "db-backend", namespace: "data" } } };
    await open(tcp);
    expect(blockOf("tcp")?.textContent).toContain("db:5432100% of requests");
    expect(text()).toContain("TLS passthrough");
    expect(rowsOf("includes")).toEqual([["data/db-backend", "TCP proxy", ""]]);
  });
});

describe("details of a TLSCertificateDelegation and an ExtensionService", () => {
  it("of a delegation: each Secret and the namespaces that may use it", async () => {
    await open(delegation);
    expect(text()).toContain("Lets HTTPProxies of the target namespaces use these Secrets");
    expect(rowsOf("delegations")).toEqual([
      ["example-com-wildcard", "roots"],
      ["shared-ca", "All namespaces"],
    ]);
    expect(byLabel("Open Secret example-com-wildcard")).toHaveLength(1);
    expect(host.watches).toHaveLength(0);
  });

  it("of a delegation without Secrets", async () => {
    const none = structuredClone(delegation);
    (none.spec as Record<string, unknown>).delegations = [];
    await open(none);
    expect(text()).toContain("The delegation names no Secrets.");
  });

  it("of an ExtensionService that Contour does not accept", async () => {
    await open(extension);
    expect(text()).toContain("Contour does not accept this extension service (ServiceUnresolvedReference)");
    expect(byLabel("Open Service htpasswd")).toHaveLength(1);
    expect(rowsOf("services")).toEqual([["htpasswd", "9443", ""]]);
    expect(text()).toContain("100ms");
    expect(root_.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(host.watches).toHaveLength(0);
  });

  it("opens a linked object's details", async () => {
    await open(extension);
    byLabel("Open Service htpasswd")[0]!.click();
    await expect.poll(() => callOf("ui.openDetails")).toEqual({ kind: { group: "", version: "v1", kind: "Service" }, namespace: "projectcontour-auth", name: "htpasswd" });
  });
});

describe("the blocks", () => {
  const toggles = () => [...root_.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")];
  const expanded = () => toggles().map((b) => [b.textContent, b.getAttribute("aria-expanded")]);
  /** Sextant's memory: `ui.setBlockOpen` writes it, the context tells it back, as the window does. */
  const remembering = (blocks: Record<string, boolean> = {}): TestHostOptions => ({
    context: { blocks },
    handlers: {
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        blocks = { ...blocks, [id]: open };
        setTimeout(() => host.setContext({ blocks }));
        return null;
      },
    },
  });

  it("are the built-in section's: one titled with the kind, the others inside it", async () => {
    await open(root);
    expect(expanded()).toEqual([
      ["HTTPProxy", "true"],
      ["Contour's errors and warnings", "true"],
      ["Routes", "true"],
      ["Includes", "true"],
      ["Delegation tree", "true"],
    ]);
    for (const id of ["issues", "routes", "includes", "tree"]) expect(blockOf("fields")!.querySelector(`[data-block='${id}']`)).not.toBeNull();
  });

  it("read the HTTPProxies only while the includes or the tree are open, and remember the choice in Sextant", async () => {
    await open(blog, remembering());
    await expect.poll(() => watchOf("HTTPProxy")).toBeDefined();
    // The included proxy has no includes: only the tree needs the list.
    toggles().find((b) => b.textContent === "Delegation tree")!.click();
    await expect.poll(() => watchOf("HTTPProxy")).toBeUndefined();
    expect(host.calls.filter((c) => c.method === "ui.setBlockOpen").map((c) => c.params)).toEqual([{ id: "tree", open: false }]);
    await expect.poll(() => host.sextant.context.blocks).toEqual({ tree: false });
    expect(expanded().at(-1)).toEqual(["Delegation tree", "false"]);
    // The panel's "Expand all".
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => watchOf("HTTPProxy")).toBeDefined();
  });

  it("start closed as remembered, and read nothing while the proxy's own block is closed", async () => {
    await open(root, remembering({ fields: false }));
    expect(expanded()[0]).toEqual(["HTTPProxy", "false"]);
    await Promise.resolve();
    expect(host.watches).toHaveLength(0);
  });
});

describe("the texts", () => {
  it("follow Sextant's language", async () => {
    await open(orphan, { context: { language: "de" } });
    setLanguage("de");
    stop();
    stop = startDetails(host.sextant, root_);
    await expect.poll(() => root_.querySelector(".sx-loading")).toBeNull();
    expect(root_.querySelector(".sx-status--danger")?.textContent).toBe("Verwaist");
  });
});
