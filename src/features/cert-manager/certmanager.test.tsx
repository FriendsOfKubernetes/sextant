import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultAppSettings,
  type AppSettings,
  type KindRef,
  type KubeObject,
  type ObjectRef,
  type ResourceKind,
  type SecretCertificates,
  type TlsExpiryScan,
} from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import certificateJson from "./fixtures/certificate.json";
import challengesJson from "./fixtures/challenges.json";
import clusterIssuerJson from "./fixtures/clusterissuer.json";
import ordersJson from "./fixtures/orders.json";
import requestsJson from "./fixtures/certificaterequests.json";
import tlsSecretJson from "./fixtures/tls-secret.json";
import "./index";
import {
  CERTIFICATE,
  CERTIFICATE_REQUEST,
  CHALLENGE,
  challengesOf,
  clampExpiryDays,
  CLUSTER_ISSUER,
  DAY_MS,
  expiryOf,
  explainCertificate,
  explainChallenge,
  explainIssuer,
  ISSUER,
  issuerRefOf,
  issuerText,
  isProblem,
  ORDER,
  ordersOf,
  requestsOf,
  rootCertificateName,
} from "./model";
import { TlsCertificatesPage } from "./TlsPage";
import { ExpiryText } from "./details";
import { formatDateTime } from "../../i18n";

const certificate = certificateJson as KubeObject;
const requests = requestsJson as KubeObject[];
const orders = ordersJson as KubeObject[];
const challenges = challengesJson as KubeObject[];
const clusterIssuer = clusterIssuerJson as KubeObject;
const tlsSecret = tlsSecretJson as KubeObject;

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const NOW = Date.parse("2026-10-10T00:00:00Z");

/** The Certificate, expiring `days` from now. */
function expiringIn(days: number): KubeObject {
  const cert = copy(certificate);
  (cert.status as Record<string, unknown>).notAfter = new Date(Date.now() + days * DAY_MS + 3600_000).toISOString();
  return cert;
}

describe("the model", () => {
  it("expiry: expired, expiring within the warning days, valid, not yet valid", () => {
    const at = (iso: string) => expiryOf(iso, NOW, 14);
    expect(at("2026-10-09T00:00:00Z")).toEqual({ state: "expired", daysLeft: -1 });
    expect(at("2026-10-20T00:00:00Z")).toEqual({ state: "expiring", daysLeft: 10 });
    expect(at("2026-12-01T00:00:00Z")).toEqual({ state: "valid", daysLeft: 52 });
    expect(expiryOf("2026-12-01T00:00:00Z", NOW, 60)?.state).toBe("expiring");
    expect(expiryOf("2026-12-01T00:00:00Z", NOW, 14, "2026-11-01T00:00:00Z")?.state).toBe("notYetValid");
    expect(expiryOf(undefined, NOW, 14)).toBeUndefined();
    expect(expiryOf("not a date", NOW, 14)).toBeUndefined();
  });

  it("the warning setting stays within 1..365", () => {
    expect(clampExpiryDays(30)).toBe(30);
    expect(clampExpiryDays(0)).toBe(1);
    expect(clampExpiryDays(9999)).toBe(365);
    expect(clampExpiryDays("abc")).toBe(14);
    expect(clampExpiryDays(7.6)).toBe(8);
  });

  it("the chain: requests of a Certificate newest first, their orders and challenges, up from any link", () => {
    expect(requestsOf(certificate, requests).map((r) => r.metadata?.name)).toEqual(["shop-2", "shop-1"]);
    const latest = requests[1]!;
    expect(ordersOf(latest, orders).map((o) => o.metadata?.name)).toEqual(["shop-2-2391"]);
    expect(ordersOf(requests[0]!, orders)).toEqual([]);
    expect(challengesOf(orders[0]!, challenges).map((c) => c.spec)).toHaveLength(2);
    for (const [obj, kind] of [
      [certificate, CERTIFICATE],
      [latest, CERTIFICATE_REQUEST],
      [orders[0]!, ORDER],
      [challenges[0]!, CHALLENGE],
    ] as const) {
      expect(rootCertificateName(obj, kind, requests, orders)).toBe("shop");
    }
    // An Order whose request is not known: no root.
    expect(rootCertificateName(orders[0]!, ORDER, [], orders)).toBeUndefined();
  });

  it("explains failures in plain words", () => {
    expect(explainCertificate(certificate)).toEqual({ key: "certificate.failed" });
    const missing = copy(certificate);
    (missing.status as Record<string, unknown>).conditions = [{ type: "Ready", status: "False", reason: "DoesNotExist" }];
    expect(explainCertificate(missing)).toEqual({ key: "certificate.DoesNotExist", params: { secret: "shop-tls" } });
    expect(explainChallenge(challenges[0]!)).toEqual({
      key: "challenge.httpStatus",
      params: { domain: "www.shop.example.com", code: "404" },
    });
    expect(explainChallenge(challenges[1]!)).toBeUndefined();
    expect(explainIssuer(clusterIssuer)).toEqual({ key: "issuer.ErrRegisterACMEAccount" });
  });

  it("what counts as a problem", () => {
    expect(isProblem(orders[0]!, ORDER)).toBe(true);
    expect(isProblem(challenges[0]!, CHALLENGE)).toBe(false);
    expect(isProblem(requests[1]!, CERTIFICATE_REQUEST)).toBe(true);
    expect(isProblem(requests[2]!, CERTIFICATE_REQUEST)).toBe(true);
    expect(isProblem(requests[0]!, CERTIFICATE_REQUEST)).toBe(false);
    expect(isProblem(clusterIssuer, CLUSTER_ISSUER)).toBe(true);
  });

  it("an empty issuerRef group or kind means cert-manager's Issuer", () => {
    const withRef = (issuerRef: Record<string, string>): KubeObject => ({ spec: { issuerRef } });
    expect(issuerRefOf(withRef({ name: "ca", group: "", kind: "" }))).toEqual({ name: "ca", kind: "Issuer", group: "cert-manager.io" });
    expect(issuerText(issuerRefOf(withRef({ name: "le", kind: "ClusterIssuer" })))).toBe("ClusterIssuer/le");
    expect(issuerRefOf(withRef({ name: "x", kind: "AWSPCAIssuer", group: "awspca.cert-manager.io" }))?.group).toBe("awspca.cert-manager.io");
    // Ready, but its renewal failed (Issuing=False, Failed).
    expect(isProblem(certificate, CERTIFICATE)).toBe(true);
    const fine = copy(certificate);
    (fine.status as Record<string, unknown>).conditions = [{ type: "Ready", status: "True", reason: "Ready" }];
    expect(isProblem(fine, CERTIFICATE)).toBe(false);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural: `${kind.kind.toLowerCase()}s`,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

const BUILT_IN: KindRef[] = [
  { group: "", version: "v1", kind: "Pod" },
  { group: "", version: "v1", kind: "Secret" },
];
const CERT_MANAGER: KindRef[] = [CERTIFICATE, CERTIFICATE_REQUEST, ISSUER, CLUSTER_ISSUER, ORDER, CHALLENGE];

let wb: WatchBackend;
let discovery: KindRef[];
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [...BUILT_IN, ...CERT_MANAGER];
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map((k) => served(k, k.kind !== "ClusterIssuer")));
  wb.backend.on("settings_get", () => structuredClone(stored));
  wb.backend.on("settings_update", (args) => {
    stored = structuredClone(args.settings as AppSettings);
    return structuredClone(stored);
  });
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
});

const sections = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.hasAttribute("aria-expanded"))
    .map((b) => b.textContent);

describe("the cert-manager section", () => {
  it("lists the kinds the cluster serves", async () => {
    discovery = [...BUILT_IN, CERTIFICATE, CERTIFICATE_REQUEST, ISSUER, CLUSTER_ISSUER];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("cert-manager"));
    fireEvent.click(screen.getByRole("button", { name: /cert-manager/ }));
    const section = within(screen.getByRole("button", { name: /cert-manager/ }).closest("li")!);
    for (const label of ["Certificates", "Certificate Requests", "Issuers", "Cluster Issuers"]) {
      expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Without the ACME CRDs, no Orders and Challenges.
    expect(section.queryByRole("button", { name: "Orders" })).toBeNull();
    expect(section.queryByRole("button", { name: "Challenges" })).toBeNull();
  });

  it("is not there without cert-manager", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Config"));
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    expect(sections()).not.toContain("cert-manager");
    // The TLS certificates page is in Config whether cert-manager is there or not.
    fireEvent.click(screen.getByRole("button", { name: /Config/ }));
    expect(screen.getByRole("button", { name: "TLS Certificates" })).toBeInTheDocument();
  });

  it("counts the certificates that need attention on its header", async () => {
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("cert-manager"));
    emitSnapshot(wb, await watchOf(wb, "Certificate"), [expiringIn(3)]);
    await waitFor(() => expect(screen.getByTitle("1 certificate needs attention")).toHaveTextContent("1"));
  });
});

describe("expiry text", () => {
  it("a certificate not valid yet names when it becomes valid", () => {
    const notBefore = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const notAfter = new Date(Date.now() + 90 * DAY_MS).toISOString();
    render(<ExpiryText notAfter={notAfter} notBefore={notBefore} />);
    expect(screen.getByText(`Not valid yet (from ${formatDateTime(notBefore)})`)).toHaveClass("rt-status--warning");
  });
});

describe("the Certificates table", () => {
  it("shows Ready, Secret, issuer and days left colored by the warning setting", () => {
    const def = getResourceDef(CERTIFICATE);
    expect(def.columns.map((c) => c.id)).toEqual(["name", "namespace", "ready", "secret", "issuer", "expires", "status", "age"]);
    const cert = expiringIn(10);
    const col = (id: string) => def.columns.find((c) => c.id === id)!;
    expect(col("secret").value(cert)).toBe("shop-tls");
    expect(col("issuer").value(cert)).toBe("ClusterIssuer/letsencrypt");
    const { container } = render(
      <div>{col("expires").render!(cert, { clusterId: "c1", kind: CERTIFICATE, now: Date.now() }) as ReactElement}</div>,
    );
    expect(container.querySelector(".rt-status--warning")).toHaveTextContent("10 days");
  });
});

// ---------- Details ----------

function refTo(obj: KubeObject): ObjectRef {
  return { kind: kindOf(obj), namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

function section(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-section='${id}']`);
  if (!el) throw new Error(`no section ${id}`);
  return el;
}

const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null && s.labelSelector === null);

describe("details of a Certificate", () => {
  it("links, names, validity, the last failure in plain words and the chain down to the challenges", async () => {
    await openDetails(expiringIn(5));
    const cm = within(section("certManager"));
    expect(cm.getByText(/Issuing failed/)).toBeInTheDocument();
    expect(cm.getByRole("button", { name: "Open Secret shop-tls" })).toBeInTheDocument();
    expect(cm.getByRole("button", { name: "Open ClusterIssuer letsencrypt" })).toBeInTheDocument();
    expect(cm.getByText("www.shop.example.com")).toBeInTheDocument();
    expect(cm.getByText(/5 days left/)).toHaveClass("rt-status--warning");
    expect(cm.getByText(/3 failed attempts/)).toBeInTheDocument();
    expect(cm.getByText(/order is in "invalid" state/)).toBeInTheDocument();

    // The chain watches the three kinds in the Certificate's namespace only.
    const requestWatch = await listWatch("CertificateRequest");
    expect(wb.specs.get(requestWatch)?.namespaces).toEqual(["shop"]);
    emitSnapshot(wb, requestWatch, requests);
    emitSnapshot(wb, await listWatch("Order"), orders);
    emitSnapshot(wb, await listWatch("Challenge"), challenges);
    const chain = within(section("certManagerChain"));
    await waitFor(() => expect(chain.getByRole("button", { name: "Open CertificateRequest shop-2" })).toBeInTheDocument());
    expect(chain.getByRole("button", { name: "Open CertificateRequest shop-1" })).toBeInTheDocument();
    expect(chain.queryByRole("button", { name: "Open CertificateRequest other-1" })).toBeNull();
    expect(chain.getByRole("button", { name: "Open Order shop-2-2391" })).toBeInTheDocument();
    expect(chain.getByRole("button", { name: "Open Challenge shop-2-2391-111" })).toBeInTheDocument();
    expect(chain.getByText("invalid")).toHaveClass("rt-status--danger");
  });
});

describe("details of a Challenge", () => {
  it("says why the HTTP-01 check fails and marks the challenge in its chain", async () => {
    await openDetails(challenges[0]!);
    const cm = within(section("certManager"));
    expect(cm.getByText(/got HTTP 404 instead of 200/)).toBeInTheDocument();
    expect(cm.getByRole("button", { name: "Open Order shop-2-2391" })).toBeInTheDocument();
    emitSnapshot(wb, await listWatch("CertificateRequest"), requests);
    emitSnapshot(wb, await listWatch("Order"), orders);
    emitSnapshot(wb, await listWatch("Challenge"), challenges);
    const chain = section("certManagerChain");
    await waitFor(() => expect(chain.querySelector("[aria-current='true']")).toHaveTextContent("shop-2-2391-111"));
    expect(within(chain).getByRole("button", { name: "Open Certificate shop" })).toBeInTheDocument();
  });
});

describe("details of a ClusterIssuer", () => {
  it("type, ACME server and the registration failure in plain words", async () => {
    await openDetails(clusterIssuer);
    const cm = within(section("certManager"));
    expect(cm.getByText("ACME")).toBeInTheDocument();
    expect(cm.getByText("https://acme-v02.api.letsencrypt.org/directory")).toBeInTheDocument();
    expect(cm.getByText(/ACME account could not be registered/)).toBeInTheDocument();
    expect(cm.getByText("HTTP-01")).toBeInTheDocument();
    expect(cm.getByText("DNS-01")).toBeInTheDocument();
  });
});

const INFO: SecretCertificates = {
  chain: [
    {
      subject: "O=Shop, CN=shop.example.com",
      commonName: "shop.example.com",
      issuer: "C=US, O=Let's Encrypt, CN=R11",
      issuerCommonName: "R11",
      serial: "0A:1B",
      dnsNames: ["shop.example.com", "www.shop.example.com"],
      ipAddresses: [],
      emails: [],
      uris: [],
      notBefore: "2026-07-20T00:00:00Z",
      notAfter: new Date(Date.now() + 40 * DAY_MS + 3600_000).toISOString(),
      keyAlgorithm: "ECDSA",
      keySize: 256,
      signatureAlgorithm: "sha256WithRSAEncryption",
      isCa: false,
      selfSigned: false,
      fingerprintSha256: "AA:BB",
    },
    {
      subject: "C=US, O=Let's Encrypt, CN=R11",
      commonName: "R11",
      issuer: "C=US, O=ISRG, CN=ISRG Root X1",
      issuerCommonName: "ISRG Root X1",
      serial: "01",
      dnsNames: [],
      ipAddresses: [],
      emails: [],
      uris: [],
      notBefore: "2024-03-13T00:00:00Z",
      notAfter: "2027-03-12T23:59:59Z",
      keyAlgorithm: "RSA",
      keySize: 2048,
      signatureAlgorithm: "sha256WithRSAEncryption",
      isCa: true,
      selfSigned: false,
      fingerprintSha256: "CC:DD",
    },
  ],
  chainTruncated: false,
  ca: [],
  caInvalid: false,
};

describe("the Certificate section of a TLS Secret", () => {
  it("reads the parsed certificate from the backend and warns by the setting", async () => {
    stored = { ...stored, notifications: { ...stored.notifications, certExpiryDays: 60 } };
    wb.backend.on("tls_certificate_info", () => INFO);
    await openDetails(tlsSecret);
    const tls = within(section("tlsCertificate"));
    await waitFor(() => expect(tls.getByText("O=Shop, CN=shop.example.com")).toBeInTheDocument());
    expect(wb.backend.calls.find((c) => c.cmd === "tls_certificate_info")?.args).toEqual({
      clusterId: "c1",
      namespace: "shop",
      name: "shop-tls",
    });
    expect(tls.getByText("www.shop.example.com")).toBeInTheDocument();
    expect(tls.getByText("ECDSA 256")).toBeInTheDocument();
    expect(tls.getByText("2 certificates")).toBeInTheDocument();
    expect(tls.getByRole("button", { name: "Open Certificate shop" })).toBeInTheDocument();
    // 40 days left, warned 60 days ahead.
    await waitFor(() => expect(tls.getAllByText(/40 days left/)[0]).toHaveClass("rt-status--warning"));
  });

  it("says when the user may not read the Secret", async () => {
    wb.backend.on("tls_certificate_info", () => {
      throw { code: "forbidden", message: "secrets \"shop-tls\" is forbidden" };
    });
    await openDetails(tlsSecret);
    await waitFor(() =>
      expect(within(section("tlsCertificate")).getByText(/You may not read this Secret/)).toBeInTheDocument(),
    );
  });

  it("is not there for other Secrets, and nothing is read", async () => {
    await openDetails({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: "plain", namespace: "shop", uid: "s-2" },
      data: { password: "" },
    });
    await waitFor(() => expect(document.querySelector("[data-section='metadata']")).not.toBeNull());
    expect(document.querySelector("[data-section='tlsCertificate']")?.textContent ?? "").toBe("");
    expect(wb.backend.calls.some((c) => c.cmd === "tls_certificate_info")).toBe(false);
  });
});

describe("the TLS certificates page", () => {
  const SCAN: TlsExpiryScan = {
    items: [
      { namespace: "shop", name: "broken-tls", notAfter: null, commonName: null, dnsNames: [], issuerCommonName: null, invalid: true },
      {
        namespace: "shop",
        name: "shop-tls",
        notAfter: new Date(Date.now() + 5 * DAY_MS + 3600_000).toISOString(),
        commonName: "shop.example.com",
        dnsNames: ["shop.example.com"],
        issuerCommonName: "R11",
        invalid: false,
      },
      {
        namespace: "web",
        name: "web-tls",
        notAfter: new Date(Date.now() + 200 * DAY_MS + 3600_000).toISOString(),
        commonName: "web.example.com",
        dnsNames: [],
        issuerCommonName: "R11",
        invalid: false,
      },
    ],
    truncated: false,
    forbidden: ["locked"],
    namespacesTruncated: false,
  };

  it("scans the namespaces in view, lists by expiry and saves the warning days", async () => {
    wb.backend.on("tls_expiry_scan", () => SCAN);
    render(<TlsCertificatesPage clusterId="c1" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open Secret shop-tls" })).toBeInTheDocument());
    expect(wb.backend.calls.filter((c) => c.cmd === "tls_expiry_scan").map((c) => c.args)).toEqual([
      { clusterId: "c1", namespaces: null },
    ]);
    const rows = [...document.querySelectorAll(".cm-table tbody tr")].map((tr) => tr.querySelector("td")?.textContent);
    expect(rows).toEqual(["broken-tls", "shop-tls", "web-tls"]);
    expect(screen.getByText("Unreadable")).toHaveClass("rt-status--danger");
    expect(screen.getByText("5 days")).toHaveClass("rt-status--warning");
    expect(screen.getByText("200 days")).toHaveClass("rt-status--success");
    expect(screen.getByText(/may not list Secrets in: locked/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("3 TLS Secrets; expiring, expired or unreadable: 2");

    const input = screen.getByLabelText("Warn this many days before a certificate expires");
    fireEvent.change(input, { target: { value: "365" } });
    fireEvent.blur(input);
    await waitFor(() => expect(stored.notifications.certExpiryDays).toBe(365));
    await waitFor(() => expect(screen.getByText("200 days")).toHaveClass("rt-status--warning"));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(wb.backend.calls.filter((c) => c.cmd === "tls_expiry_scan")).toHaveLength(2));
  });
});
