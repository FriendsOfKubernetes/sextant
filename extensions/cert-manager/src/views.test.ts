// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove them.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import certificateJson from "../fixtures/certificate.json";
import challengesJson from "../fixtures/challenges.json";
import clusterIssuerJson from "../fixtures/clusterissuer.json";
import ordersJson from "../fixtures/orders.json";
import requestsJson from "../fixtures/certificaterequests.json";
import { CHAIN_REQUESTS, EXPIRY_TICK_MS, expiryText, startDetails } from "./details";
import { formatDateTime } from "./dom";
import { setLanguage } from "./i18n";
import { DAY_MS } from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const certificate = () => copy(certificateJson) as unknown as KubeObject;
const requests = () => copy(requestsJson) as unknown as KubeObject[];
const orders = () => copy(ordersJson) as unknown as KubeObject[];
const challenges = () => copy(challengesJson) as unknown as KubeObject[];
const clusterIssuer = () => copy(clusterIssuerJson) as unknown as KubeObject;
const st = (o: KubeObject) => (o as { status: Record<string, unknown> }).status;

/** The Certificate, expiring `days` from now. */
function expiringIn(days: number): KubeObject {
  const cert = certificate();
  st(cert).notAfter = new Date(Date.now() + days * DAY_MS + 3600_000).toISOString();
  return cert;
}

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

const servedKind = (group: string, kind: string, namespaced = true) => ({
  kindRef: { group, version: "v1", kind },
  plural: `${kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});
const ALL_KINDS = [
  servedKind("cert-manager.io", "Certificate"),
  servedKind("cert-manager.io", "CertificateRequest"),
  servedKind("cert-manager.io", "Issuer"),
  servedKind("cert-manager.io", "ClusterIssuer", false),
  servedKind("acme.cert-manager.io", "Order"),
  servedKind("acme.cert-manager.io", "Challenge"),
];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
let remembered: Record<string, boolean> = {};

interface Options {
  contribution?: string;
  language?: string;
  blocks?: Record<string, boolean>;
  kinds?: unknown[] | Error;
}

async function open(obj: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "certmanager", language = "en", blocks = {}, kinds = ALL_KINDS } = options;
  remembered = { ...blocks };
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(obj)], resourceVersion: "1", language, blocks: remembered },
    handlers: {
      "resources.get": () => structuredClone(obj),
      kinds: () => {
        if (kinds instanceof Error) throw kinds;
        return kinds;
      },
      "ui.setBlockOpen": ({ id, open }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: open };
        host.setContext({ blocks: remembered });
      },
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading") === null).toBe(true);
}

afterEach(() => {
  vi.useRealTimers();
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const watchParams = (w: TestWatch) => w.params as { kind: { group: string; kind: string; version?: string }; namespaces?: string[] };
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const statusOf = (pattern: RegExp) => [...root.querySelectorAll(".sx-status")].find((s) => pattern.test(s.textContent ?? ""));
const toggle = (id: string) => root.querySelector<HTMLButtonElement>(`[data-block="${id}"] .sx-block__toggle`);
const fieldValue = (label: string) => {
  const dt = [...root.querySelectorAll("dt")].find((d) => d.textContent === label);
  return dt?.nextElementSibling?.textContent;
};

async function feedChain(): Promise<void> {
  await expect.poll(() => watchOf("Challenge")).toBeDefined();
  watchOf("CertificateRequest")!.emit(snapshot(requests()));
  watchOf("Order")!.emit(snapshot(orders()));
  watchOf("Challenge")!.emit(snapshot(challenges()));
  await expect.poll(() => text()).not.toContain("Loading the chain…");
}

describe("details of a Certificate", () => {
  it("a block titled Certificate: links, names, validity, the last failure in plain words", async () => {
    await open(expiringIn(5));
    expect(toggle("fields")?.textContent).toBe("Certificate");
    expect(text()).toContain("Issuing failed: the certificate request did not complete.");
    expect(byLabel("Open Secret shop-tls")).toHaveLength(1);
    expect(byLabel("Open ClusterIssuer letsencrypt")).toHaveLength(1);
    expect(byLabel("Open ClusterIssuer letsencrypt")[0]!.textContent).toBe("ClusterIssuer/letsencrypt");
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect(statusOf(/5 days left/)?.className).toContain("sx-status--warning");
    expect(fieldValue("Ready")).toBe("True (Ready)");
    expect(statusOf(/True \(Ready\)/)?.className).toContain("sx-status--success");
    expect(fieldValue("Private key")).toBe("ECDSA 256");
    expect(fieldValue("Key rotation")).toBe("Always");
    expect(fieldValue("Revision")).toBe("1");
    expect(fieldValue("CA certificate")).toBeUndefined();
    expect(toggle("lastFailure")?.textContent).toBe("Last failure");
    expect(text()).toContain("(3 failed attempts)");
    expect(text()).toContain('order is in "invalid" state');
    byLabel("Open Secret shop-tls")[0]!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "", version: "v1", kind: "Secret" },
      namespace: "shop",
      name: "shop-tls",
    });
    // Nothing is watched for the fields.
    expect(host.watches).toEqual([]);
  });

  it("expiry: expired, valid, not yet valid; drawn again every minute", async () => {
    const now = Date.parse("2026-10-10T00:00:00Z");
    expect(expiryText("2026-10-09T00:00:00Z", undefined, now)?.textContent).toBe(`Expired ${formatDateTime("2026-10-09T00:00:00Z")}`);
    expect(expiryText("2026-12-01T00:00:00Z", undefined, now)?.className).toContain("sx-status--success");
    const notYet = expiryText("2026-12-01T00:00:00Z", "2026-11-01T00:00:00Z", now)!;
    expect(notYet.textContent).toBe(`Not valid yet (from ${formatDateTime("2026-11-01T00:00:00Z")})`);
    expect(notYet.className).toContain("sx-status--warning");
    expect(expiryText("2026-10-11T00:00:00Z", undefined, now)?.textContent).toBe(`${formatDateTime("2026-10-11T00:00:00Z")} (1 day left)`);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const cert = certificate();
    st(cert).notAfter = new Date(Date.now() + 30_000).toISOString();
    await open(cert);
    expect(statusOf(/0 days left/)).toBeDefined();
    vi.advanceTimersByTime(EXPIRY_TICK_MS);
    await expect.poll(() => statusOf(/^Expired /)?.className).toContain("sx-status--danger");
  });

  it("the chain: the newest requests, their orders and challenges, from the namespace's lists while open", async () => {
    await open(expiringIn(5), { contribution: "chain" });
    expect(toggle("chain")?.textContent).toBe("Issuance chain");
    await expect.poll(() => watchOf("Challenge")).toBeDefined();
    for (const kind of ["CertificateRequest", "Order", "Challenge"]) expect(watchParams(watchOf(kind)!).namespaces).toEqual(["shop"]);
    expect(watchOf("CertificateRequest")!.params).toMatchObject({ kind: { group: "cert-manager.io", version: "v1", kind: "CertificateRequest" } });
    expect(text()).toContain("Loading the chain…");
    await feedChain();
    expect(byLabel("Open CertificateRequest shop-2")).toHaveLength(1);
    expect(byLabel("Open CertificateRequest shop-1")).toHaveLength(1);
    expect(byLabel("Open CertificateRequest other-1")).toHaveLength(0);
    expect(byLabel("Open Order shop-2-2391")).toHaveLength(1);
    expect(byLabel("Open Challenge shop-2-2391-111")).toHaveLength(1);
    expect(statusOf(/^invalid$/)?.className).toContain("sx-status--danger");
    expect(root.querySelector("[aria-current='true'] > .cm-chain__row")?.textContent).toContain("shop");
    // Closing the block stops the watches; opening it starts them again.
    toggle("chain")!.click();
    await expect.poll(() => watchOf("CertificateRequest")).toBeUndefined();
    expect(remembered).toEqual({ chain: false });
    toggle("chain")!.click();
    await expect.poll(() => watchOf("CertificateRequest")).toBeDefined();
  });

  it("the chain: the newest few requests, and always the one the opened object belongs to", async () => {
    const many = Array.from({ length: CHAIN_REQUESTS + 2 }, (_, i) => {
      const r = requests()[0]!;
      r.metadata.name = `shop-r${i + 1}`;
      r.metadata.uid = `r-${i + 1}`;
      (r.metadata.annotations as Record<string, string>)["cert-manager.io/certificate-revision"] = String(i + 1);
      return r;
    });
    await open(many[0]!, { contribution: "chain" });
    await expect.poll(() => watchOf("Challenge")).toBeDefined();
    watchOf("CertificateRequest")!.emit(snapshot(many));
    watchOf("Order")!.emit(snapshot([]));
    watchOf("Challenge")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("1 older request is not shown.");
    expect(root.querySelector("[aria-current='true']")?.textContent).toContain("shop-r1");
    expect(byLabel("Open Certificate shop")).toHaveLength(1);
  });

  it("the chain: requests of the same revision and time in the order the watch gave them, as the built-in chain", async () => {
    const tied = (name: string, uid: string) => {
      const r = requests()[0]!;
      r.metadata.name = name;
      r.metadata.uid = uid;
      return r;
    };
    await open(expiringIn(5), { contribution: "chain" });
    await expect.poll(() => watchOf("Challenge")).toBeDefined();
    watchOf("CertificateRequest")!.emit(snapshot([tied("shop-b", "b"), tied("shop-a", "a")]));
    watchOf("Order")!.emit(snapshot([]));
    watchOf("Challenge")!.emit(snapshot([]));
    const shown = () => [...root.querySelectorAll(".cm-chain ul > li > .cm-chain__row button")].map((b) => b.textContent);
    await expect.poll(shown).toEqual(["shop-b", "shop-a"]);
    // A new one comes last, a changed one stays where it was.
    watchOf("CertificateRequest")!.emit({ type: "delta", upserted: [tied("shop-0", "z"), tied("shop-b", "b")] as never, deleted: [] });
    await expect.poll(shown).toEqual(["shop-b", "shop-a", "shop-0"]);
    watchOf("CertificateRequest")!.emit({ type: "delta", upserted: [], deleted: ["a"] });
    await expect.poll(shown).toEqual(["shop-b", "shop-0"]);
  });

  it("warns by the user's warning days Sextant sends, and again when they change", async () => {
    await open(expiringIn(40));
    expect(statusOf(/40 days left/)?.className).toContain("sx-status--success");
    host.setContext({ certExpiryDays: 60 });
    await expect.poll(() => statusOf(/40 days left/)?.className).toContain("sx-status--warning");
    host.setContext({ certExpiryDays: 30 });
    await expect.poll(() => statusOf(/40 days left/)?.className).toContain("sx-status--success");
  });

  it("the chain without the ACME kinds, or without discovery", async () => {
    await open(expiringIn(5), { contribution: "chain", kinds: ALL_KINDS.slice(0, 4) });
    await expect.poll(() => watchOf("CertificateRequest")).toBeDefined();
    expect(watchOf("Order")).toBeUndefined();
    watchOf("CertificateRequest")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("No certificate requests yet.");
    stop();
    host.close();
    root.remove();
    await open(expiringIn(5), { contribution: "chain", kinds: new Error("discovery failed") });
    await expect.poll(() => text()).toContain("No certificate requests yet.");
    expect(host.watches).toEqual([]);
  });
});

describe("details of other kinds", () => {
  it("a Challenge: why the HTTP-01 check fails, and marked in its chain", async () => {
    await open(challenges()[0]!);
    expect(toggle("fields")?.textContent).toBe("Challenge");
    expect(text()).toContain("got HTTP 404 instead of 200");
    expect(byLabel("Open Order shop-2-2391")).toHaveLength(1);
    expect(fieldValue("Presented")).toBe("Yes");
    expect(fieldValue("Wildcard")).toBeUndefined();
    stop();
    host.close();
    root.remove();
    await open(challenges()[0]!, { contribution: "chain" });
    await feedChain();
    expect(root.querySelector("[aria-current='true']")?.textContent).toContain("shop-2-2391-111");
    expect(byLabel("Open Certificate shop")).toHaveLength(1);
  });

  it("an Order whose request is not listed: no known Certificate", async () => {
    await open(orders()[0]!, { contribution: "chain" });
    await expect.poll(() => watchOf("Challenge")).toBeDefined();
    watchOf("CertificateRequest")!.emit(snapshot([]));
    watchOf("Order")!.emit(snapshot(orders()));
    watchOf("Challenge")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("This object does not belong to a known Certificate.");
  });

  it("a ClusterIssuer: type, ACME server, solvers and the registration failure in plain words", async () => {
    await open(clusterIssuer());
    expect(toggle("fields")?.textContent).toBe("ClusterIssuer");
    expect(fieldValue("Type")).toBe("ACME");
    expect(fieldValue("ACME server")).toBe("https://acme-v02.api.letsencrypt.org/directory");
    expect(text()).toContain("The ACME account could not be registered");
    expect([...root.querySelectorAll(".sx-chip")].map((c) => c.textContent)).toEqual(["HTTP-01", "DNS-01"]);
    expect(statusOf(/False \(ErrRegisterACMEAccount\)/)?.className).toContain("sx-status--danger");
  });

  it("a CertificateRequest: approval, its Certificate and issuer, and an Issuer of no cert-manager group as text", async () => {
    const denied = requests()[2]!;
    await open(denied);
    expect(statusOf(/^Denied$/)?.className).toContain("sx-status--danger");
    expect(text()).toContain("An approver denied this request");
    expect(byLabel("Open Certificate other")).toHaveLength(1);
    expect(byLabel("Open Issuer selfsigned")[0]?.textContent).toBe("Issuer/selfsigned");
    stop();
    host.close();
    root.remove();
    const external = requests()[1]!;
    (external.spec as Record<string, unknown>).issuerRef = { name: "pca", kind: "AWSPCAIssuer", group: "awspca.cert-manager.io" };
    await open(external);
    expect(fieldValue("Issuer")).toBe("AWSPCAIssuer/pca (awspca.cert-manager.io)");
    expect(fieldValue("Failed at")).toBe(formatDateTime("2026-10-01T00:05:00Z"));
    expect(text()).toContain("The issuer failed to sign the request.");
  });

  it("keeps its blocks in Sextant's memory and follows Collapse all", async () => {
    await open(expiringIn(5), { blocks: { lastFailure: false } });
    expect(toggle("lastFailure")?.getAttribute("aria-expanded")).toBe("false");
    toggle("fields")!.click();
    await expect.poll(() => remembered).toEqual({ lastFailure: false, fields: false });
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => toggle("lastFailure")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("speaks the UI language", async () => {
    await open(expiringIn(5), { language: "de" });
    expect(text()).toContain("Letzter Fehler");
  });
});
