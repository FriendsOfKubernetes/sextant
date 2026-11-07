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
  usesSource,
  withSourceOrder,
} from "./flux";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as KubeObject;
const ALL = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && f !== "helm-deployment.json")
  .map((f) => fixture(f.replace(/\.json$/, "")));

// Sextant's own evaluator of extension conditions and field paths (src/extensions/problemRules.ts): what the window
// runs for this manifest.
type Verdict = { holds: boolean; since?: string; activeFrom?: number; until?: number };
type Detected = { reason: string; group?: string; message?: string; since?: string; graceMs?: number; notify: boolean };
const rulesPath = join(here, "../../../src/extensions/problemRules.ts");
const host = (await import(/* @vite-ignore */ rulesPath)) as {
  evaluate: (condition: unknown, obj: KubeObject) => Verdict;
  valueAt: (obj: unknown, path: string) => unknown;
  detectRule: (rule: unknown, obj: KubeObject) => Detected[];
  fillTemplate: (template: string, obj: KubeObject) => string | null;
};

type Column = (typeof manifest.contributes.columns)[number] & {
  paths: string[];
  afterColumn: string;
  cases?: { when: unknown; text: string; tone: string }[];
  tooltipPaths?: string[];
  tones?: Record<string, string>;
};
const columns = manifest.contributes.columns as Column[];
const columnOf = (obj: KubeObject, name: string) =>
  columns.find((c) => c.id === `${name}-${obj.kind!.toLowerCase()}` && c.kind.group === groupOf(obj.apiVersion));

/**
 * A computed cell's text as the window draws it (`cellOf` in src/extensions/columns.tsx): the first case that holds
 * and whose placeholders all have a value, filled; else the first path.
 */
function cell(column: Column, obj: KubeObject): string | undefined {
  for (const c of column.cases ?? []) {
    if (!host.evaluate(c.when, obj).holds) continue;
    const filled = host.fillTemplate(c.text, obj);
    if (filled !== null) return filled;
  }
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
    // The section has the built-in one's title, icon and place (after Velero in Sextant's SIDEBAR_SECTIONS).
    expect(manifest.contributes.sections).toEqual([{ section: "flux", title: "Flux", icon: "flux", after: "velero" }]);
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

  it("leave the CRDs' printer columns out, and the palette finds `hr` and `ks` as it did, without being asked", () => {
    type Kind = (typeof manifest.contributes.kinds)[number] & { aliases?: string[]; searchByDefault?: boolean; printerColumns?: boolean };
    const kinds = manifest.contributes.kinds as Kind[];
    expect(kinds.every((k) => k.printerColumns === false)).toBe(true);
    expect(kinds.filter((k) => k.aliases).map((k) => [k.kind, k.aliases, k.searchByDefault])).toEqual([
      ["Kustomization", ["ks"], true],
      ["HelmRelease", ["hr"], true],
    ]);
    expect(kinds.filter((k) => k.searchByDefault).length).toBe(2);
  });

  it("every fixture is one of them", () => {
    for (const obj of ALL) expect(fluxKind(groupOf(obj.apiVersion), obj.kind), obj.kind).toBeDefined();
  });
});

const TITLES: Record<string, string> = { source: "Source", ready: "Ready", status: "Status", revision: "Revision", suspended: "Suspended" };

describe("the columns", () => {
  it("are, after Namespace, Source (Kustomization, HelmRelease), Ready, Status, Revision, Suspended, by column id", () => {
    expect(columns.length).toBeLessThanOrEqual(100);
    for (const kind of FLUX_KINDS) {
      const own = columns.filter((c) => c.kind.group === kind.group && c.kind.kind === kind.kind);
      const expected = [
        ...(["Kustomization", "HelmRelease"].includes(kind.kind) ? ["source"] : []),
        ...(kind.status ? ["ready", "status", "revision"] : []),
        "suspended",
      ];
      expect(own.map((c) => c.id.split("-")[0]), kind.kind).toEqual(expected);
      expect(own.map((c) => c.title)).toEqual(expected.map((id) => TITLES[id]));
      // Each goes right after the one before it, the first after Namespace: the same in every language.
      expect(own.map((c) => c.afterColumn)).toEqual(["namespace", ...own.slice(0, -1).map((c) => c.id)]);
      expect(own.every((c) => !("after" in c) && !("jsonPath" in c))).toBe(true);
    }
  });

  it("read the Ready condition by its type, never the first condition", () => {
    const text = JSON.stringify(manifest.contributes);
    expect(text).not.toContain("conditions[0]");
    expect(text).not.toContain("conditions[?(");
  });

  it("Ready shows the Ready condition's status, toned as the built-in table toned it", () => {
    const tones = { True: "ok", False: "error", Unknown: "warning" };
    for (const obj of ALL) {
      const column = columnOf(obj, "ready");
      if (!column) {
        expect(["Alert", "Provider"]).toContain(obj.kind);
        continue;
      }
      expect(column.paths).toEqual(['.status.conditions[type="Ready"].status']);
      expect(cell(column, obj), obj.kind).toBe(readyStatus(obj));
      expect(column.tones).toEqual(tones);
    }
    const bucket = fixture("bucket");
    // Its first condition is Reconciling: the path finds Ready all the same.
    expect(cell(columnOf(bucket, "ready")!, bucket)).toBe("False");
    const unknown = withReady(fixture("kustomization"), { status: "Unknown", reason: "Progressing" });
    expect(cell(columnOf(unknown, "ready")!, unknown)).toBe("Unknown");
  });

  it("Status is the Ready condition's message, whole in its tooltip", () => {
    for (const obj of ALL) {
      const column = columnOf(obj, "status");
      if (!column) continue;
      expect(cell(column, obj), obj.kind).toBe(readyMessage(obj));
      expect(column.tooltipPaths).toEqual(column.paths);
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

  it("Suspended says Yes or No, toned by the case so a translated word keeps its tone", () => {
    for (const obj of ALL) {
      const column = columnOf(obj, "suspended")!;
      expect(column.cases?.map((c) => [c.text, c.tone])).toEqual([
        ["Yes", "warning"],
        ["No", "neutral"],
      ]);
      expect(column.tones).toBeUndefined();
      expect(cell(column, obj), obj.kind).toBe(isSuspended(obj) ? "Yes" : "No");
      const suspended = { ...obj, spec: { ...obj.spec, suspend: true } };
      expect(cell(column, suspended)).toBe("Yes");
    }
  });

  it("Source shows Kind/name, or Kind/namespace/name of a source in another namespace, as the built-in table did", () => {
    /** The built-in column's text (`sourceText` in src/features/flux/columns.tsx). */
    const builtInSource = (obj: KubeObject) => {
      const ref = sourceRefOf(obj);
      if (!ref) return undefined;
      const ns = ref.namespace && ref.namespace !== obj.metadata.namespace ? `${ref.namespace}/` : "";
      return `${ref.kind}/${ns}${ref.name}`;
    };
    const kustomization = fixture("kustomization");
    const release = fixture("helmrelease");
    const chart = (release.spec as { chart: { spec: Record<string, unknown> } }).chart;
    const variants: KubeObject[] = [
      kustomization,
      release,
      { ...kustomization, spec: { ...kustomization.spec, sourceRef: { kind: "GitRepository", name: "fleet", namespace: "flux-system" } } },
      { ...kustomization, spec: { ...kustomization.spec, sourceRef: { kind: "GitRepository", name: "own", namespace: "sextant-flux" } } },
      { ...kustomization, spec: { ...kustomization.spec, sourceRef: { kind: "OCIRepository", name: "blank", namespace: "" } } },
      { ...release, spec: { ...release.spec, chart: { spec: { ...chart.spec, sourceRef: { kind: "HelmRepository", name: "charts", namespace: "infra" } } } } },
      { ...release, spec: { chartRef: { kind: "OCIRepository", name: "podinfo-oci" } } },
      { ...release, spec: { chartRef: { kind: "OCIRepository", name: "podinfo-oci", namespace: "oci" } } },
    ] as KubeObject[];
    for (const obj of variants) {
      const column = columnOf(obj, "source")!;
      expect(column.paths).toEqual([...SOURCE_NAME_PATHS]);
      expect(column.tooltipPaths).toEqual([...SOURCE_KIND_PATHS]);
      expect(column.cases!.length).toBeLessThanOrEqual(10);
      expect(cell(column, obj), JSON.stringify(obj.spec)).toBe(builtInSource(obj));
    }
    expect(variants.map((obj) => cell(columnOf(obj, "source")!, obj))).toEqual([
      "GitRepository/podinfo",
      "HelmRepository/podinfo",
      "GitRepository/flux-system/fleet",
      "GitRepository/own",
      "OCIRepository/blank",
      "HelmRepository/infra/charts",
      "OCIRepository/podinfo-oci",
      "OCIRepository/oci/podinfo-oci",
    ]);
    // Without a kind no case holds (Flux requires one): the name alone.
    const noKind = { ...kustomization, spec: { sourceRef: { name: "podinfo" } } } as KubeObject;
    expect(cell(columnOf(noKind, "source")!, noKind)).toBe("podinfo");
  });
});

/** `obj` with its Ready condition changed. */
function withReady(obj: KubeObject, change: Record<string, string>): KubeObject {
  const conditions = ((obj.status?.conditions as Record<string, string>[] | undefined) ?? []).map((c) => (c.type === "Ready" ? { ...c, ...change } : c));
  return { ...obj, status: { ...obj.status, conditions } };
}

/** What Sextant's built-in rule (`fluxProblems` in src/features/problems/model.ts) said of an object. */
function builtIn(obj: KubeObject): { reason: string; message: string | undefined } | null {
  if (isSuspended(obj) || readyStatus(obj) !== "False") return null;
  const reason = readyReason(obj);
  if ((IN_PROGRESS_REASONS as readonly string[]).includes(reason ?? "")) return null;
  return { reason: reason ?? "NotReady", message: readyMessage(obj) };
}

describe("the problem rules", () => {
  const rules = manifest.contributes.problems;
  const ruleOf = (obj: KubeObject) => rules.find((r) => r.kind.group === groupOf(obj.apiVersion) && r.kind.kind === obj.kind);

  it("judge the kinds the built-in rule judged, after 2 minutes, notifying once per object as its group did", () => {
    expect(rules.map((r) => r.kind.kind)).toEqual([...PROBLEM_KINDS]);
    for (const rule of rules) {
      expect(rule.graceMinutes).toBe(2);
      expect(rule.notify).toBe(true);
      expect(rule.group).toBe("not-ready");
      expect(rule.since).toBe('.status.conditions[type="Ready"].lastTransitionTime');
      // Flux's own reason and message, as the built-in rule told them.
      expect(rule.reason).toBe('{{.status.conditions[type="Ready"].reason}}');
      expect(rule.message).toBe('{{.status.conditions[type="Ready"].message}}');
    }
  });

  const variants = (obj: KubeObject): [string, KubeObject][] => [
    ["as it is", obj],
    ["failing", withReady(obj, { status: "False", reason: "SomethingFailed" })],
    ["failing and suspended", { ...withReady(obj, { status: "False", reason: "SomethingFailed" }), spec: { ...obj.spec, suspend: true } }],
    ["reconciling", withReady(obj, { status: "Unknown", reason: "Progressing" })],
    ...IN_PROGRESS_REASONS.map((reason): [string, KubeObject] => [`False with ${reason}`, withReady(obj, { status: "False", reason })]),
  ];

  it("find what the built-in rule found, with its reason and message, since the Ready condition's last transition", () => {
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
        expect(found[0]!.reason).toBe(expected.reason);
        expect(found[0]!.group).toBe("not-ready");
        expect(found[0]!.message).toBe(expected.message ?? "");
      }
    }
  });

  it("tell the failing Bucket of the fixtures", () => {
    const bucket = fixture("bucket");
    const found = host.detectRule(ruleOf(bucket), bucket);
    expect(builtIn(bucket)).toEqual({ reason: "BucketOperationFailed", message: readyMessage(bucket) });
    expect(found).toHaveLength(1);
    // The Ready condition's reason and its whole message, though Reconciling comes first in the list.
    expect(found[0]!.reason).toBe("BucketOperationFailed");
    expect(found[0]!.message).toBe(readyMessage(bucket));
    expect(found[0]!.message).toContain("failed to confirm existence of 'assets' bucket");
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

  it("send the built-in view's merge patches: Reconcile now, Suspend and Resume fixed in the manifest, sent by Sextant", () => {
    type Fixed = { patch?: unknown; ask?: { title: string; text: string; confirm: string }; done?: string };
    const fixed = (id: string) => action(id) as Fixed;
    expect(REQUESTED_AT_ANNOTATION).toBe("reconcile.fluxcd.io/requestedAt");
    // Sextant fills `{{now}}` with the time it sends the patch, as Reconcile with source's frame does.
    expect(fixed("reconcile").patch).toEqual({ metadata: { annotations: { [REQUESTED_AT_ANNOTATION]: "{{now}}" } } });
    expect(reconcilePatch(new Date("2026-11-06T10:00:00Z"))).toEqual({
      metadata: { annotations: { [REQUESTED_AT_ANNOTATION]: "2026-11-06T10:00:00.000Z" } },
    });
    expect(fixed("suspend").patch).toEqual({ spec: { suspend: true } });
    expect(fixed("resume").patch).toEqual({ spec: { suspend: false } });
    // Reconcile with source reads the object to find its source, so its frame sends it: out of sight (`headless`), one
    // click with no window, as the built-in action was. Only it has a frame; the fixed patches are never headless.
    expect(fixed("reconcile-with-source").patch).toBeUndefined();
    expect(actions.filter((a) => (a as { headless?: boolean }).headless === true).map((a) => a.id)).toEqual(["reconcile-with-source"]);
    // Only Suspend asks, with the built-in view's question naming the object (Sextant fills `{{kind}}` and `{{name}}` on
    // an action of one object); none says anything after, as the built-in ones did.
    expect(fixed("suspend").ask).toEqual({
      title: "Suspend {{kind}} {{name}}?",
      text: "Flux stops reconciling {{kind}} {{name}} until it is resumed: changes in Git or in the cluster are not applied or corrected meanwhile.",
      confirm: "Suspend",
    });
    expect(action("suspend").multiple).toBeUndefined();
    const fill = (text: string) => text.replace(/\{\{(kind|name)\}\}/g, (_, key: string) => (key === "kind" ? "Kustomization" : "podinfo"));
    expect(fill(fixed("suspend").ask!.title)).toBe("Suspend Kustomization podinfo?");
    for (const id of ["reconcile", "reconcile-with-source", "resume"]) expect(fixed(id).ask, id).toBeUndefined();
    for (const a of actions) expect((a as Fixed).done, a.id).toBeUndefined();
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
      { group: "", version: "v1", kind: "Service", namespace: "sextant-flux", name: "podinfo" },
      { group: "apps", version: "v1", kind: "Deployment", namespace: "sextant-flux", name: "podinfo" },
      { group: "autoscaling", version: "v2", kind: "HorizontalPodAutoscaler", namespace: "sextant-flux", name: "podinfo" },
    ]);
    const odd = { ...fixture("kustomization"), status: { inventory: { entries: [{ id: "_system__admin_rbac.authorization.k8s.io_ClusterRole", v: "v1" }, { id: "bad" }, { id: "ns_x_apps_Deployment" }] } } };
    expect(inventoryOf(odd as KubeObject)).toEqual([
      { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRole", namespace: null, name: "system:admin" },
      // No version: Sextant takes the kind's own when the link is opened.
      { group: "apps", kind: "Deployment", namespace: "ns", name: "x" },
    ]);
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

  it("are readable: the manifest grants Read on the Flux kinds and the labelled kinds, Modify on the Flux kinds unconfirmed", () => {
    const [read, modify] = manifest.permissions.rules;
    const kinds = (rule: typeof read) => (rule!.kinds as { kinds: { group: string; kind: string }[] }).kinds.map((k) => `${k.group}/${k.kind}`);
    expect(kinds(read)).toEqual([...FLUX_KINDS, ...LABELLED_KINDS].map((k) => `${k.group}/${k.kind}`));
    expect(read!.actions).toEqual(["read"]);
    expect(kinds(modify)).toEqual(FLUX_KINDS.map((k) => `${k.group}/${k.kind}`));
    expect(modify!.actions).toEqual(["modify"]);
    // The questions are Sextant's `ask` of Suspend and nothing else, as in the built-in view: no confirmation on top.
    expect(modify!.confirm).toBe(false);
  });
});
