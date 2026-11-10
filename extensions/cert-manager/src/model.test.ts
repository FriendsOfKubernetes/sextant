// The model and the manifest's declarative parts. The manifest's problem rules, its kinds' "Only problems" and the
// columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded at run
// time so the type check stays inside the extension) and compared with the model they replace — the reading of
// Sextant's former built-in view (ADR-0069) and its problem category `certificates`, ported unchanged — on its fixtures
// and variants of them.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import manifest from "../sextant-extension.json";
import certificateJson from "../fixtures/certificate.json";
import challengesJson from "../fixtures/challenges.json";
import clusterIssuerJson from "../fixtures/clusterissuer.json";
import ordersJson from "../fixtures/orders.json";
import requestsJson from "../fixtures/certificaterequests.json";
import {
  acmeReason,
  acmeState,
  acmeTone,
  APPROVAL_TONE,
  approvalOf,
  CERT_IN_PROGRESS_REASONS,
  CERT_MANAGER_KINDS,
  CERTIFICATE,
  CERTIFICATE_REQUEST,
  certificateFields,
  certificateNameOf,
  certificateProblems,
  CHALLENGE,
  challengesOf,
  challengeType,
  CLUSTER_ISSUER,
  DAY_MS,
  EXPIRY_TONE,
  expiryOf,
  explainCertificate,
  explainChallenge,
  explainIssuer,
  isProblem,
  ISSUER,
  issuerRefOf,
  issuerText,
  issuerType,
  ORDER,
  ordersOf,
  ownerName,
  readyMessage,
  readyReason,
  readyStatus,
  readyTone,
  requestsOf,
  rootCertificateName,
  type Found,
  type KindOf,
} from "./model";

const copy = <T>(value: T): T => structuredClone(value);
const certificate = () => copy(certificateJson) as unknown as KubeObject;
const requests = () => copy(requestsJson) as unknown as KubeObject[];
const orders = () => copy(ordersJson) as unknown as KubeObject[];
const challenges = () => copy(challengesJson) as unknown as KubeObject[];
const clusterIssuer = () => copy(clusterIssuerJson) as unknown as KubeObject;
const st = (o: KubeObject) => ((o as { status?: Record<string, unknown> }).status ??= {});
const spec = (o: KubeObject) => ((o as { spec?: Record<string, unknown> }).spec ??= {});
type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-10-10T00:00:00Z");

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface Detected {
  reason: string;
  group: string;
  message?: string;
  since?: string;
  graceMs?: number;
  activeFrom?: number;
  until?: number;
  notify: boolean;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  width?: string;
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
  filter?: { value(obj: KubeObject, ctx: { now: number }): unknown };
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
/** Sextant's problems model: the warning days the window's `expiring` reads. */
let problems: { setCertExpiryDays(days: unknown): boolean };
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  problems = (await import(/* @vite-ignore */ join(here, "../../../src/features/problems/model.ts"))) as typeof problems;
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

// ---------- The model (the built-in view's tests, ported) ----------

describe("the model", () => {
  it("expiry: expired, expiring within the warning days, valid, not yet valid", () => {
    const expiry = (iso: string) => expiryOf(iso, NOW, 14);
    expect(expiry("2026-10-09T00:00:00Z")).toEqual({ state: "expired", daysLeft: -1 });
    expect(expiry("2026-10-20T00:00:00Z")).toEqual({ state: "expiring", daysLeft: 10 });
    expect(expiry("2026-12-01T00:00:00Z")).toEqual({ state: "valid", daysLeft: 52 });
    expect(expiryOf("2026-12-01T00:00:00Z", NOW, 60)?.state).toBe("expiring");
    expect(expiryOf("2026-12-01T00:00:00Z", NOW, 14, "2026-11-01T00:00:00Z")?.state).toBe("notYetValid");
    expect(expiryOf(undefined, NOW, 14)).toBeUndefined();
    expect(expiryOf("not a date", NOW, 14)).toBeUndefined();
  });

  it("the chain: requests of a Certificate newest first, their orders and challenges, up from any link", () => {
    expect(requestsOf(certificate(), requests()).map((r) => r.metadata?.name)).toEqual(["shop-2", "shop-1"]);
    const latest = requests()[1]!;
    expect(ordersOf(latest, orders()).map((o) => o.metadata?.name)).toEqual(["shop-2-2391"]);
    expect(ordersOf(requests()[0]!, orders())).toEqual([]);
    expect(challengesOf(orders()[0]!, challenges()).map((c) => c.metadata.name)).toEqual(["shop-2-2391-222", "shop-2-2391-111"]);
    for (const [obj, kind] of [
      [certificate(), CERTIFICATE],
      [latest, CERTIFICATE_REQUEST],
      [orders()[0]!, ORDER],
      [challenges()[0]!, CHALLENGE],
    ] as const) {
      expect(rootCertificateName(obj, kind, requests(), orders())).toBe("shop");
    }
    expect(rootCertificateName(orders()[0]!, ORDER, [], orders())).toBeUndefined();
  });

  it("explains failures in plain words", () => {
    expect(explainCertificate(certificate())).toEqual({ key: "certificate.failed" });
    const missing = certificate();
    st(missing).conditions = [{ type: "Ready", status: "False", reason: "DoesNotExist" }];
    expect(explainCertificate(missing)).toEqual({ key: "certificate.DoesNotExist", params: { secret: "shop-tls" } });
    expect(explainChallenge(challenges()[0]!)).toEqual({ key: "challenge.httpStatus", params: { domain: "www.shop.example.com", code: "404" } });
    expect(explainChallenge(challenges()[1]!)).toBeUndefined();
    expect(explainIssuer(clusterIssuer())).toEqual({ key: "issuer.ErrRegisterACMEAccount" });
  });

  it("what counts as a problem", () => {
    expect(isProblem(orders()[0]!, ORDER)).toBe(true);
    expect(isProblem(challenges()[0]!, CHALLENGE)).toBe(false);
    expect(isProblem(requests()[1]!, CERTIFICATE_REQUEST)).toBe(true);
    expect(isProblem(requests()[2]!, CERTIFICATE_REQUEST)).toBe(true);
    expect(isProblem(requests()[0]!, CERTIFICATE_REQUEST)).toBe(false);
    expect(isProblem(clusterIssuer(), CLUSTER_ISSUER)).toBe(true);
    // Ready, but its renewal failed (Issuing=False, Failed).
    expect(isProblem(certificate(), CERTIFICATE)).toBe(true);
    const fine = certificate();
    st(fine).conditions = [{ type: "Ready", status: "True", reason: "Ready" }];
    expect(isProblem(fine, CERTIFICATE)).toBe(false);
  });

  it("an empty issuerRef group or kind means cert-manager's Issuer", () => {
    const withRef = (issuerRef: Record<string, string>) => ({ spec: { issuerRef } }) as unknown as KubeObject;
    expect(issuerRefOf(withRef({ name: "ca", group: "", kind: "" }))).toEqual({ name: "ca", kind: "Issuer", group: "cert-manager.io" });
    expect(issuerText(issuerRefOf(withRef({ name: "le", kind: "ClusterIssuer" })))).toBe("ClusterIssuer/le");
    expect(issuerRefOf(withRef({ name: "x", kind: "AWSPCAIssuer", group: "awspca.cert-manager.io" }))?.group).toBe("awspca.cert-manager.io");
  });
});

// ---------- Variants of the fixtures ----------

const withConditions = (o: KubeObject, ...conds: Cond[]) => {
  st(o).conditions = conds;
  return o;
};
const ready = (status: string, reason?: string, extra: Partial<Cond> = {}): Cond => ({
  type: "Ready",
  status,
  ...(reason === undefined ? {} : { reason }),
  message: `Ready ${status} ${reason ?? ""}`,
  lastTransitionTime: "2026-10-09T23:00:00Z",
  ...extra,
});
const issuing = (status: string, reason?: string, extra: Partial<Cond> = {}): Cond => ({
  type: "Issuing",
  status,
  ...(reason === undefined ? {} : { reason }),
  message: `Issuing ${status} ${reason ?? ""}`,
  lastTransitionTime: "2026-10-09T23:58:00Z",
  ...extra,
});

function certificateVariants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [["the fixture: ready, its renewal failed", certificate()]];
  const add = (label: string, make: (o: KubeObject) => void) => {
    const o = certificate();
    make(o);
    out.push([label, o]);
  };
  for (const reason of [...CERT_IN_PROGRESS_REASONS, "Failed", "InvalidKeyPair", "Expired", "SecretMismatch", "Other"]) {
    add(`Ready False ${reason}`, (o) => withConditions(o, ready("False", reason)));
    add(`Ready False ${reason}, issuance failed`, (o) => withConditions(o, ready("False", reason), issuing("False", "Failed")));
  }
  add("Ready False without a reason", (o) => withConditions(o, ready("False")));
  add("Ready False with an empty reason", (o) => withConditions(o, ready("False", "")));
  add("Ready False without a time", (o) => withConditions(o, ready("False", "Failed", { lastTransitionTime: undefined })));
  add("Ready False without a message", (o) => withConditions(o, ready("False", "Failed", { message: undefined })));
  add("Ready Unknown", (o) => withConditions(o, ready("Unknown", "Pending")));
  add("Ready True", (o) => withConditions(o, ready("True", "Ready")));
  add("Ready True, issuing", (o) => withConditions(o, ready("True", "Ready"), issuing("True", "Renewing")));
  add("Ready True, issuance failed without a time", (o) => withConditions(o, ready("True", "Ready"), issuing("False", "Failed", { lastTransitionTime: undefined })));
  add("Ready True, issuance failed without a message", (o) => withConditions(o, ready("True", "Ready"), issuing("False", "Failed", { message: undefined })));
  add("Issuing False for another reason", (o) => withConditions(o, ready("True", "Ready"), issuing("False", "Other")));
  add("no conditions", (o) => withConditions(o));
  add("no notAfter", (o) => delete st(o).notAfter);
  add("an unreadable notAfter", (o) => (st(o).notAfter = "soon"));
  add("valid for long", (o) => (st(o).notAfter = "2027-06-01T00:00:00Z"));
  add("expiring in 5 days", (o) => (st(o).notAfter = "2026-10-15T00:00:00Z"));
  add("expired", (o) => (st(o).notAfter = "2026-10-05T00:00:00Z"));
  return out;
}

const TIMES = ["2026-10-09T23:30:00Z", "2026-10-10T00:00:30Z", "2026-10-10T00:05:00Z", "2026-10-16T00:00:00Z", "2026-10-18T00:02:00Z", "2026-11-01T00:00:00Z", "2028-01-01T00:00:00Z"].map(at);

type Rule = (typeof manifest.contributes.problems)[number];
const RULES = manifest.contributes.problems as Rule[];

/** The window's start of a problem: `activeFrom`, else the grace after `since`; a problem without either counts at once. */
const windowStart = (d: { activeFrom?: number; graceMs?: number; since?: string }) => d.activeFrom ?? (d.graceMs && d.since ? at(d.since) + d.graceMs : -Infinity);
const live = (start: number, until: number | undefined, now: number) => start <= now && (until === undefined || until > now);

function windowFound(obj: KubeObject, now: number) {
  return RULES.flatMap((rule) => engine.detectRule(rule, obj))
    .filter((d) => live(windowStart(d), d.until, now))
    .map((d) => ({ reason: d.reason, group: d.group, message: d.message, since: d.since, until: d.until, start: windowStart(d) }));
}

/** The built-in `messages.expires` / `messages.expired` in English. */
const MESSAGES = { "messages.expires": (date: string) => `Expires at ${date}`, "messages.expired": (date: string) => `Expired at ${date}` };
/** The built-in groups (`notReady`, else the reason) by the manifest's names. */
const GROUPS: Record<string, string> = { notReady: "not-ready", Expiring: "expiring", Expired: "expired" };

/** What the built-in category `certificates` counted, warning `warnDays` ahead. */
function builtInFound(obj: KubeObject, now: number, warnDays = 14) {
  return certificateProblems(obj, warnDays)
    .filter((d: Found) => live(windowStart(d), d.until, now))
    .map((d) => ({
      // An empty Ready reason: the window takes `reasonOr` (the built-in kept the empty text; cert-manager writes none).
      reason: d.reason || "NotReady",
      group: GROUPS[d.group ?? d.reason]!,
      message: d.message ?? (d.messageKey ? MESSAGES[d.messageKey](d.date!) : ""),
      since: d.since,
      until: d.until,
      start: windowStart(d),
    }));
}

describe("the problem rules, against the built-in category certificates", () => {
  it("find what the built-in rules found, at every time, on every variant", () => {
    for (const [label, o] of certificateVariants()) {
      for (const now of TIMES) expect(windowFound(o, now), `${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(o, now));
    }
  });

  it("are the main category, given to agents only by the user's choice, and notify", () => {
    expect("problemCategories" in manifest.contributes).toBe(false);
    for (const rule of RULES) {
      expect(rule).not.toHaveProperty("category");
      expect(rule).not.toHaveProperty("notify");
      expect(rule.kind).toEqual({ group: "cert-manager.io", kind: "Certificate" });
      expect(rule.source).toEqual({ maxObjects: 20000 });
    }
    expect(RULES.map((r) => [r.id, (r as { group?: string }).group])).toEqual([
      ["certificate-not-ready", "not-ready"],
      ["certificate-issuance-failed", "not-ready"],
      ["certificate-expiring", "expiring"],
      ["certificate-expired", "expired"],
    ]);
  });

  it("count a certificate expiring from the user's warning days before notAfter, and expired from notAfter itself", () => {
    const o = certificate();
    st(o).conditions = [];
    const notAfter = at("2026-10-18T00:00:00Z");
    const reasons = (now: number) => windowFound(o, now).map((d) => [d.reason, d.message]);
    expect(reasons(notAfter - 14 * DAY_MS - 1)).toEqual([]);
    expect(reasons(notAfter - 14 * DAY_MS)).toEqual([["Expiring", "Expires at 2026-10-18T00:00:00Z"]]);
    expect(reasons(notAfter - 1)).toEqual([["Expiring", "Expires at 2026-10-18T00:00:00Z"]]);
    expect(reasons(notAfter)).toEqual([["Expired", "Expired at 2026-10-18T00:00:00Z"]]);
    // The time it is about, so the problems store moves it when the setting changes (`applyCertExpiryDays`).
    const expiring = engine.detectRule(RULES.find((r) => r.id === "certificate-expiring"), o)[0] as Detected & { expiresAt?: number };
    expect(expiring.expiresAt).toBe(notAfter);
  });

  it("warn by the user's setting, as the built-in rules did", () => {
    try {
      problems.setCertExpiryDays(30);
      for (const [label, o] of certificateVariants()) {
        for (const now of TIMES) expect(windowFound(o, now), `${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(o, now, 30));
      }
    } finally {
      problems.setCertExpiryDays(14);
    }
  });
});

describe("Only problems, against the built-in tables' filter", () => {
  const kindsByName = new Map(manifest.contributes.kinds.map((k) => [k.kind, k]));
  const onlyProblems = (kind: KindOf, o: KubeObject) => engine.evaluate(kindsByName.get(kind.kind)!.problemWhen, o).holds;

  it("Certificates", () => {
    for (const [label, o] of certificateVariants()) expect(onlyProblems(CERTIFICATE, o), label).toBe(isProblem(o, CERTIFICATE));
  });

  it("CertificateRequests, Issuers, ClusterIssuers, Orders and Challenges", () => {
    const variants: [KindOf, string, KubeObject][] = requests().map((r) => [CERTIFICATE_REQUEST, r.metadata.name, r]);
    const request = (label: string, ...conds: Cond[]) => variants.push([CERTIFICATE_REQUEST, label, withConditions(requests()[0]!, ...conds)]);
    request("denied", { type: "Denied", status: "True" });
    request("not denied", { type: "Denied", status: "False" });
    request("invalid", { type: "InvalidRequest", status: "True" });
    request("ready failed", ready("False", "Failed"));
    request("ready pending", ready("False", "Pending"));
    request("ready failed, true", ready("True", "Failed"));
    request("nothing");
    for (const kind of [ISSUER, CLUSTER_ISSUER]) {
      variants.push([kind, "fixture", clusterIssuer()]);
      for (const status of ["True", "False", "Unknown"]) variants.push([kind, status, withConditions(clusterIssuer(), ready(status, "X"))]);
      variants.push([kind, "nothing", withConditions(clusterIssuer())]);
    }
    for (const kind of [ORDER, CHALLENGE]) {
      for (const state of ["valid", "pending", "ready", "processing", "invalid", "errored", "expired", "", undefined]) {
        const o = kind === ORDER ? orders()[0]! : challenges()[0]!;
        if (state === undefined) delete st(o).state;
        else st(o).state = state;
        variants.push([kind, `state ${state}`, o]);
      }
    }
    for (const [kind, label, o] of variants) expect(onlyProblems(kind, o), `${kind.kind} ${label}`).toBe(isProblem(o, kind));
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.cert-manager:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject, now = NOW) => windowColumn(id).searchText(obj, { now, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
/** A cell as drawn: its hover and its status tone. */
function drawn(id: string, obj: KubeObject, now = NOW): Drawn {
  let node = windowColumn(id).render(obj, { now }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}

const KINDS_OF: Record<string, KindOf> = { cert: CERTIFICATE, cr: CERTIFICATE_REQUEST, issuer: ISSUER, ci: CLUSTER_ISSUER, order: ORDER, ch: CHALLENGE };

describe("the columns, against the built-in ones", () => {
  it("are placed after the name or namespace in the built-in order, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const order = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.afterColumn, c.id]);
    // The built-in: name, namespace, ready, secret, issuer, expires, status, age.
    expect(order("Certificate")).toEqual([
      ["namespace", "cert-ready"],
      ["cert-ready", "cert-secret"],
      ["cert-secret", "cert-issuer"],
      ["cert-issuer", "cert-expires"],
      ["cert-expires", "cert-status"],
    ]);
    expect(order("CertificateRequest").map(([, id]) => id)).toEqual(["cr-approved", "cr-ready", "cr-reason", "cr-certificate", "cr-issuer", "cr-status"]);
    expect(order("Issuer").map(([, id]) => id)).toEqual(["issuer-ready", "issuer-type", "issuer-reason", "issuer-status"]);
    expect(order("ClusterIssuer")[0]).toEqual(["name", "ci-ready"]);
    expect(order("ClusterIssuer").map(([, id]) => id)).toEqual(["ci-ready", "ci-type", "ci-reason", "ci-status"]);
    expect(order("Order").map(([, id]) => id)).toEqual(["order-state", "order-request", "order-reason"]);
    expect(order("Challenge").map(([, id]) => id)).toEqual(["ch-state", "ch-domain", "ch-type", "ch-reason"]);
    for (const c of manifest.contributes.columns) expect(c.kind).toEqual({ group: KINDS_OF[c.id.split("-")[0]!]!.group, kind: KINDS_OF[c.id.split("-")[0]!]!.kind });
  });

  it("have the built-in columns' widths and titles", () => {
    const WIDTH: Record<string, [string, string]> = {
      ready: ["80px", "Ready"],
      reason: ["minmax(100px, 1fr)", "Reason"],
      status: ["minmax(180px, 3fr)", "Status"],
      issuer: ["minmax(120px, 1fr)", "Issuer"],
      expires: ["110px", "Expires"],
      secret: ["minmax(120px, 1fr)", "Secret"],
      approved: ["100px", "Approval"],
      certificate: ["minmax(120px, 1fr)", "Certificate"],
      type: ["100px", "Type"],
      state: ["100px", "State"],
      request: ["minmax(120px, 1fr)", "Request"],
      domain: ["minmax(140px, 2fr)", "Domain"],
    };
    for (const c of manifest.contributes.columns) {
      const ending = c.id.split("-").slice(1).join("-");
      const acmeReasonColumn = ending === "reason" && (c.kind.kind === "Order" || c.kind.kind === "Challenge");
      const [width, title] = acmeReasonColumn ? ["minmax(200px, 3fr)", "Reason"] : c.id === "ch-type" ? ["90px", "Type"] : WIDTH[ending]!;
      expect([windowColumn(c.id).width, c.title], c.id).toEqual([width, title]);
    }
  });

  const allObjects = (): [KindOf, KubeObject][] => [
    ...certificateVariants().map(([, o]) => [CERTIFICATE, o] as [KindOf, KubeObject]),
    ...requests().map((o) => [CERTIFICATE_REQUEST, o] as [KindOf, KubeObject]),
    [CLUSTER_ISSUER, clusterIssuer()],
    [ISSUER, withConditions(clusterIssuer())],
    [ISSUER, withConditions(clusterIssuer(), ready("True", "KeyPairVerified"), { type: "Ready" })],
    [ISSUER, withConditions(clusterIssuer(), { type: "Ready" })],
    ...orders().map((o) => [ORDER, o] as [KindOf, KubeObject]),
    ...challenges().map((o) => [CHALLENGE, o] as [KindOf, KubeObject]),
  ];
  const prefixOf = (kind: KindOf) => Object.entries(KINDS_OF).find(([, k]) => k === kind)![0];

  it("Ready, Reason and Status: the Ready condition's status in its tone, its reason, its message with the message on hover", () => {
    const cases = allObjects().filter(([kind]) => kind !== ORDER && kind !== CHALLENGE);
    expect(cases.some(([, o]) => readyStatus(o) === "Unknown" && (o as unknown as { status: { conditions: Cond[] } }).status.conditions[0]!.status === undefined)).toBe(true);
    for (const [kind, o] of cases) {
      const p = prefixOf(kind);
      const label = `${kind.kind} ${o.metadata.name} ${JSON.stringify(st(o).conditions)}`;
      expect(cell(`${p}-ready`, o), label).toBe(readyStatus(o));
      expect(windowColumn(`${p}-ready`).value(o), label).toBe(readyStatus(o));
      if (readyStatus(o)) expect(drawn(`${p}-ready`, o).tone, label).toBe(readyTone(readyStatus(o)));
      expect(cell(`${p}-status`, o), label).toBe(readyMessage(o));
      expect(drawn(`${p}-status`, o).title, label).toBe(readyMessage(o));
      if (kind !== CERTIFICATE) expect(cell(`${p}-reason`, o), label).toBe(readyReason(o));
    }
  });

  it("Issuer: Kind/name, an empty kind as Issuer, nothing without a name", () => {
    const refs = [
      { name: "le", kind: "ClusterIssuer", group: "cert-manager.io" },
      { name: "ca", kind: "", group: "" },
      { name: "ca" },
      { name: "x", kind: "AWSPCAIssuer", group: "awspca.cert-manager.io" },
      { name: "" },
      {},
    ];
    for (const ref of refs) {
      for (const [id, base] of [["cert-issuer", certificate()], ["cr-issuer", requests()[0]!]] as const) {
        spec(base).issuerRef = ref;
        expect(cell(id, base) || undefined, JSON.stringify(ref)).toBe(issuerText(issuerRefOf(base)));
        expect(windowColumn(id).value(base) || undefined, JSON.stringify(ref)).toBe(issuerText(issuerRefOf(base)));
      }
    }
  });

  it("Secret, Certificate, Request, Domain and Type: the built-in fields", () => {
    expect(cell("cert-secret", certificate())).toBe(certificateFields(certificate()).secretName);
    for (const r of requests()) expect(cell("cr-certificate", r)).toBe(certificateNameOf(r));
    const annotated = requests()[0]!;
    delete (annotated.metadata as { ownerReferences?: unknown }).ownerReferences;
    expect(cell("cr-certificate", annotated)).toBe("shop");
    expect(certificateNameOf(annotated)).toBe("shop");
    for (const o of orders()) expect(cell("order-request", o)).toBe(ownerName(o, "CertificateRequest"));
    for (const c of challenges()) {
      expect(cell("ch-domain", c)).toBe((c.spec as { dnsName?: string }).dnsName);
      expect(cell("ch-type", c)).toBe(challengeType(c));
    }
  });

  it("Type of an issuer: the built-in type it is, as cert-manager names it", () => {
    for (const type of ["acme", "ca", "selfSigned", "vault", "venafi", undefined]) {
      for (const id of ["issuer-type", "ci-type"]) {
        const o = clusterIssuer();
        (o as { spec: unknown }).spec = type ? { [type]: {} } : { awspca: {} };
        expect(cell(id, o), String(type)).toBe(issuerType(o));
        expect(windowColumn(id).value(o), String(type)).toBe(issuerType(o));
      }
    }
  });

  it("Approval: Denied, Approved or Waiting in its tone, sorted and filtered by the state", () => {
    const variants = [
      ...requests(),
      withConditions(requests()[0]!),
      withConditions(requests()[0]!, { type: "Approved", status: "True" }, { type: "Denied", status: "True" }),
      withConditions(requests()[0]!, { type: "Approved", status: "False" }),
    ];
    const words = { approved: "Approved", denied: "Denied", pending: "Waiting" };
    for (const o of variants) {
      const state = approvalOf(o);
      expect(cell("cr-approved", o)).toBe(words[state]);
      expect(drawn("cr-approved", o).tone).toBe(APPROVAL_TONE[state]);
      expect(windowColumn("cr-approved").value(o)).toBe(state);
      expect(windowColumn("cr-approved").filter!.value(o, { now: NOW })).toBe(state);
    }
  });

  it("State and Reason of Orders and Challenges: the ACME state in its tone, the reason with the reason on hover", () => {
    const variants: [string, KubeObject][] = [];
    for (const state of ["valid", "pending", "ready", "processing", "invalid", "errored", "expired"]) {
      for (const [p, base] of [["order", orders()[0]!], ["ch", challenges()[0]!]] as const) {
        st(base).state = state;
        variants.push([p, base]);
      }
    }
    for (const [p, o] of variants) {
      expect(cell(`${p}-state`, o)).toBe(acmeState(o));
      expect(drawn(`${p}-state`, o).tone).toBe(acmeTone(acmeState(o)));
      expect(cell(`${p}-reason`, o)).toBe(acmeReason(o));
      expect(drawn(`${p}-reason`, o).title).toBe(acmeReason(o));
    }
  });

  it("Expires: Expired or the days left, coloured by the user's warning days, sorted and filtered by notAfter with notAfter on hover", () => {
    const variants = certificateVariants();
    for (const days of [1, 2, 3, 13, 14, 15, 30]) {
      const o = certificate();
      st(o).notAfter = new Date(NOW + days * DAY_MS - 1000).toISOString();
      variants.push([`${days} days away`, o]);
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const warnDays of [14, 30]) {
        problems.setCertExpiryDays(warnDays);
        for (const [label, o] of variants) {
          const notAfter = certificateFields(o).notAfter;
          for (const now of [...TIMES, NOW]) {
            // The cell's days left are counted from the clock, as the window's cell is drawn now.
            vi.setSystemTime(now);
            const what = `${label} at ${new Date(now).toISOString()}, warned ${warnDays} days ahead`;
            // The built-in column (`ExpiresIn`): the expiry without notBefore, nothing for an unreadable time.
            const expiry = expiryOf(notAfter, now, warnDays);
            const text = !expiry ? undefined : expiry.state === "expired" ? "Expired" : `${Math.max(0, expiry.daysLeft)} ${Math.max(0, expiry.daysLeft) === 1 ? "day" : "days"}`;
            expect(cell("cert-expires", o, now), what).toBe(text);
            expect(drawn("cert-expires", o, now), what).toEqual(expiry ? { title: notAfter, tone: EXPIRY_TONE[expiry.state] } : {});
            if (expiry) {
              expect(windowColumn("cert-expires").value(o), what).toBe(notAfter);
              expect(windowColumn("cert-expires").filter!.value(o, { now }), what).toBe(notAfter);
            }
          }
        }
      }
    } finally {
      problems.setCertExpiryDays(14);
      vi.useRealTimers();
    }
  });
});

describe("the manifest", () => {
  it("lists the six kinds in the section certManager after Access Control, with the built-in labels, icons and order", () => {
    expect(manifest.contributes.kinds.map((k) => [k.group, k.kind, k.title, k.icon, k.order])).toEqual(
      CERT_MANAGER_KINDS.map((d) => [d.kind.group, d.kind.kind, { certificates: "Certificates", certificateRequests: "Certificate Requests", issuers: "Issuers", clusterIssuers: "Cluster Issuers", orders: "Orders", challenges: "Challenges" }[d.label], d.icon, d.order]),
    );
    for (const kind of manifest.contributes.kinds) expect(kind.section).toBe("certManager");
    expect(manifest.contributes.sections).toEqual([{ section: "certManager", title: "cert-manager", icon: "certManager", after: "accessControl" }]);
    expect(manifest.contributes.sectionBadges).toEqual([
      { section: "certManager", label: { one: "{{count}} certificate needs attention", other: "{{count}} certificates need attention" } },
    ]);
  });

  it("has the fields on every kind in place of the generic ones (20) and the chain before the conditions (24), without headings", () => {
    expect(manifest.contributes.detailsSections.map((s) => [s.id, s.order, s.heading, s.placement, s.kinds.map((k) => k.kind)])).toEqual([
      ["certmanager", 20, false, "section", ["Certificate", "CertificateRequest", "Issuer", "ClusterIssuer", "Order", "Challenge"]],
      ["chain", 24, false, "section", ["Certificate", "CertificateRequest", "Order", "Challenge"]],
    ]);
  });

  it("asks only to read the six kinds, with no action of its own", () => {
    expect(manifest.permissions.rules).toEqual([
      {
        namespaces: { type: "all" },
        kinds: { type: "only", kinds: manifest.contributes.kinds.map((k) => ({ group: k.group, kind: k.kind })) },
        actions: ["read"],
      },
    ]);
    expect("actions" in manifest.contributes).toBe(false);
  });
});
