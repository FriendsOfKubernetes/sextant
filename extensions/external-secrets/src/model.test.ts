// The manifest's declarative parts against the built-in reading they replace. The problem rules, "Only problems" and
// the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and columns.tsx, loaded
// at run time so the type check stays inside the extension) and compared with `./model`, Sextant's former built-in
// External Secrets model ported unchanged, over every combination of the fields they read.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import clusterSecretStoreJson from "../fixtures/clustersecretstore.json";
import externalSecretJson from "../fixtures/externalsecret.json";
import pushSecretJson from "../fixtures/pushsecret.json";
import manifest from "../sextant-extension.json";
import en from "./locales/en.json";
import {
  ESO_KINDS,
  externalSecretsProblems,
  isProblem,
  lastSyncOf,
  providerOf,
  pushStoreRefs,
  readinessOf,
  readyTip,
  READY_TONE,
  refreshIntervalOf,
  storeRefOf,
  str,
  targetSecretName,
  capabilitiesOf,
  pushSourceSecret,
  type EsoKind,
} from "./model";

const EN = en as Record<string, string>;
const externalSecret = externalSecretJson as unknown as KubeObject;
const clusterSecretStore = clusterSecretStoreJson as unknown as KubeObject;
const pushSecret = pushSecretJson as unknown as KubeObject;
const copy = <T>(value: T): T => structuredClone(value);

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
  notify: boolean;
}
interface Engine {
  evaluate(condition: unknown, obj: KubeObject): Verdict;
  detectRule(rule: unknown, obj: KubeObject): Detected[];
}
interface WindowColumn {
  value(obj: KubeObject): unknown;
  render(obj: KubeObject, ctx: { now: number }): unknown;
  searchText(obj: KubeObject, ctx: { now: number; t: (key: string, values?: { count?: number }) => string }): string | null | undefined;
}
interface Columns {
  computedColumn(id: string, column: unknown): WindowColumn;
}
let engine: Engine;
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
});

const holdsNow = (condition: unknown, obj: KubeObject, now = Date.now()) => {
  const v = engine.evaluate(condition, obj);
  return v.holds && (v.activeFrom === undefined || v.activeFrom <= now) && (v.until === undefined || v.until > now);
};

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.external-secrets:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
/** A cell's text, as the window searches and copies it. */
const cell = (id: string, obj: KubeObject, now = Date.now()) => windowColumn(id).searchText(obj, { now, t: T }) || undefined;
/** What a cell draws: its `title` and, for a status word, its tone. */
function drawn(id: string, obj: KubeObject, now = Date.now()): { title?: string; tone?: string } {
  let node = windowColumn(id).render(obj, { now }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node?.props?.children as typeof node;
  return { title, tone: node?.props?.tone };
}

const rules = manifest.contributes.problems;
const detected = (kind: EsoKind, obj: KubeObject) =>
  rules
    .filter((rule) => rule.kind.kind === kind)
    .flatMap((rule) => engine.detectRule({ notify: true, toldThroughOwner: false, graceMinutes: 0, ...rule }, obj));
const kindEntry = (kind: EsoKind) => manifest.contributes.kinds.find((k) => k.kind === kind)!;

/** What a problem says, the built-in group's name as the manifest writes it. */
const said = (p: { reason: string; group?: string; message?: string; since?: string; graceMs?: number; notify: boolean }) => ({
  reason: p.reason,
  group: p.group === "notReady" ? "not-ready" : p.group,
  message: p.message || undefined,
  since: p.since,
  graceMs: p.graceMs,
  notify: p.notify,
});

// ---------- Every object the fields make ----------

const BASE: Record<EsoKind, KubeObject> = {
  ExternalSecret: externalSecret,
  ClusterExternalSecret: {
    apiVersion: "external-secrets.io/v1",
    kind: "ClusterExternalSecret",
    metadata: { name: "everywhere", uid: "ces-1", creationTimestamp: "2026-10-01T10:00:00Z" },
    spec: { refreshTime: "1m", externalSecretSpec: {} },
  } as unknown as KubeObject,
  SecretStore: { ...copy(clusterSecretStore), kind: "SecretStore", metadata: { name: "aws", namespace: "shop", uid: "ss-1" } } as KubeObject,
  ClusterSecretStore: clusterSecretStore,
  PushSecret: pushSecret,
};

type Ready = Record<string, unknown> | undefined;
const READY: Ready[] = [
  undefined,
  { type: "Ready", status: "True", reason: "SecretSynced", message: "secret synced", lastTransitionTime: "2026-10-10T09:00:00Z" },
  { type: "Ready", status: "False", reason: "SecretSyncedError", message: "could not get secret data from provider", lastTransitionTime: "2026-10-10T09:00:00Z" },
  { type: "Ready", status: "False", message: "no reason given", lastTransitionTime: "2026-10-10T09:00:00Z" },
  { type: "Ready", status: "False", reason: "", message: "an empty reason", lastTransitionTime: "2026-10-10T09:00:00Z" },
  { type: "Ready", status: "False", reason: "InvalidProviderConfig" },
  { type: "Ready", status: "False", reason: "ValidationFailed", message: "bad", lastTransitionTime: "not a time" },
  { type: "Ready", status: "Unknown", reason: "Progressing", message: "working on it" },
  { type: "Ready", status: "True" },
  { type: "Ready", status: "True", message: "only a message" },
];
const OTHER_CONDITIONS: Record<string, unknown>[][] = [[], [{ type: "Deleted", status: "False", reason: "Other" }]];

function* variants(kind: EsoKind): Generator<KubeObject> {
  for (const ready of READY) {
    for (const others of OTHER_CONDITIONS) {
      for (const deleting of [false, true]) {
        const o = copy(BASE[kind]);
        o.status = { ...(o.status as Record<string, unknown> | undefined), conditions: [...others, ...(ready ? [ready] : [])] };
        if (deleting) o.metadata.deletionTimestamp = "2026-10-10T10:00:00Z";
        yield o;
      }
    }
  }
}

const PREFIX: Record<EsoKind, string> = {
  ExternalSecret: "es",
  ClusterExternalSecret: "ces",
  SecretStore: "ss",
  ClusterSecretStore: "css",
  PushSecret: "ps",
};

describe("the manifest's problem rules", () => {
  it("find what the built-in rule found, for every kind and every Ready condition", () => {
    let found = 0;
    for (const kind of ESO_KINDS) {
      for (const o of variants(kind)) {
        // A time that is no time is left out by the window, where the built-in passed it on (and nothing read it).
        const builtIn = externalSecretsProblems(o)
          .map(said)
          .map((p) => ({ ...p, since: p.since && !Number.isNaN(Date.parse(p.since)) ? p.since : undefined }));
        expect(detected(kind, o).map(said), `${kind} ${JSON.stringify(o.status)} ${String(o.metadata.deletionTimestamp)}`).toEqual(builtIn);
        found += builtIn.length;
      }
    }
    expect(found).toBe(ESO_KINDS.length * 5 * OTHER_CONDITIONS.length);
  });

  it("are one group per object, notify, and have no grace", () => {
    for (const kind of ESO_KINDS) for (const o of variants(kind)) expect(detected(kind, o).length).toBeLessThanOrEqual(1);
    expect(rules.every((r) => r.group === "not-ready" && !("graceMinutes" in r) && !("notify" in r))).toBe(true);
    expect(new Set(rules.map((r) => r.kind.kind))).toEqual(new Set(ESO_KINDS));
  });

  it("tell the fixtures' failures with the condition's reason, message and time", () => {
    expect(detected("ExternalSecret", externalSecret).map(said)).toEqual([
      { reason: "SecretSyncedError", group: "not-ready", message: "could not get secret data from provider", since: "2026-10-10T09:00:00Z", graceMs: undefined, notify: true },
    ]);
    expect(detected("ClusterSecretStore", clusterSecretStore)[0]).toMatchObject({ reason: "InvalidProviderConfig", message: "unable to validate store: invalid vault credentials" });
    expect(detected("PushSecret", pushSecret)).toEqual([]);
  });

  it("are all counted on the section, as the built-in counter counted every problem of the category", () => {
    expect(manifest.contributes.sectionBadges).toEqual([
      { section: "externalSecrets", label: { one: "{{count}} object needs attention", other: "{{count}} objects need attention" } },
    ]);
  });
});

describe("the manifest's kinds and section", () => {
  it("are the built-in section's: its id, title and icon, its kinds in order, their icons, without the CRDs' printer columns", () => {
    expect(manifest.contributes.sections).toEqual([{ section: "externalSecrets", title: "External Secrets", icon: "externalSecrets", after: "kyverno" }]);
    expect(manifest.contributes.kinds.map((k) => [k.kind, k.title, k.icon, k.order])).toEqual([
      ["ExternalSecret", "External Secrets", "externalSecret", 10],
      ["ClusterExternalSecret", "Cluster External Secrets", "externalSecret", 11],
      ["SecretStore", "Secret Stores", "secretStore", 20],
      ["ClusterSecretStore", "Cluster Secret Stores", "secretStore", 21],
      ["PushSecret", "Push Secrets", "pushSecret", 30],
    ]);
    expect(manifest.contributes.kinds.every((k) => k.section === "externalSecrets" && k.group === "external-secrets.io" && k.printerColumns === false)).toBe(true);
  });

  it("show in Only problems what the built-in tables did: every object whose Ready condition is False, deleting or not", () => {
    for (const kind of ESO_KINDS) {
      for (const o of variants(kind)) expect(holdsNow(kindEntry(kind).problemWhen, o), `${kind} ${JSON.stringify(o.status)}`).toBe(isProblem(o));
    }
  });

  it("ask to read the five kinds and nothing else: no Secret, no change", () => {
    expect(manifest.permissions).toEqual({
      clusters: { type: "all" },
      rules: [{ namespaces: { type: "all" }, kinds: { type: "only", kinds: ESO_KINDS.map((kind) => ({ group: "external-secrets.io", kind })) }, actions: ["read"] }],
    });
    expect(/"kind":"Secret"[,}]|secretValues/.test(JSON.stringify(manifest))).toBe(false);
  });
});

describe("the manifest's columns", () => {
  it("come in the built-in order after Name and Namespace, Age last", () => {
    const order = (kind: EsoKind) => {
      const list = manifest.contributes.columns.filter((c) => c.kind.kind === kind);
      const out: string[] = [];
      let after = kind.startsWith("Cluster") ? "name" : "namespace";
      for (;;) {
        const next = list.find((c) => c.afterColumn === after);
        if (!next) return out;
        out.push(next.title);
        after = next.id;
      }
    };
    expect(order("ExternalSecret")).toEqual(["Status", "Store", "Secret", "Refresh", "Last sync", "Reason"]);
    expect(order("ClusterExternalSecret")).toEqual(["Status", "Refresh", "Reason"]);
    expect(order("SecretStore")).toEqual(["Status", "Provider", "Capabilities", "Reason"]);
    expect(order("ClusterSecretStore")).toEqual(["Status", "Provider", "Capabilities", "Reason"]);
    expect(order("PushSecret")).toEqual(["Status", "Source Secret", "Stores", "Refresh", "Last sync", "Reason"]);
    expect(manifest.contributes.columns.length).toBe(23);
  });

  it("say the Ready state in words with its tone, the reason and message on hover, and the reason", () => {
    for (const kind of ESO_KINDS) {
      for (const o of variants(kind)) {
        const r = readinessOf(o);
        const id = PREFIX[kind];
        expect(cell(`${id}-status`, o), JSON.stringify(o.status)).toBe(EN[`state.${r.state}`]);
        // The empty reason is the one place the tooltip differs: the built-in left it out, the window keeps ": ".
        const tip = r.reason === "" && r.message ? `: ${r.message}` : readyTip(o);
        expect(drawn(`${id}-status`, o), JSON.stringify(o.status)).toEqual({ title: tip, tone: READY_TONE[r.state] });
        expect(cell(`${id}-reason`, o)).toBe(r.reason || undefined);
      }
    }
  });

  it("show an ExternalSecret's store, target Secret, refresh and last sync as the built-in did", () => {
    const refs: unknown[] = [
      undefined,
      { name: "vault-backend", kind: "ClusterSecretStore" },
      { name: "aws", kind: "SecretStore" },
      { name: "aws" },
      { name: "aws", kind: "" },
      { name: "", kind: "SecretStore" },
      { kind: "SecretStore" },
    ];
    const targets: unknown[] = [undefined, { name: "secret-to-be-created" }, { name: "" }, { creationPolicy: "Merge" }];
    for (const ref of refs) {
      for (const target of targets) {
        for (const interval of [undefined, "1h", "0"]) {
          for (const refreshTime of [undefined, "2026-10-10T09:00:00Z"]) {
            const o = copy(externalSecret);
            const spec = o.spec as Record<string, unknown>;
            if (ref === undefined) delete spec.secretStoreRef;
            else spec.secretStoreRef = ref;
            if (target === undefined) delete spec.target;
            else spec.target = target;
            if (interval === undefined) delete spec.refreshInterval;
            else spec.refreshInterval = interval;
            (o.status as Record<string, unknown>).refreshTime = refreshTime;
            const store = storeRefOf(o);
            expect(cell("es-store", o), JSON.stringify(ref)).toBe(store ? `${store.kind}/${store.name}` : undefined);
            expect(cell("es-target", o), JSON.stringify(target)).toBe(targetSecretName(o));
            expect(cell("es-refresh", o)).toBe(refreshIntervalOf(o));
            const sync = lastSyncOf(o);
            expect(windowColumn("es-last-sync").value(o)).toBe(sync ? -Date.parse(sync) : undefined);
          }
        }
      }
    }
  });

  it("show a ClusterExternalSecret's refresh from `spec.refreshTime`, the field it has (the built-in column read a missing one)", () => {
    const o = copy(BASE.ClusterExternalSecret);
    (o.spec as Record<string, unknown>).refreshTime = "5m";
    expect(cell("ces-refresh", o)).toBe("5m");
    (o.spec as Record<string, unknown>).refreshInterval = "1h";
    expect(cell("ces-refresh", o)).toBe("5m");
  });

  it("show a store's provider and capabilities: the provider by name for the common ones, else Other", () => {
    const named = columnOf("ss-provider").cases!.slice(0, -1).map((c) => c.text);
    for (const kind of ["SecretStore", "ClusterSecretStore"] as const) {
      for (const provider of [...named, "akeyless", "fake", "webhook", undefined]) {
        for (const capabilities of [undefined, "ReadWrite", "ReadOnly"]) {
          const o = copy(BASE[kind]);
          (o.spec as Record<string, unknown>).provider = provider === undefined ? undefined : { [provider]: { server: "x" } };
          (o.status as Record<string, unknown>).capabilities = capabilities;
          const id = PREFIX[kind];
          const builtIn = providerOf(o);
          expect(cell(`${id}-provider`, o), provider).toBe(builtIn === undefined ? undefined : named.includes(builtIn) ? builtIn : "Other");
          expect(cell(`${id}-capabilities`, o)).toBe(capabilitiesOf(o));
        }
      }
    }
    expect(named).toEqual(["aws", "vault", "gcpsm", "azurekv", "kubernetes", "onepassword", "bitwardensecretsmanager", "doppler", "infisical"]);
  });

  it("show a PushSecret's source Secret and stores as the built-in did, up to five, then the first five and an ellipsis", () => {
    for (let n = 0; n <= 7; n++) {
      const o = copy(pushSecret);
      (o.spec as Record<string, unknown>).secretStoreRefs = Array.from({ length: n }, (_, i) => ({ name: `store-${i}`, kind: "SecretStore" }));
      const names = pushStoreRefs(o).map((r) => r.name);
      expect(cell("ps-stores", o), String(n)).toBe(n === 0 ? undefined : n <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")}, …`);
      expect(cell("ps-source", o)).toBe(pushSourceSecret(o));
    }
    // A ref by label selector has no name: the built-in left it out.
    const bySelector = copy(pushSecret);
    (bySelector.spec as Record<string, unknown>).secretStoreRefs = [{ name: "first" }, { labelSelector: { matchLabels: { a: "b" } } }];
    expect(cell("ps-stores", bySelector)).toBe("first");
    expect(cell("ps-refresh", pushSecret)).toBe("10s");
    expect(windowColumn("ps-last-sync").value(pushSecret)).toBe(-Date.parse("2026-10-10T09:30:00Z"));
  });

  it("read the fixtures as the built-in tables did", () => {
    expect(cell("es-status", externalSecret)).toBe("Failed");
    expect(cell("es-store", externalSecret)).toBe("ClusterSecretStore/vault-backend");
    expect(cell("es-target", externalSecret)).toBe("secret-to-be-created");
    expect(cell("es-reason", externalSecret)).toBe("SecretSyncedError");
    expect(cell("css-provider", clusterSecretStore)).toBe("vault");
    expect(cell("css-capabilities", clusterSecretStore)).toBe("ReadWrite");
    expect(cell("ps-status", pushSecret)).toBe("Ready");
    expect(drawn("ps-status", pushSecret)).toEqual({ title: "Synced: PushSecret synced successfully", tone: "success" });
    expect(cell("ps-stores", pushSecret)).toBe("aws-parameterstore");
    expect(str(cell("ps-source", pushSecret))).toBe("pokedex-credentials");
  });
});
