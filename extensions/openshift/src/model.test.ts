// The model and the manifest's declarative parts. The manifest's problem rules, the kinds' "Only problems"
// (`problemWhen`) and the columns are judged here by Sextant's own window engine (src/extensions/problemRules.ts and
// columns.tsx, loaded at run time so the type check stays inside the extension) and compared with the model they
// replace — the reading of Sextant's former built-in view (ADR-0120), ported unchanged — on its fixtures and variants
// of them. Where the manifest cannot say what the built-in said, the test pins the difference the README lists.
import type { KubeObject } from "@sextant/extension-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import objectsJson from "../fixtures/objects.json";
import en from "./locales/en.json";
import {
  BUILD,
  buildConfigOf,
  buildDurationMs,
  buildPhase,
  buildPodName,
  buildReason,
  buildSource,
  buildsOf,
  buildStrategy,
  bcTriggers,
  DC_TONE,
  dcReason,
  dcReplicas,
  dcState,
  dcTriggers,
  DEPLOYMENT_CONFIG,
  failedImports,
  FAILED_BUILD_MS,
  fnv32a,
  IMAGE_STREAM,
  IMPORT_GRACE_MS,
  isProblem,
  labelValue,
  latestFailuresOnly,
  latestVersionOf,
  openshiftProblems,
  projectInfo,
  rolloutBlock,
  rolloutsOf,
  ROUTE,
  ROUTE_GRACE_MS,
  ROUTE_TONE,
  routeBackends,
  routeHost,
  routeReason,
  routeState,
  routeTargetPort,
  routeTls,
  routeUrl,
  streamRepositories,
  streamTags,
  type Detected,
} from "./model";
import { rolloutLatestRequest, sortedJson, startBuildRequest } from "./requests";

const objects = objectsJson as unknown as KubeObject[];
const copy = <T>(value: T): T => structuredClone(value);
const find = (kind: string, name: string): KubeObject => copy(objects.find((o) => o.kind === kind && o.metadata.name === name)!);
const all = (kind: string): KubeObject[] => objects.filter((o) => o.kind === kind).map(copy);
const st = (o: KubeObject) => (o.status ??= {}) as Record<string, unknown>;
const sp = (o: KubeObject) => (o.spec ??= {}) as Record<string, unknown>;
type Cond = { type: string; status?: string; reason?: string; message?: string; lastTransitionTime?: string };
const conditions = (o: KubeObject) => (st(o).conditions ?? []) as Cond[];
const at = (iso: string) => Date.parse(iso);

// ---------- Sextant's window engine ----------

interface Verdict {
  holds: boolean;
  activeFrom?: number;
  until?: number;
}
interface WindowDetected {
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
  detectRule(rule: unknown, obj: KubeObject): WindowDetected[];
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
let columns: Columns;
const here = dirname(fileURLToPath(import.meta.url));
beforeAll(async () => {
  engine = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/problemRules.ts"))) as Engine;
  columns = (await import(/* @vite-ignore */ join(here, "../../../src/extensions/columns.tsx"))) as Columns;
  // Sextant's own texts, so lists join as in the window (`common:list.separator`).
  const { startI18n } = (await import(/* @vite-ignore */ join(here, "../../../src/i18n/index.ts"))) as { startI18n(language: string): Promise<unknown> };
  await startI18n("en");
});

// ---------- The model, as the built-in view's tests had it ----------

describe("the model", () => {
  it("reads a Route's backends with their shares, its target port, TLS flags and where it answers", () => {
    const route = find("Route", "frontend");
    expect(routeBackends(route).map((b) => [b.name, b.weight, b.percent])).toEqual([
      ["frontend", 100, 80],
      ["frontend-canary", 25, 20],
    ]);
    expect(routeTargetPort(route)).toBe("8080-tcp");
    expect(routeTargetPort(find("Route", "api"))).toBe(8443);
    expect(routeTargetPort(find("Route", "internal"))).toBeUndefined();
    expect(routeTls(route)).toEqual({
      termination: "edge",
      insecure: "Redirect",
      certificate: true,
      key: true,
      caCertificate: true,
      destinationCACertificate: false,
      externalCertificate: undefined,
    });
    expect(JSON.stringify(routeTls(route))).not.toMatch(/BEGIN|FIXTURE/);
    expect(routeUrl(route)).toBe("https://frontend-shop.apps.ocp.example.com/");
    expect(routeUrl(find("Route", "internal"))).toBe("http://internal.shard2.example.com");
  });

  it("tells a private key Sextant hid from the extension as set", () => {
    // As `resources.get` hands the Route over: the key blanked and named in Sextant's annotation (ADR-0120).
    const route = find("Route", "frontend");
    (sp(route).tls as Record<string, unknown>).key = "";
    route.metadata.annotations = { "sextant.dev/values-hidden": "spec.tls.key" };
    expect(routeTls(route)?.key).toBe(true);
    route.metadata.annotations = {};
    expect(routeTls(route)?.key).toBe(false);
  });

  it.each([
    ["frontend", "admitted"],
    ["api", "rejected"],
    ["internal", "pending"],
  ])("Route %s is %s", (name, state) => {
    expect(routeState(find("Route", name))).toBe(state);
  });

  it("lists a DeploymentConfig's rollouts and blocks Rollout latest as oc does", () => {
    const rcs = all("ReplicationController");
    const frontend = find("DeploymentConfig", "frontend");
    expect(rolloutsOf(frontend, rcs).map((r) => [r.name, r.version, r.phase, r.deployerPod])).toEqual([
      ["frontend-2", 2, "Complete", "frontend-2-deploy"],
      ["frontend-1", 1, "Complete", "frontend-1-deploy"],
    ]);
    expect(rolloutBlock(frontend, rcs)).toBeUndefined();
    expect(rolloutBlock(find("DeploymentConfig", "backend"), rcs)).toBe("inProgress");
    sp(frontend).paused = true;
    expect(rolloutBlock(frontend, rcs)).toBe("paused");
    expect(rolloutBlock(find("DeploymentConfig", "backend"), [])).toBeUndefined();
  });

  it("names the build pod by its annotation, else as the build controller does", () => {
    expect(buildPodName(find("Build", "ruby-ex-3"))).toBe("ruby-ex-3-build");
    expect(buildPodName(find("Build", "nodejs-ex-1"))).toBe("nodejs-ex-1-build");
    const long = find("Build", "nodejs-ex-1");
    const name = `${"a".repeat(55)}-12`;
    long.metadata = { ...long.metadata, name, annotations: {} };
    const expected = `${name.slice(0, 48)}-${fnv32a(name).toString(16).padStart(8, "0")}-build`;
    expect(buildPodName(long)).toBe(expected);
    expect(expected).toHaveLength(63);
    // Go's hash/fnv New32a of "a": 0xe40c292c.
    expect(fnv32a("a")).toBe(0xe40c292c);
    expect(labelValue(`${"b".repeat(62)}-x`)).toBe("b".repeat(62));
  });

  it("reads a BuildConfig's source without the credentials or the query of its URI, and its builds newest first", () => {
    const bc = find("BuildConfig", "ruby-ex");
    expect(buildSource(bc)).toEqual({ type: "Git", uri: "https://github.com/sclorg/ruby-ex.git", ref: "master", contextDir: "/", dockerfile: false, secret: "github-clone" });
    expect(buildsOf(bc, all("Build")).map((b) => b.metadata.name)).toEqual(["ruby-ex-3", "ruby-ex-2"]);
    expect(buildDurationMs(find("Build", "ruby-ex-3"))).toBe(120_000);
    expect(buildDurationMs(find("Build", "nodejs-ex-1"))).toBe(177_000);
  });

  it("merges an ImageStream's spec and status tags and tells a failing import", () => {
    const tags = streamTags(find("ImageStream", "legacy-db"));
    expect(tags.map((t) => [t.name, t.image, t.importError?.reason, t.history])).toEqual([
      ["10", undefined, "NotFound", 0],
      ["11", "sha256:bb22", undefined, 1],
    ]);
    expect(streamTags(find("ImageStream", "frontend"))[0]).toMatchObject({ name: "latest", scheduled: true, history: 2, from: { kind: "DockerImage" } });
  });

  it("builds the requests oc sends, with the same text the core sends", () => {
    const dc = rolloutLatestRequest(find("DeploymentConfig", "frontend"));
    expect(dc.path).toBe("/apis/apps.openshift.io/v1/namespaces/shop/deploymentconfigs/frontend/instantiate");
    // `crates/sextant-core/src/resources/openshift.rs`, `the_bodies_are_what_oc_sends`.
    expect(sortedJson(dc.body)).toBe('{"apiVersion":"apps.openshift.io/v1","force":true,"kind":"DeploymentRequest","latest":true,"name":"frontend"}');
    const bc = startBuildRequest(find("BuildConfig", "ruby-ex"));
    expect(bc.path).toBe("/apis/build.openshift.io/v1/namespaces/shop/buildconfigs/ruby-ex/instantiate");
    expect(sortedJson({ ...bc.body, metadata: { name: "ruby" } })).toBe(
      '{"apiVersion":"build.openshift.io/v1","dockerStrategyOptions":{},"kind":"BuildRequest","metadata":{"name":"ruby"},"sourceStrategyOptions":{},"triggeredBy":[{"message":"Manually triggered"}]}',
    );
  });
});

// ---------- The problem rules against the built-in ones ----------

type Rule = (typeof manifest.contributes.problems)[number];
const RULES = manifest.contributes.problems as Rule[];
const rulesOf = (kind: string) => RULES.filter((r) => r.kind.kind === kind);
const KIND = { Route: ROUTE, DeploymentConfig: DEPLOYMENT_CONFIG, Build: BUILD, ImageStream: IMAGE_STREAM } as const;
type ProblemKind = keyof typeof KIND;

/** The window's start of a problem: `activeFrom`, else the grace after `since`; a problem without either counts at once. */
const windowStart = (d: WindowDetected) => d.activeFrom ?? (d.graceMs && d.since ? at(d.since) + d.graceMs : -Infinity);
const builtInStart = (d: Detected) => (d.graceMs && d.since ? at(d.since) + d.graceMs : -Infinity);
const live = (start: number, until: number | undefined, now: number) => start <= now && (until === undefined || until > now);

/** The built-in groups by the manifest's names. */
const GROUP: Record<string, string> = { notAdmitted: "not-admitted", rolloutFailed: "rollout-failed", buildFailed: "build-failed", importFailed: "import-failed" };

function windowFound(kind: ProblemKind, obj: KubeObject, now: number) {
  return rulesOf(kind)
    .flatMap((rule) => engine.detectRule(rule, obj))
    .filter((d) => live(windowStart(d), d.until, now))
    .map((d) => ({ reason: d.reason, group: d.group, message: d.message, since: d.since, until: d.until, start: windowStart(d), notify: d.notify ?? true }));
}

function builtInFound(kind: ProblemKind, obj: KubeObject, now: number) {
  return openshiftProblems(KIND[kind], obj)
    .filter((d) => live(builtInStart(d), d.until, now))
    .map((d) => ({
      reason: d.reason,
      group: GROUP[d.group!]!,
      // Sextant shows the cluster's words; without them, nothing.
      message: d.message ?? "",
      since: d.since,
      until: d.until,
      start: builtInStart(d),
      notify: d.notify,
    }));
}

const TIMES = [
  "2026-10-20T09:01:00Z",
  "2026-10-20T09:03:00Z",
  "2026-10-21T07:03:00Z",
  "2026-10-21T07:06:00Z",
  "2026-10-21T08:01:00Z",
  "2026-10-21T08:03:00Z",
  "2026-10-21T13:00:00Z",
  "2026-10-22T10:00:30Z",
  "2026-10-22T12:02:00Z",
  "2026-10-22T12:04:00Z",
  "2030-01-01T00:00:00Z",
].map(at);

function expectSame(kind: ProblemKind, obj: KubeObject, label: string): void {
  for (const now of TIMES) expect(windowFound(kind, obj, now), `${label} at ${new Date(now).toISOString()}`).toEqual(builtInFound(kind, obj, now));
}

const withCondition = (o: KubeObject, c: Cond) => {
  st(o).conditions = [...conditions(o).filter((x) => x.type !== c.type), c];
  return o;
};
const without = (o: KubeObject, type: string) => {
  st(o).conditions = conditions(o).filter((x) => x.type !== type);
  return o;
};

function routeVariants(): [string, KubeObject][] {
  const ingress = (o: KubeObject) => (st(o).ingress as { conditions: Cond[]; host?: string; routerName?: string }[]);
  const out: [string, KubeObject][] = [
    ["admitted", find("Route", "frontend")],
    ["rejected", find("Route", "api")],
    ["no router answered", find("Route", "internal")],
  ];
  const add = (label: string, make: (o: KubeObject) => void, base = () => find("Route", "api")) => {
    const o = base();
    make(o);
    out.push([label, o]);
  };
  add("rejected without a message", (o) => delete ingress(o)[0]!.conditions[0]!.message);
  add("rejected without a reason", (o) => delete ingress(o)[0]!.conditions[0]!.reason);
  add("rejected without words", (o) => {
    delete ingress(o)[0]!.conditions[0]!.reason;
    delete ingress(o)[0]!.conditions[0]!.message;
  });
  add("rejected without a time", (o) => delete ingress(o)[0]!.conditions[0]!.lastTransitionTime);
  add("deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-21T08:30:00Z"));
  add("unknown answer", (o) => (ingress(o)[0]!.conditions[0]!.status = "Unknown"));
  add("rejected by one router, admitted by another", (o) =>
    ingress(o).push({ routerName: "shard2", host: "api.shard2.example.com", conditions: [{ type: "Admitted", status: "True", lastTransitionTime: "2026-10-21T08:00:03Z" }] }),
  );
  add("rejected by a second router", (o) =>
    ingress(o).unshift({ routerName: "shard2", host: "api.shard2.example.com", conditions: [{ type: "Admitted", status: "Unknown" }] }),
  );
  return out;
}

function dcVariants(): [string, KubeObject][] {
  const backend = () => find("DeploymentConfig", "backend");
  const failure = (message?: string, reason = "FailedCreate"): Cond => ({ type: "ReplicaFailure", status: "True", reason, message, lastTransitionTime: "2026-10-21T12:05:00Z" });
  const progressing = (patch: Partial<Cond>): Cond => ({ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded", message: "rc failed", lastTransitionTime: "2026-10-21T12:10:00Z", ...patch });
  const unavailable = (message?: string): Cond => ({ type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message, lastTransitionTime: "2026-10-21T12:00:00Z" });
  const out: [string, KubeObject][] = [
    ["available", find("DeploymentConfig", "frontend")],
    ["progress deadline exceeded", backend()],
  ];
  const add = (label: string, make: (o: KubeObject) => void, base = backend) => {
    const o = base();
    make(o);
    out.push([label, o]);
  };
  add("could not create its RC", (o) => withCondition(o, progressing({ reason: "ReplicationControllerCreateError", message: undefined })));
  add("Progressing False without words, ReplicaFailure with them", (o) => {
    withCondition(o, progressing({ reason: "", message: undefined }));
    withCondition(o, failure("pods are forbidden"));
  });
  add("Progressing False without words, nothing else", (o) => {
    withCondition(o, progressing({ reason: "", message: "" }));
    withCondition(o, failure(undefined, ""));
  });
  add("Progressing False without words, Available's", (o) => {
    withCondition(o, progressing({ reason: "", message: "" }));
    withCondition(o, failure(undefined, ""));
    withCondition(o, unavailable("not enough pods"));
  });
  add("ReplicaFailure while progressing", (o) => {
    withCondition(o, progressing({ status: "True", reason: "ReplicationControllerUpdated" }));
    withCondition(o, failure("quota exceeded"));
  });
  add("ReplicaFailure without words, Available's", (o) => {
    withCondition(o, progressing({ status: "True", reason: "ReplicationControllerUpdated", message: undefined }));
    withCondition(o, failure(undefined, ""));
    withCondition(o, unavailable("not enough pods"));
  });
  add("ReplicaFailure without words, the details'", (o) => {
    without(o, "Progressing");
    withCondition(o, failure(undefined, ""));
    st(o).details = { message: "config change" };
  });
  add("deadline while still progressing", (o) => withCondition(o, progressing({ status: "True" })));
  add("deadline while still progressing, Available's words", (o) => {
    withCondition(o, progressing({ status: "Unknown", message: undefined }));
    withCondition(o, unavailable("not enough pods"));
  });
  add("deadline without a time", (o) => withCondition(o, progressing({ lastTransitionTime: undefined })));
  add("paused", (o) => (sp(o).paused = true));
  add("deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-21T12:30:00Z"));
  add("cancelled", (o) => withCondition(o, progressing({ reason: "RolloutCancelled" })));
  add("rolling out", (o) => withCondition(o, progressing({ status: "True", reason: "ReplicationControllerUpdated" })));
  add("never deployed", (o) => {
    st(o).conditions = [];
    st(o).latestVersion = 0;
  });
  return out;
}

function buildVariants(): [string, KubeObject][] {
  const out: [string, KubeObject][] = [
    ["failed", find("Build", "ruby-ex-2")],
    ["errored", find("Build", "nodejs-ex-1")],
    ["complete", find("Build", "ruby-ex-3")],
  ];
  const add = (label: string, make: (o: KubeObject) => void, base = () => find("Build", "ruby-ex-2")) => {
    const o = base();
    make(o);
    out.push([label, o]);
  };
  add("failed without a completion", (o) => delete st(o).completionTimestamp);
  add("failed without a completion or a start", (o) => {
    delete st(o).completionTimestamp;
    delete st(o).startTimestamp;
  });
  add("failed without a reason or a message", (o) => {
    delete st(o).reason;
    delete st(o).message;
  });
  add("errored without a reason", (o) => delete st(o).reason, () => find("Build", "nodejs-ex-1"));
  add("deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-21T10:30:00Z"));
  add("cancelled", (o) => (st(o).phase = "Cancelled"));
  add("running", (o) => (st(o).phase = "Running"));
  return out;
}

function imageStreamVariants(): [string, KubeObject][] {
  const tags = (o: KubeObject) => st(o).tags as { tag: string; conditions?: Cond[] }[];
  const out: [string, KubeObject][] = [
    ["one import fails", find("ImageStream", "legacy-db")],
    ["no import fails", find("ImageStream", "frontend")],
  ];
  const add = (label: string, make: (o: KubeObject) => void) => {
    const o = find("ImageStream", "legacy-db");
    make(o);
    out.push([label, o]);
  };
  add("the failing import says only a reason", (o) => delete tags(o)[0]!.conditions![0]!.message);
  add("two imports fail, the first by name the earlier", (o) =>
    (tags(o)[1]!.conditions = [{ type: "ImportSuccess", status: "False", reason: "Unauthorized", message: "unauthorized", lastTransitionTime: "2026-10-21T07:02:00Z" }]),
  );
  add("the import succeeds again", (o) => (tags(o)[0]!.conditions![0]!.status = "True"));
  add("deleting", (o) => (o.metadata.deletionTimestamp = "2026-10-21T07:30:00Z"));
  return out;
}

describe("the problem rules, against the built-in ones", () => {
  it("judge only the four kinds of the category, at most once each, with its graces", () => {
    expect([...new Set(RULES.map((r) => r.kind.kind))].sort()).toEqual(["Build", "DeploymentConfig", "ImageStream", "Route"]);
    expect(RULES.find((r) => r.id === "route-not-admitted")!.graceMinutes! * 60_000).toBe(ROUTE_GRACE_MS);
    expect(RULES.find((r) => r.id === "import-failed")!.graceMinutes! * 60_000).toBe(IMPORT_GRACE_MS);
    // A failed build counts for a day after it ended.
    expect(JSON.stringify(RULES.find((r) => r.id === "build-failed")!.when)).toContain(`"minutes":${FAILED_BUILD_MS / 60_000}`);
    for (const [kind, variants] of [
      ["Route", routeVariants()],
      ["DeploymentConfig", dcVariants()],
      ["Build", buildVariants()],
      ["ImageStream", imageStreamVariants()],
    ] as const)
      for (const [label, o] of variants) expect(windowFound(kind, o, at("2030-01-01T00:00:00Z")).length, `${kind} ${label}`).toBeLessThanOrEqual(1);
  });

  it.each(routeVariants())("a Route %s", (label, o) => expectSame("Route", o, label));
  it.each(dcVariants())("a DeploymentConfig %s", (label, o) => expectSame("DeploymentConfig", o, label));
  it.each(buildVariants())("a Build %s", (label, o) => expectSame("Build", o, label));
  it.each(imageStreamVariants().filter(([label]) => !label.startsWith("two")))("an ImageStream: %s", (label, o) => expectSame("ImageStream", o, label));

  it("an ImageStream with two failing imports: the first tag by name speaks, and its time starts the grace", () => {
    // The built-in took the earliest failure's time; the manifest has no earliest-of-a-list (README).
    const [, o] = imageStreamVariants().find(([label]) => label.startsWith("two"))!;
    const [found] = windowFound("ImageStream", o, at("2030-01-01T00:00:00Z"));
    const [builtIn] = builtInFound("ImageStream", o, at("2030-01-01T00:00:00Z"));
    expect(found).toEqual({ ...builtIn, since: "2026-10-21T07:00:00Z", start: at("2026-10-21T07:00:00Z") + IMPORT_GRACE_MS });
    const later = copy(o);
    const tags = st(later).tags as { conditions: Cond[] }[];
    tags[0]!.conditions[0]!.lastTransitionTime = "2026-10-21T07:04:00Z";
    expect(windowFound("ImageStream", later, at("2030-01-01T00:00:00Z"))[0]!.since).toBe("2026-10-21T07:04:00Z");
    expect(builtInFound("ImageStream", later, at("2030-01-01T00:00:00Z"))[0]!.since).toBe("2026-10-21T07:02:00Z");
  });

  it("of a BuildConfig's failed builds only the newest counts", () => {
    // The rule's `newestPer` keeps the newest by creation of the builds with the same BuildConfig label, where the
    // built-in kept the highest build number: the same wherever builds are numbered as they are created.
    const key = RULES.find((r) => r.id === "build-failed")!.newestPer!;
    expect(key).toBe("openshift.io/build-config.name");
    expect(RULES.find((r) => r.id === "build-error")!.newestPer).toBe("openshift.io/build-config.name");
    const builds = all("Build");
    const failed = builds.filter((b) => openshiftProblems(BUILD, b, at("2026-10-21T13:00:00Z")).length > 0);
    const newest = (b: KubeObject) => {
      const label = b.metadata.labels?.[key];
      if (label === undefined) return true;
      const same = builds.filter((o) => o.metadata.namespace === b.metadata.namespace && o.metadata.labels?.[key] === label);
      return same.every((o) => o === b || (o.metadata.creationTimestamp ?? "") < (b.metadata.creationTimestamp ?? ""));
    };
    expect(failed.map((b) => b.metadata.name)).toEqual(["ruby-ex-2", "nodejs-ex-1"]);
    expect(failed.filter(newest).map((b) => b.metadata.name)).toEqual(latestFailuresOnly(failed, builds).map((b) => b.metadata.name));
    expect(failed.filter(newest).map((b) => b.metadata.name)).toEqual(["nodejs-ex-1"]);
  });

  it("notify once per object and kind of failure, as the built-in groups did", () => {
    expect([...new Set(RULES.map((r) => r.group))].sort()).toEqual(["build-failed", "import-failed", "not-admitted", "rollout-failed"]);
    for (const rule of RULES) expect((rule as { notify?: boolean }).notify).toBeUndefined();
  });
});

describe("Only problems", () => {
  const kindDef = (kind: string) => manifest.contributes.kinds.find((k) => k.kind === kind)!;
  const holds = (kind: string, o: KubeObject) => {
    const when = (kindDef(kind) as { problemWhen?: unknown }).problemWhen;
    return when === undefined ? false : engine.evaluate(when, o).holds;
  };
  it("shows the objects the built-in filter showed: no grace, a failed Build however long ago", () => {
    for (const [kind, variants] of [
      ["Route", routeVariants()],
      ["DeploymentConfig", dcVariants()],
      ["Build", buildVariants()],
      ["ImageStream", imageStreamVariants()],
    ] as const)
      for (const [label, o] of variants) expect(holds(kind, o), `${kind} ${label}`).toBe(isProblem(o, KIND[kind]));
    expect((kindDef("BuildConfig") as { problemWhen?: unknown }).problemWhen).toBeUndefined();
    expect((kindDef("Project") as { problemWhen?: unknown }).problemWhen).toBeUndefined();
  });
});

// ---------- The columns ----------

type Column = (typeof manifest.contributes.columns)[number];
const columnOf = (id: string) => manifest.contributes.columns.find((c) => c.id === id)! as Column;
const windowColumn = (id: string) => columns.computedColumn(`ext:sextant.openshift:${id}`, columnOf(id));
const T = (key: string, values?: { count?: number }) => `${key}:${values?.count ?? ""}`;
const NOW = at("2026-10-21T12:02:00Z");
const cell = (id: string, obj: KubeObject) => windowColumn(id).searchText(obj, { now: NOW, t: T }) ?? undefined;
interface Drawn {
  title?: string;
  tone?: string;
}
function drawn(id: string, obj: KubeObject): Drawn {
  let node = windowColumn(id).render(obj, { now: NOW }) as { props?: { title?: string; tone?: string; children?: unknown } } | null;
  const title = node?.props?.title;
  if (title !== undefined) node = node!.props!.children as typeof node;
  return { title, tone: node?.props?.tone };
}
const blank = (v: string | undefined) => (v === "" ? undefined : v);
const TONE: Record<string, string> = { success: "success", danger: "danger", warning: "warning", muted: "muted", neutral: "neutral" };

describe("the columns, against the built-in ones", () => {
  it("follow the built-in order and widths, with the CRDs' own columns left out", () => {
    for (const kind of manifest.contributes.kinds) expect(kind.printerColumns).toBe(false);
    const order = (kind: string) => manifest.contributes.columns.filter((c) => c.kind.kind === kind).map((c) => [c.afterColumn, c.id, windowColumn(c.id).width]);
    expect(order("Route")).toEqual([
      ["namespace", "route-status", "110px"],
      ["route-status", "route-host", "minmax(180px, 2fr)"],
      ["route-host", "route-services", "minmax(140px, 1.5fr)"],
      ["route-services", "route-tls", "100px"],
    ]);
    expect(order("DeploymentConfig")).toEqual([
      ["namespace", "dc-status", "120px"],
      ["dc-status", "dc-ready", "80px"],
      ["dc-ready", "dc-latest-version", "80px"],
      ["dc-latest-version", "dc-triggers", "minmax(140px, 1fr)"],
    ]);
    expect(order("BuildConfig")).toEqual([
      ["namespace", "bc-strategy", "110px"],
      ["bc-strategy", "bc-source", "minmax(180px, 2fr)"],
      ["bc-source", "bc-output", "minmax(140px, 1fr)"],
      ["bc-output", "bc-last-version", "80px"],
      ["bc-last-version", "bc-triggers", "minmax(120px, 1fr)"],
    ]);
    expect(order("Build")).toEqual([
      ["namespace", "build-status", "100px"],
      ["build-status", "build-config", "minmax(140px, 1fr)"],
      ["build-config", "build-strategy", "100px"],
      ["build-strategy", "build-duration", "90px"],
      ["build-duration", "build-started", "100px"],
    ]);
    expect(order("ImageStream")).toEqual([
      ["namespace", "is-tags", "minmax(140px, 1.5fr)"],
      ["is-tags", "is-imports", "130px"],
      ["is-imports", "is-repository", "minmax(200px, 2fr)"],
    ]);
    expect(order("Project")).toEqual([
      ["name", "project-display-name", "minmax(160px, 2fr)"],
      ["project-display-name", "project-status", "100px"],
      ["project-status", "project-requester", "minmax(120px, 1fr)"],
    ]);
  });

  it("Route: its admission in its tone with why on hover, sorted and filtered by the state; host and path; TLS", () => {
    for (const [label, o] of routeVariants()) {
      const state = routeState(o);
      expect(cell("route-status", o), label).toBe(en[`routeState.${state}`]);
      expect(drawn("route-status", o), label).toEqual({ title: routeReason(o), tone: TONE[ROUTE_TONE[state]] });
      expect(windowColumn("route-status").value(o), label).toBe(state);
      expect(windowColumn("route-status").filter!.value(o, { now: NOW }), label).toBe(state);
      const host = routeHost(o);
      const hostAndPath = host ? `${host}${(sp(o).path as string | undefined) ?? ""}` : undefined;
      expect(cell("route-host", o), label).toBe(hostAndPath);
      expect(windowColumn("route-host").value(o), label).toBe(hostAndPath);
      expect(cell("route-tls", o), label).toBe(routeTls(o)?.termination);
    }
    // A host only a router generated (a Route with `spec.subdomain`).
    const generated = find("Route", "api");
    delete sp(generated).host;
    expect(cell("route-host", generated)).toBe("api.apps.ocp.example.com");
  });

  it("Route: its Services by name, sorted as the built-in, without the shares (README)", () => {
    const names = (o: KubeObject) => routeBackends(o).map((b) => b.name);
    for (const [label, o] of routeVariants()) {
      expect(windowColumn("route-services").value(o), label).toBe(names(o).join(", ") || undefined);
      // One backend: its name, as the built-in wrote it; several: their names in the UI language's list, where the
      // built-in added each one's share ("frontend (80%), frontend-canary (20%)").
      expect(cell("route-services", o), label).toBe(names(o).join(", ") || undefined);
    }
    const alone = find("Route", "frontend");
    delete sp(alone).to;
    expect(cell("route-services", alone)).toBe("frontend-canary");
  });

  it("DeploymentConfig: its rollout state in its tone with why on hover, ready of desired, version, triggers", () => {
    for (const [label, o] of dcVariants()) {
      const state = dcState(o);
      expect(cell("dc-status", o), label).toBe(en[`dcState.${state}`]);
      expect(drawn("dc-status", o), label).toEqual({ title: blank(dcReason(o)), tone: TONE[DC_TONE[state]] });
      expect(windowColumn("dc-status").value(o), label).toBe(state);
      const r = dcReplicas(o);
      expect(cell("dc-ready", o), label).toBe(`${r.ready}/${r.desired}`);
      expect(windowColumn("dc-ready").value(o), label).toBe(`${r.ready}/${r.desired}`);
      expect(windowColumn("dc-latest-version").value(o), label).toBe(latestVersionOf(o));
      expect(cell("dc-triggers", o), label).toBe(dcTriggers(o).map((t) => t.type).join(", ") || undefined);
    }
    const fresh = find("DeploymentConfig", "frontend");
    delete st(fresh).latestVersion;
    delete st(fresh).readyReplicas;
    expect([cell("dc-latest-version", fresh), windowColumn("dc-latest-version").value(fresh), cell("dc-ready", fresh)]).toEqual(["0", 0, "0/1"]);
  });

  it("BuildConfig: strategy, the source without credentials, output, last build and triggers", () => {
    const bc = find("BuildConfig", "ruby-ex");
    expect(cell("bc-strategy", bc)).toBe(buildStrategy(bc).type);
    expect(cell("bc-source", bc)).toBe(buildSource(bc).uri);
    expect(cell("bc-output", bc)).toBe("ruby-ex:latest");
    expect(windowColumn("bc-last-version").value(bc)).toBe(3);
    expect(cell("bc-triggers", bc)).toBe(bcTriggers(bc).map((t) => t.type).join(", "));
    const binary = copy(bc);
    sp(binary).source = { type: "Binary" };
    expect(cell("bc-source", binary)).toBe("Binary");
  });

  it("Build: its phase in its tone with why on hover, its BuildConfig, strategy, duration and start", () => {
    for (const [label, o] of [...buildVariants(), ["new", (() => {
      const b = find("Build", "ruby-ex-3");
      delete st(b).phase;
      return b;
    })()] as [string, KubeObject]]) {
      const phase = buildPhase(o);
      expect(cell("build-status", o), label).toBe(phase);
      expect(windowColumn("build-status").value(o), label).toBe(phase);
      const tone = phase === "Complete" ? "success" : phase === "Failed" || phase === "Error" ? "danger" : phase === "Cancelled" ? "muted" : "warning";
      expect(drawn("build-status", o), label).toEqual({ title: buildReason(o), tone });
      expect(cell("build-config", o), label).toBe(buildConfigOf(o));
      expect(cell("build-strategy", o), label).toBe(buildStrategy(o).type);
    }
    // From its start to its end, or to now while it runs, as the built-in counted it.
    for (const name of ["ruby-ex-2", "ruby-ex-3", "nodejs-ex-1"]) {
      const b = find("Build", name);
      expect(windowColumn("build-duration").value(b), name).toBe(buildDurationMs(b, NOW));
    }
  });

  it("ImageStream: its tags, the imports that fail in their words and tone, sorted by their count; the repository", () => {
    for (const [label, o] of imageStreamVariants()) {
      const tags = streamTags(o).map((t) => t.name);
      expect(cell("is-tags", o)?.split(", ").sort(), label).toEqual(tags.length ? tags : undefined);
      const failing = failedImports(o).length;
      expect(blank(cell("is-imports", o)), label).toBe(failing > 0 ? (failing === 1 ? "1 import fails" : `${failing} imports fail`) : undefined);
      expect(windowColumn("is-imports").value(o), label).toBe(failing);
      if (failing > 0) expect(drawn("is-imports", o).tone, label).toBe("danger");
      expect(cell("is-repository", o), label).toBe(streamRepositories(o).internal);
    }
    // Every count to 18 in its own case, so each language writes the right plural form; more in the `other` one.
    const many = find("ImageStream", "legacy-db");
    st(many).tags = Array.from({ length: 25 }, (_, i) => ({ tag: `t${i}`, conditions: [{ type: "ImportSuccess", status: "False", reason: "NotFound" }] }));
    expect([cell("is-imports", many), windowColumn("is-imports").value(many)]).toEqual(["25 imports fail", 25]);
  });

  it("Project: display name, phase in its tone, requester", () => {
    const project = find("Project", "shop");
    const info = projectInfo(project);
    expect([cell("project-display-name", project), cell("project-status", project), cell("project-requester", project)]).toEqual([info.displayName, info.phase, info.requester]);
    expect(drawn("project-status", project).tone).toBe("success");
  });
});
