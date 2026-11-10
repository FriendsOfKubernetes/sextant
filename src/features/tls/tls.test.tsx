// The TLS views (ADR-0069): a TLS Secret's "Certificate" section and the "TLS certificates" page, both with the expiry
// warning setting (`notifications.certExpiryDays`).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { kindFromApiVersion, resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resetProblemSources } from "../problems/store";
import tlsSecretJson from "./fixtures/tls-secret.json";
import "./index";
import { clampExpiryDays, DAY_MS, expiryOf } from "./model";
import { TlsCertificatesPage } from "./TlsPage";
import { ExpiryText } from "./ExpiryText";
import { formatDateTime } from "../../i18n";

const tlsSecret = tlsSecretJson as KubeObject;

const kindOf = (obj: KubeObject): KindRef => kindFromApiVersion(obj.apiVersion ?? "", obj.kind ?? "");
const NOW = Date.parse("2026-10-10T00:00:00Z");

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

});

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

let wb: WatchBackend;
let stored: AppSettings;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => BUILT_IN.map((k) => served(k)));
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

describe("expiry text", () => {
  it("a certificate not valid yet names when it becomes valid", () => {
    const notBefore = new Date(Date.now() + 3 * DAY_MS).toISOString();
    const notAfter = new Date(Date.now() + 90 * DAY_MS).toISOString();
    render(<ExpiryText notAfter={notAfter} notBefore={notBefore} />);
    expect(screen.getByText(`Not valid yet (from ${formatDateTime(notBefore)})`)).toHaveClass("rt-status--warning");
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
