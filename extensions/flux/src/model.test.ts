// The model and the manifest against Flux objects as Flux's controllers wrote them (fixtures/, taken from a kind
// cluster): the columns, judged by Sextant's own evaluator of extension conditions and paths, show what Sextant's
// built-in Flux tables showed; the problem rules find what its rule found; the patches are the built-in actions'.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KubeObject } from "@sextant/extension-sdk";
import { describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import {
  FLUX_KINDS,
  fluxKind,
  groupOf,
  helmChartOf,
  helmReleaseNamespaces,
  helmReleaseSelector,
  IN_PROGRESS_REASONS,
  inventoryOf,
  isSuspended,
  LABELLED_KINDS,
  PROBLEM_KINDS,
  readyMessage,
  readyReason,
  readyStatus,
  reconcilePatch,
  REQUESTED_AT_ANNOTATION,
  REVISION_PATHS,
  revisionOf,
  SOURCE_KIND_PATHS,
  SOURCE_NAME_PATHS,
  sourceRefOf,
  suspendPatch,
  usesSource,
  withSourceOrder,
} from "./flux";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as KubeObject;
const ALL = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && f !== "helm-deployment.json")
  .map((f) => fixture(f.replace(/\.json$/, "")));

// Sextant's own evaluator of extension conditions and field paths (src/extensions/problemRules.ts), and its JSONPath
// of printer columns (src/resources/jsonpath.ts): what the window runs for this manifest.
type Verdict = { holds: boolean; since?: string; activeFrom?: number; until?: number };
type Detected = { reason: string; message?: string; since?: string; graceMs?: number; notify: boolean };
const rulesPath = join(here, "../../../src/extensions/problemRules.ts");
const jsonPathPath = join(here, "../../../src/resources/jsonpath.ts");
const host = (await import(/* @vite-ignore */ rulesPath)) as {
  evaluate: (condition: unknown, obj: KubeObject) => Verdict;
  valueAt: (obj: unknown, path: string) => unknown;
  detectRule: (rule: unknown, obj: KubeObject) => Detected[];
};
const { evalJsonPath, formatJsonPathValues } = (await import(/* @vite-ignore */ jsonPathPath)) as {
  evalJsonPath: (obj: unknown, path: string) => unknown[];
  formatJsonPathValues: (values: unknown[]) => string;
};

type Column = (typeof manifest.contributes.columns)[number] & {
  paths?: string[];
  cases?: { when: unknown; text: string }[];
  tooltipPaths?: string[];
  jsonPath?: string;
  tones?: Record<string, string>;
};
const columns = manifest.contributes.columns as Column[];
const columnOf = (obj: KubeObject, name: string) =>
  columns.find((c) => c.id === `${name}-${obj.kind!.toLowerCase()}` && c.kind.group === groupOf(obj.apiVersion));

/** A computed cell's text as the window draws it (`cellOf` in src/extensions/columns.tsx): the first case, else the first path. */
function cell(column: Column, obj: KubeObject): string | undefined {
  if (column.jsonPath) {
    const values = evalJsonPath(obj, column.jsonPath);
    return values.length > 0 ? formatJsonPathValues(values) : undefined;
  }
  for (const c of column.cases ?? []) if (host.evaluate(c.when, obj).holds) return c.text;
  for (const path of column.paths ?? []) {
    const value = host.valueAt(obj, path);
    if (value !== undefined && value !== null) return String(value);
  }
  return undefined;
}

describe("the kinds", () => {
  it("are listed in the section `flux` in the built-in sidebar's order, titles and icons", () => {
    expect(manifest.contributes.kinds.map((k) => [k.group, k.kind, k.order, k.icon, k.section])).toEqual(
      FLUX_KINDS.map((k) => [k.group, k.kind, k.order, k.icon, "flux"]),
    );
    expect(manifest.contributes.kinds[0]?.sectionTitle).toBe("Flux");
    expect(manifest.contributes.kinds.map((k) => k.title)).toEqual([
      "Git Repositories",
      "OCI Repositories",
      "Helm Repositories",
      "Helm Charts",
      "Buckets",
      "Kustomizations",
      "Helm Releases",
      "Image Repositories",
      "Image Policies",
      "Image Update Automations",
      "Alerts",
      "Providers",
      "Receivers",
    ]);
    expect(manifest.contributes.sectionBadges).toEqual([{ section: "flux" }]);
  });

  it("every fixture is one of them", () => {
    for (const obj of ALL) expect(fluxKind(groupOf(obj.apiVersion), obj.kind), obj.kind).toBeDefined();
  });
});

const TITLES: Record<string, string> = { source: "Source", ready: "Ready", status: "Status", revision: "Revision", suspended: "Suspended" };

describe("the columns", () => {
  it("are, after Namespace, Source (Kustomization, HelmRelease), Ready, Status, Revision, Suspended", () => {
    for (const kind of FLUX_KINDS) {
      const own = columns.filter((c) => c.kind.group === kind.group && c.kind.kind === kind.kind);
      // Each goes right after "Namespace", so the last one listed is shown first.
      expect(own.every((c) => c.after === "Namespace")).toBe(true);
      const shown = own.map((c) => c.id.split("-")[0]).reverse();
      const expected = [
        ...(["Kustomization", "HelmRelease"].includes(kind.kind) ? ["source"] : []),
        ...(kind.status ? ["ready", "status", "revision"] : []),
        "suspended",
      ];
      expect(shown, kind.kind).toEqual(expected);
      expect(own.map((c) => c.title).reverse()).toEqual(expected.map((id) => TITLES[id]));
    }
  });

  it("Ready shows the Ready condition's status, toned as the built-in table toned it", () => {
    const tones = { True: "ok", False: "error", Unknown: "warning" };
    for (const obj of ALL) {
      const column = columnOf(obj, "ready");
      if (!column) {
        expect(["Alert", "Provider"]).toContain(obj.kind);
        continue;
      }
      expect(cell(column, obj), obj.kind).toBe(readyStatus(obj));
      expect(column.tones).toEqual(tones);
    }
    const bucket = fixture("bucket");
    // Its first condition is Reconciling: the case finds Ready all the same.
    expect(cell(columnOf(bucket, "ready")!, bucket)).toBe("False");
    const unknown = withReady(fixture("kustomization"), { status: "Unknown", reason: "Progressing" });
    expect(cell(columnOf(unknown, "ready")!, unknown)).toBe("Unknown");
  });

  it("Status is the Ready condition's message", () => {
    for (const obj of ALL) {
      const column = columnOf(obj, "status");
      if (column) expect(cell(column, obj), obj.kind).toBe(readyMessage(obj));
    }
  });

  it("Revision reads the built-in view's fields in its order, an ImagePolicy's `latestRef` by its tag", () => {
    expect(REVISION_PATHS.length).toBeLessThanOrEqual(8);
    for (const obj of ALL) {
      const column = columnOf(obj, "revision");
      if (!column) continue;
      expect(column.paths).toEqual([...REVISION_PATHS]);
      if (obj.kind === "ImagePolicy") {
        // A path cannot join `name:tag`: the column shows the tag, the details the whole reference.
        expect(cell(column, obj)).toBe("6.15.0");
        expect(revisionOf(obj)).toBe("ghcr.io/stefanprodan/podinfo:6.15.0");
      } else {
        expect(cell(column, obj), obj.kind).toBe(revisionOf(obj));
      }
    }
    expect(revisionOf(fixture("kustomization"))).toBe("master@sha1:3e0ff8ae123b710bc91de1315cba0f996a8896c2");
    expect(revisionOf(fixture("helmrelease"))).toBe("6.15.0");
  });

  it("Suspended says Yes or No", () => {
    for (const obj of ALL) {
      const column = columnOf(obj, "suspended")!;
      expect(cell(column, obj), obj.kind).toBe(isSuspended(obj) ? "Yes" : "No");
      const suspended = { ...obj, spec: { ...obj.spec, suspend: true } };
      expect(cell(column, suspended)).toBe("Yes");
    }
  });

  it("Source names the source, its kind in the tooltip", () => {
    for (const name of ["kustomization", "helmrelease"]) {
      const obj = fixture(name);
      const column = columnOf(obj, "source")!;
      expect(column.paths).toEqual([...SOURCE_NAME_PATHS]);
      expect(column.tooltipPaths).toEqual([...SOURCE_KIND_PATHS]);
      expect(cell(column, obj)).toBe(sourceRefOf(obj)?.name);
    }
    const chartRef = { ...fixture("helmrelease"), spec: { chartRef: { kind: "OCIRepository", name: "podinfo-oci" } } } as KubeObject;
    expect(cell(columnOf(chartRef, "source")!, chartRef)).toBe("podinfo-oci");
  });
});

/** `obj` with its Ready condition changed. */
function withReady(obj: KubeObject, change: Record<string, string>): KubeObject {
  const conditions = ((obj.status?.conditions as Record<string, string>[] | undefined) ?? []).map((c) => (c.type === "Ready" ? { ...c, ...change } : c));
  return { ...obj, status: { ...obj.status, conditions } };
}

/** What Sextant's built-in rule (`fluxProblems` in src/features/problems/model.ts) said of an object. */
function builtIn(obj: KubeObject): { reason: string } | null {
  if (isSuspended(obj) || readyStatus(obj) !== "False") return null;
  const reason = readyReason(obj);
  if ((IN_PROGRESS_REASONS as readonly string[]).includes(reason ?? "")) return null;
  return { reason: reason ?? "NotReady" };
}

describe("the problem rules", () => {
  const rules = manifest.contributes.problems;
  const ruleOf = (obj: KubeObject) => rules.find((r) => r.kind.group === groupOf(obj.apiVersion) && r.kind.kind === obj.kind);

  it("judge the kinds the built-in rule judged, after 2 minutes, notifying", () => {
    expect(rules.map((r) => r.kind.kind)).toEqual([...PROBLEM_KINDS]);
    for (const rule of rules) {
      expect(rule.graceMinutes).toBe(2);
      expect(rule.notify).toBe(true);
    }
  });

  const variants = (obj: KubeObject): [string, KubeObject][] => [
    ["as it is", obj],
    ["failing", withReady(obj, { status: "False", reason: "SomethingFailed" })],
    ["failing and suspended", { ...withReady(obj, { status: "False", reason: "SomethingFailed" }), spec: { ...obj.spec, suspend: true } }],
    ["reconciling", withReady(obj, { status: "Unknown", reason: "Progressing" })],
    ...IN_PROGRESS_REASONS.map((reason): [string, KubeObject] => [`False with ${reason}`, withReady(obj, { status: "False", reason })]),
  ];

  it("find what the built-in rule found, since the Ready condition's last transition", () => {
    for (const obj of ALL) {
      const rule = ruleOf(obj);
      if (!rule) continue;
      for (const [name, variant] of variants(obj)) {
        const found = host.detectRule(rule, variant);
        const expected = builtIn(variant);
        expect(found.length, `${obj.kind} ${name}`).toBe(expected ? 1 : 0);
        if (!expected) continue;
        const ready = (variant.status?.conditions as Record<string, string>[]).find((c) => c.type === "Ready")!;
        expect(found[0]!.since).toBe(ready.lastTransitionTime);
        expect(found[0]!.graceMs).toBe(2 * 60_000);
        expect(found[0]!.reason).toBe(`${obj.kind} not ready`);
      }
    }
  });

  it("tell the failing Bucket of the fixtures", () => {
    const bucket = fixture("bucket");
    const found = host.detectRule(ruleOf(bucket), bucket);
    expect(builtIn(bucket)).toEqual({ reason: "BucketOperationFailed" });
    expect(found).toHaveLength(1);
    // The message names the first condition, which a field path can reach (here Reconciling, before Ready).
    expect(found[0]!.message).toBe("Ready is False. First condition, Reconciling: building artifact");
  });
});

describe("the actions", () => {
  const actions = manifest.contributes.actions;
  const action = (id: string) => actions.find((a) => a.id === id)! as (typeof actions)[number] & { when?: unknown };

  it("are Reconcile, Reconcile with source, Suspend and Resume, offered as the built-in ones were", () => {
    expect(actions.map((a) => [a.id, a.placement, a.multiple ?? false])).toEqual([
      ["reconcile", "primary", true],
      ["reconcile-with-source", "more", false],
      ["suspend", "primary", false],
      ["resume", "primary", true],
    ]);
    const kustomization = fixture("kustomization");
    const suspended = { ...kustomization, spec: { ...kustomization.spec, suspend: true } };
    const holds = (id: string, obj: KubeObject) => host.evaluate(action(id).when, obj).holds;
    expect(holds("suspend", kustomization)).toBe(true);
    expect(holds("suspend", suspended)).toBe(false);
    expect(holds("resume", kustomization)).toBe(false);
    expect(holds("resume", suspended)).toBe(true);
    for (const name of ["kustomization", "helmrelease"]) expect(holds("reconcile-with-source", fixture(name))).toBe(true);
    const chartRef = { ...fixture("helmrelease"), spec: { chartRef: { kind: "OCIRepository", name: "podinfo" } } } as KubeObject;
    expect(holds("reconcile-with-source", chartRef)).toBe(true);
    expect(holds("reconcile-with-source", { ...kustomization, spec: {} })).toBe(false);
  });

  it("send the built-in view's merge patches", () => {
    expect(reconcilePatch(new Date("2026-11-06T10:00:00Z"))).toEqual({
      metadata: { annotations: { [REQUESTED_AT_ANNOTATION]: "2026-11-06T10:00:00.000Z" } },
    });
    expect(REQUESTED_AT_ANNOTATION).toBe("reconcile.fluxcd.io/requestedAt");
    expect(suspendPatch(true)).toEqual({ spec: { suspend: true } });
    expect(suspendPatch(false)).toEqual({ spec: { suspend: false } });
  });

  it("reconcile a Kustomization's source first, a HelmRelease's repository and HelmChart first", () => {
    const k = fixture("kustomization");
    const self = { group: "kustomize.toolkit.fluxcd.io", kind: "Kustomization", namespace: "sextant-flux", name: "podinfo" };
    expect(withSourceOrder(k, self)).toEqual([
      { group: "source.toolkit.fluxcd.io", kind: "GitRepository", namespace: "sextant-flux", name: "podinfo" },
      self,
    ]);
    const hr = fixture("helmrelease");
    const release = { group: "helm.toolkit.fluxcd.io", kind: "HelmRelease", namespace: "sextant-flux", name: "podinfo-helm" };
    expect(withSourceOrder(hr, release).map((r) => `${r.kind}/${r.name}`)).toEqual([
      "HelmRepository/podinfo",
      `HelmChart/${helmChartOf(hr)!.name}`,
      "HelmRelease/podinfo-helm",
    ]);
  });
});

describe("relations", () => {
  it("read a Kustomization's inventory", () => {
    expect(inventoryOf(fixture("kustomization"))).toEqual([
      { group: "", kind: "Service", namespace: "sextant-flux", name: "podinfo" },
      { group: "apps", kind: "Deployment", namespace: "sextant-flux", name: "podinfo" },
      { group: "autoscaling", kind: "HorizontalPodAutoscaler", namespace: "sextant-flux", name: "podinfo" },
    ]);
    const odd = { ...fixture("kustomization"), status: { inventory: { entries: [{ id: "_system__admin_rbac.authorization.k8s.io_ClusterRole", v: "v1" }, { id: "bad" }] } } };
    expect(inventoryOf(odd as KubeObject)).toEqual([{ group: "rbac.authorization.k8s.io", kind: "ClusterRole", namespace: null, name: "system:admin" }]);
  });

  it("find who uses a source, by group, kind, name and namespace", () => {
    expect(usesSource(fixture("kustomization"), fixture("gitrepository"))).toBe(true);
    expect(usesSource(fixture("helmrelease"), fixture("helmrepository"))).toBe(true);
    expect(usesSource(fixture("kustomization"), fixture("helmrepository"))).toBe(false);
  });

  it("look for a HelmRelease's objects by helm-controller's labels in its target and storage namespaces", () => {
    const hr = fixture("helmrelease");
    expect(helmReleaseSelector(hr)).toBe("helm.toolkit.fluxcd.io/name=podinfo-helm,helm.toolkit.fluxcd.io/namespace=sextant-flux");
    expect(helmReleaseNamespaces(hr)).toEqual(["sextant-flux"]);
    expect(helmReleaseNamespaces({ ...hr, spec: { targetNamespace: "apps", storageNamespace: "flux-system" } })).toEqual(["apps", "flux-system"]);
    expect(LABELLED_KINDS).toHaveLength(11);
  });

  it("are readable: the manifest grants Read on the Flux kinds and the labelled kinds, Modify on the Flux kinds", () => {
    const [read, modify] = manifest.permissions.rules;
    const kinds = (rule: typeof read) => (rule!.kinds as { kinds: { group: string; kind: string }[] }).kinds.map((k) => `${k.group}/${k.kind}`);
    expect(kinds(read)).toEqual([...FLUX_KINDS, ...LABELLED_KINDS].map((k) => `${k.group}/${k.kind}`));
    expect(read!.actions).toEqual(["read"]);
    expect(kinds(modify)).toEqual(FLUX_KINDS.map((k) => `${k.group}/${k.kind}`));
    expect(modify!.actions).toEqual(["modify"]);
    expect(modify!.confirm).toBe(true);
  });
});
