import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type AppSettings, type KindRef, type KubeObject, type ObjectRef, type WatchSpec } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { OPT_IN_CATEGORIES, PROBLEM_CATEGORIES } from "../problems/model";
import { sourceKey, sourcesFor } from "../problems/sources";
import { acquireSource, getSource, resetProblemSources } from "../problems/store";
import { reflectionColumn } from "./columns";
import { resetSharedWatches } from "../resource-map/watches";
import fixtures from "./fixtures/objects.json";
import "./index";
import { canAutoReflect, canReflect, judgeMirror, type NamespaceLabels } from "./judge";
import { parseNamespacedName, reflectionOf, SECRET, CONFIG_MAP } from "./model";
import { resetPatternMatcher, settlePatterns } from "./matcher";
import { namespaceMatches, parseSelector, patternIssues, patternListMatches, patternMatches, selectorMatches } from "./patterns";
import { MISSING_GRACE_MS, STALE_GRACE_MS, toProblems } from "./provider";
import { sourceView } from "./source";
import { acquireReflector, getReflector, MAX_NAMESPACES, NAMESPACES_SPEC, REBUILD_DELAY_MS, resetReflectorStore, SYNC_DELAY_MS, type Lookup } from "./store";

const fx = fixtures as unknown as Record<string, KubeObject> & { namespaces: KubeObject[] };
const secrets = [fx.sourceSecret!, fx.autoMirror!, fx.staleMirror!, fx.selectorMirror!, fx.notAllowedMirror!, fx.conflict!];
const configMaps = [fx.sourceConfigMap!, fx.missingSourceMirror!];

const labels: NamespaceLabels = (ns) => {
  const found = fx.namespaces.find((n) => n.metadata?.name === ns);
  return found ? ((found.metadata?.labels ?? {}) as Record<string, string>) : null;
};

/** A lookup over the fixtures; `unread`: namespaces whose lists are not known. */
function lookupOf(unread: string[] = []): Lookup {
  const all = [...secrets, ...configMaps];
  const of = (kind: string) => all.filter((o) => o.kind === kind);
  return {
    get: (kind, ns, name) => (unread.includes(ns) ? undefined : (of(kind).find((o) => o.metadata?.namespace === ns && o.metadata?.name === name) ?? null)),
    mirrorsOf: (kind, ns, name) => of(kind).filter((o) => !unread.includes(o.metadata?.namespace ?? "") && reflectionOf(o).reflects?.namespace === ns && reflectionOf(o).reflects?.name === name),
    readIn: (_kind, ns) => !unread.includes(ns),
    annotated: (kind) => of(kind).filter((o) => Object.keys(o.metadata?.annotations ?? {}).length > 0),
    namespaceNames: () => fx.namespaces.map((n) => n.metadata?.name ?? "").sort(),
    labels,
  };
}

/** Patterns a backtracking engine takes seconds on (`(a|a)*b`: 7.6 s on 26 characters in JavaScript). */
const PATHOLOGICAL = ["(a|a)*b", "((a)+)+b", ".*.*.*.*.*.*.*.*.*x"];
/** Patterns the fake core refuses as the real one does (lookaround, a backreference, .NET's `\Z`). */
const REFUSED = new Set(["(?=team)team", "(team)\\1", "team\\Z"]);

/**
 * The core's `reflector_match_patterns` for the tests (the real one is `sextant_core::reflector`, tested in Rust):
 * the fixtures' patterns as regular expressions whose first match is the whole name; the pathological ones answered
 * without running them.
 */
function fakeCore(args: Record<string, unknown>): unknown {
  const patterns = args.patterns as string[];
  const names = args.names as string[];
  return patterns.map((p) => {
    if (PATHOLOGICAL.includes(p)) return { matches: names.map(() => "no") };
    if (p.length > 256) return { issue: "notEvaluated", matches: names.map(() => "cannotTell") };
    if (REFUSED.has(p)) return { issue: "invalid", matches: names.map(() => "cannotTell") };
    const re = new RegExp(p);
    return {
      matches: names.map((n) => {
        const m = re.exec(n);
        return m !== null && m.index === 0 && m[0].length === n.length ? "yes" : "no";
      }),
    };
  });
}

const patternCalls = () => wb.backend.calls.filter((c) => c.cmd === "reflector_match_patterns");

/** Runs `fn` so the patterns it needs are asked for, lets the core answer, and runs it again with the answers. */
async function answered<T>(fn: () => T): Promise<T> {
  fn();
  await settlePatterns();
  fn();
  await settlePatterns();
  return fn();
}

describe("namespace patterns, as Reflector's PatternListMatch runs them", () => {
  it("a pattern must match the whole name; an empty list matches every namespace", async () => {
    expect(await answered(() => patternListMatches("namespace-1,namespace-2,namespace-[0-9]*", "namespace-30"))).toBe(true);
    expect(await answered(() => patternListMatches("namespace-[0-9]*", "xnamespace-1"))).toBe(false);
    expect(await answered(() => patternListMatches("namespace-[0-9]*", "namespace-1x"))).toBe(false);
    expect(patternListMatches("", "anything")).toBe(true);
    expect(await answered(() => patternListMatches(" team-a , team-b ", "team-b"))).toBe(true);
  });

  it("a list that is not empty but holds no pattern matches no namespace, as in Reflector", () => {
    expect(patternListMatches(" , ", "anything")).toBe(false);
    expect(patternListMatches(",", "anything")).toBe(false);
    expect(patternListMatches(" ", "anything")).toBe(false);
    expect(namespaceMatches(" ", "", "anything", {})).toBe(false);
    expect(namespaceMatches("", "", "anything", {})).toBe(true);
    const source = copy(fx.sourceSecret!);
    source.metadata!.annotations = {
      "reflector.v1.k8s.emberstack.com/reflection-allowed": "true",
      "reflector.v1.k8s.emberstack.com/reflection-allowed-namespaces": " ",
    };
    expect(canReflect(reflectionOf(source), "team-x", labels)).toBe(false);
  });

  it("the first match found must cover the name (Regex.Match), as in .NET", async () => {
    expect(await answered(() => patternMatches("a|ab", "ab"))).toBe(false);
    expect(await answered(() => patternMatches("ab|a", "ab"))).toBe(true);
  });

  it("a list is split on every comma, even inside a quantifier", async () => {
    expect(await answered(() => patternListMatches("ns-[a-z]{1,3}", "ns-abc"))).toBe(false);
  });

  it("never runs a pattern in the window: the core answers, the pathological ones at once, in one batched call", async () => {
    const name = "a".repeat(26);
    const started = performance.now();
    for (const p of PATHOLOGICAL) expect(patternMatches(p, name)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(100);
    await settlePatterns();
    for (const p of PATHOLOGICAL) expect(patternMatches(p, name)).toBe(false);
    expect(patternCalls().map((c) => c.args)).toEqual([{ patterns: PATHOLOGICAL, names: [name] }]);
  });

  it("a pattern the core does not run is 'cannot tell', never a match or a mismatch, with its reason", async () => {
    expect(await answered(() => patternMatches("(?=team)team", "team"))).toBeUndefined();
    expect(await answered(() => patternMatches("a".repeat(300), "a"))).toBeUndefined();
    expect(await answered(() => patternListMatches("(team)\\1,other", "team"))).toBeUndefined();
    expect(await answered(() => patternListMatches("team\\Z,team", "team"))).toBe(true);
    expect(await answered(() => patternIssues(`(?=team)team,ok,${"a".repeat(300)}`))).toEqual([
      { pattern: "(?=team)team", issue: "invalid" },
      { pattern: "a".repeat(300), issue: "notEvaluated" },
    ]);
  });

  it("'cannot tell' while the answer is pending or when the call fails, and a failed call is not repeated at once", async () => {
    wb.backend.on("reflector_match_patterns", () => {
      throw { code: "other", message: "down" };
    });
    expect(patternMatches("team", "team")).toBeUndefined();
    await settlePatterns();
    expect(patternMatches("team", "team")).toBeUndefined();
    await settlePatterns();
    expect(patternCalls()).toHaveLength(1);
  });
});

describe("namespace selectors, as Reflector's TryParseLabelSelector parses them", () => {
  it("equality, inequality, set-based and existence requirements, ANDed", () => {
    const l = { env: "production", team: "a" };
    expect(selectorMatches("env=production", l)).toBe(true);
    expect(selectorMatches("env==production,team in (a, b)", l)).toBe(true);
    expect(selectorMatches("env!=production", l)).toBe(false);
    expect(selectorMatches("team notin (b)", l)).toBe(true);
    expect(selectorMatches("!legacy,team", l)).toBe(true);
    expect(selectorMatches("legacy", l)).toBe(false);
  });

  it("an unparsable selector matches nothing (Reflector fails closed)", () => {
    expect(parseSelector("=x")).toBeUndefined();
    expect(parseSelector("team in ()")).toBeUndefined();
    expect(selectorMatches("=x", {})).toBe(false);
  });

  it("the list OR the selector; a selector needs the namespace's labels", async () => {
    expect(await answered(() => namespaceMatches("ns-a", "env=production", "team-x", { env: "production" }))).toBe(true);
    expect(await answered(() => namespaceMatches("ns-a", "env=production", "team-x", {}))).toBe(false);
    expect(await answered(() => namespaceMatches("ns-a", "env=production", "team-x", undefined))).toBeUndefined();
    expect(await answered(() => namespaceMatches("ns-a", "env=production", "team-x", null))).toBe(false);
  });
});

describe("annotations, read as Reflector reads them", () => {
  it("flags in any case, reflects as namespace/name or name, the quoted reflected-at", () => {
    const r = reflectionOf(fx.autoMirror!);
    expect(r).toMatchObject({ reflects: { namespace: "default", name: "source-secret" }, autoReflects: true, reflectedVersion: "1001" });
    expect(r.reflectedAt).toBe("2026-10-20T08:00:00.0000000+00:00");
    expect(parseNamespacedName("only-name")).toEqual({ namespace: "", name: "only-name" });
    expect(parseNamespacedName("a/b/c")).toBeUndefined();
    expect(parseNamespacedName(" a / b ")).toEqual({ namespace: "a", name: "b" });
  });

  it("automatic mirrors need reflection allowed, the allowed namespaces and the automatic ones", async () => {
    const source = reflectionOf(fx.sourceSecret!);
    expect(await answered(() => canReflect(source, "other", labels))).toBe(false);
    expect(await answered(() => canReflect(source, "team-x", labels))).toBe(true);
    expect(await answered(() => canAutoReflect(source, "team-x", labels))).toBe(false);
    expect(await answered(() => canAutoReflect(source, "namespace-30", labels))).toBe(true);
    expect(canAutoReflect({ ...source, allowed: false }, "namespace-1", labels)).toBe(false);
  });
});

describe("a mirror's state", () => {
  const judge = (mirror: KubeObject, unread: string[] = []) =>
    answered(() => {
      const lookup = lookupOf(unread);
      const ref = reflectionOf(mirror).reflects!;
      return judgeMirror(mirror, lookup.get(mirror.kind as "Secret", ref.namespace, ref.name), labels)!;
    });

  it("in sync when reflected-version is the source's resourceVersion; stale when not", async () => {
    expect(await judge(fx.autoMirror!)).toMatchObject({ state: "inSync", permitted: true, versionMatches: true });
    expect(await judge(fx.staleMirror!)).toMatchObject({ state: "stale", versionMatches: false });
  });

  it("allowed through the namespace selector; not allowed where neither the list nor the selector matches", async () => {
    expect((await judge(fx.selectorMirror!)).state).toBe("inSync");
    expect(await judge(fx.notAllowedMirror!)).toMatchObject({ state: "notAllowed", permitted: false, versionMatches: true });
  });

  it("source missing where its namespace is read and it is not there; 'cannot tell' where not read", async () => {
    expect((await judge(fx.missingSourceMirror!)).state).toBe("sourceMissing");
    expect((await judge(fx.autoMirror!, ["default"])).state).toBe("unknown");
    const nameOnly = copy(fx.selectorMirror!);
    nameOnly.metadata!.annotations = { "reflector.v1.k8s.emberstack.com/reflects": "source-secret" };
    expect(judgeMirror(nameOnly, undefined, labels)!.state).toBe("sourceMissing");
  });

  it("never reads a value: a changed value with the same versions is still in sync", async () => {
    const mirror = copy(fx.autoMirror!);
    mirror.data = { password: "c29tZXRoaW5nIGVsc2U=" };
    expect((await judge(mirror)).state).toBe("inSync");
  });
});

describe("a source's view", () => {
  it("lists its mirrors with their states, automatic targets without a mirror, and the name taken by another object", async () => {
    const view = await answered(() => sourceView("Secret", fx.sourceSecret!, lookupOf()));
    expect(view.mirrors.map((m) => [m.obj.metadata?.namespace, m.judgement.state])).toEqual([
      ["namespace-1", "inSync"],
      ["namespace-2", "stale"],
      ["other", "notAllowed"],
      ["team-x", "inSync"],
    ]);
    expect(view.targets?.auto.yes).toEqual(["namespace-1", "namespace-2", "namespace-30"]);
    expect(view.targets?.allowed.yes).toEqual(["namespace-1", "namespace-2", "namespace-30", "team-x"]);
    expect(view.expected).toEqual([{ namespace: "namespace-30", state: "conflict" }]);
    expect(view.notChecked).toEqual([]);
  });

  it("says which namespaces it may reach were not read", async () => {
    expect((await answered(() => sourceView("Secret", fx.sourceSecret!, lookupOf(["team-x"])))).notChecked).toEqual(["team-x"]);
  });
});

describe("problems of the opt-in category", () => {
  it("is a category of the problems screen, off until turned on", () => {
    expect(PROBLEM_CATEGORIES).toContain("reflector");
    expect(OPT_IN_CATEGORIES).toContain("reflector");
  });

  it("stale mirrors after a grace, mirrors whose source is missing, and out-of-date mirrors no longer allowed", async () => {
    const firstSeen = new Map<string, number>();
    const problems = await answered(() => toProblems(lookupOf(), firstSeen, 1000));
    expect(problems.map((p) => [p.object.kind.kind, p.object.namespace, p.object.name, p.reason, p.activeAt])).toEqual([
      ["Secret", "namespace-2", "source-secret", "Stale", 1000 + STALE_GRACE_MS],
      ["ConfigMap", "namespace-1", "mirror-config-map", "SourceMissing", 1000 + MISSING_GRACE_MS],
    ]);
    expect(problems[0]!.messageKey).toBe("messages.reflectorStale");
    expect(problems[0]!.messageParams).toEqual({ source: "default/source-secret" });
    // The grace runs from the first sighting.
    expect(toProblems(lookupOf(), firstSeen, 5000)[0]!.activeAt).toBe(1000 + STALE_GRACE_MS);
    // The source's namespace not read: nothing is claimed.
    expect(toProblems(lookupOf(["default"]), new Map(), 0)).toEqual([]);
  });
});

let wb: WatchBackend;
let stored: AppSettings;
const served = (k: KindRef) => ({ kindRef: k, plural: `${k.kind.toLowerCase()}s`, namespaced: k.kind !== "Namespace", verbs: ["list", "watch"], printerColumns: [] });

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetReflectorStore();
  resetPatternMatcher();
  resetSharedWatches();
  resetSettingsCache();
  stored = defaultAppSettings();
  wb = watchBackend();
  wb.backend.on("reflector_match_patterns", fakeCore);
  wb.backend.on("cluster_kinds", () => [SECRET, CONFIG_MAP].map(served));
  wb.backend.on("settings_get", () => structuredClone(stored));
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
  resetProblemSources();
  resetReflectorStore();
  resetSharedWatches();
  resetSettingsCache();
});

function emitAll(kind: string, items: KubeObject[], match: (s: WatchSpec) => boolean = () => true): void {
  for (const [id, spec] of wb.specs) {
    if (spec.kind.kind !== kind || !match(spec) || wb.backend.listenerCount(`watch:${id}`) === 0) continue;
    const listed = items.filter((o) => spec.namespaces === null || spec.namespaces.includes(o.metadata?.namespace ?? ""));
    act(() => wb.backend.emit(`watch:${id}`, { type: "snapshot", items: listed }));
  }
}

const settle = () => act(() => new Promise<void>((r) => setTimeout(r, SYNC_DELAY_MS + REBUILD_DELAY_MS + 150)));
const metadataLists = () => [...wb.specs.values()].filter((s) => s.metadataOnly === true);

/** Answers the Namespaces and every metadata-only list of Secrets and ConfigMaps with the fixtures. */
async function feed(): Promise<void> {
  await settle();
  emitAll("Namespace", fx.namespaces);
  emitAll("Secret", secrets, (s) => s.metadataOnly === true);
  emitAll("ConfigMap", configMaps, (s) => s.metadataOnly === true);
  await settle();
}

describe("the shared store", () => {
  it("lists only the namespaces asked for, metadata only, with the namespace filter's own Namespace list", async () => {
    const release = acquireReflector("c1", { kind: "Secret", namespaces: ["default", "team-x"] });
    const again = acquireReflector("c1", { kind: "Secret", namespaces: ["default"] });
    await settle();
    expect(metadataLists().map((s) => [s.kind.kind, s.namespaces])).toEqual([["Secret", ["default", "team-x"]]]);
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "Namespace")).toEqual([NAMESPACES_SPEC]);
    // No cluster-wide Secret list without the opt-in problems.
    expect([...wb.specs.values()].some((s) => s.kind.kind === "Secret" && s.namespaces === null)).toBe(false);
    await feed();
    expect(getReflector("c1").lookup.get("Secret", "default", "source-secret")?.metadata?.name).toBe("source-secret");
    expect(getReflector("c1").lookup.get("Secret", "default", "nothing")).toBeNull();
    expect(getReflector("c1").lookup.get("Secret", "other", "mirror-secret")).toBeUndefined();
    again();
    release();
  });

  it("keeps at most MAX_NAMESPACES per kind, first asked first kept", async () => {
    const many = Array.from({ length: MAX_NAMESPACES + 5 }, (_, i) => `ns-${String(i).padStart(2, "0")}`);
    const release = acquireReflector("c1", { kind: "ConfigMap", namespaces: many });
    await settle();
    expect(metadataLists()[0]!.namespaces).toHaveLength(MAX_NAMESPACES);
    expect(getReflector("c1").skipped.ConfigMap).toEqual(many.slice(MAX_NAMESPACES));
    release();
  });

  it("the problems provider alone lists every namespace (capped)", async () => {
    const release = acquireReflector("c1", { all: true });
    await settle();
    expect(metadataLists().map((s) => [s.kind.kind, s.namespaces])).toEqual([
      ["Secret", null],
      ["ConfigMap", null],
    ]);
    await feed();
    const problems = await answered(() => toProblems(getReflector("c1").lookup, new Map(), 0));
    expect(problems.map((p) => p.reason)).toEqual(["Stale", "SourceMissing"]);
    release();
  });

  it("an out-of-date mirror the source no longer allows is a problem", async () => {
    const stale = copy(fx.notAllowedMirror!);
    stale.metadata!.annotations = { ...(stale.metadata!.annotations as Record<string, string>), "reflector.v1.k8s.emberstack.com/reflected-version": "1" };
    const base = lookupOf();
    const lookup: Lookup = { ...base, annotated: (kind) => (kind === "Secret" ? [stale] : []) };
    expect((await answered(() => toProblems(lookup, new Map(), 0))).map((p) => [p.reason, p.messageKey])).toEqual([["NotAllowed", "messages.reflectorNotAllowed"]]);
  });
});

function refTo(obj: KubeObject): ObjectRef {
  return { kind: obj.kind === "Secret" ? SECRET : CONFIG_MAP, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<HTMLElement> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  const { container } = render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitAll(ref.kind.kind, [obj], (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  await waitFor(() => expect(document.querySelector("[data-section='reflector']")).not.toBeNull());
  return container;
}

const view = () => within(document.querySelector<HTMLElement>("[data-section='reflector']")!);

describe("the Reflection details section and column", () => {
  it("a stale mirror: its source as a link, the versions, the reason, and only its source's namespace listed", async () => {
    const container = await openDetails(fx.staleMirror!);
    await feed();
    const v = view();
    await waitFor(() => expect(v.getByText("Stale")).toBeInTheDocument());
    expect(v.getByRole("button", { name: "Open Secret source-secret" })).toHaveTextContent("default/source-secret");
    expect(v.getByText(/this mirror holds version 900, the source is at 1001/)).toBeInTheDocument();
    expect(v.getByText(/Values are never read or compared/)).toBeInTheDocument();
    expect(metadataLists().map((s) => [s.kind.kind, s.namespaces])).toEqual([["Secret", ["default"]]]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("a mirror whose source is gone", async () => {
    await openDetails(fx.missingSourceMirror!);
    await feed();
    await waitFor(() => expect(view().getByText("Source missing")).toBeInTheDocument());
    expect(view().getByText(/The source default\/gone-config-map does not exist/)).toBeInTheDocument();
  });

  it("a source: allowed and automatic namespaces, its mirrors with their states, the taken name", async () => {
    const container = await openDetails(fx.sourceSecret!);
    // First its own namespace (and the Namespaces), then every namespace it may reach.
    await feed();
    await feed();
    const v = view();
    await waitFor(() => expect(v.getAllByRole("row").length).toBeGreaterThan(4));
    const rows = v.getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("namespace-1/source-secretAutomaticIn sync");
    expect(rows).toContain("namespace-2/source-secretAutomaticStale");
    expect(rows).toContain("team-x/mirror-secretManualIn sync");
    // A namespace the source does not allow is not read for it (the opt-in problems list every namespace).
    expect(rows.some((r) => r?.startsWith("other/"))).toBe(false);
    expect(rows).toContain("namespace-30/source-secretAutomaticName taken");
    expect(v.getByText(/Reflector does not create the automatic mirror/)).toBeInTheDocument();
    // Its own namespace and the namespaces it may reach, never every namespace.
    const listed = metadataLists().find((s) => s.namespaces?.includes("team-x"));
    expect(listed?.namespaces).toEqual(["default", "namespace-1", "namespace-2", "namespace-30", "team-x"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  it("draws nothing for a Secret without Reflector's annotations, and the tables get the column", async () => {
    const plain = copy(fx.conflict!);
    const ref = refTo(plain);
    render(<DetailsPanel clusterId="c1" objectRef={ref} />);
    await watchOf(wb, "Secret", (s) => s.fieldSelector === `metadata.name=${ref.name}`);
    emitAll("Secret", [plain], (s) => s.fieldSelector === `metadata.name=${ref.name}`);
    await settle();
    expect(document.querySelector("[data-section='reflector']")?.textContent ?? "").toBe("");
    expect(metadataLists()).toEqual([]);
    expect(getResourceDef(SECRET)?.columns.some((c) => c.id === "reflection")).toBe(true);
    expect(getResourceDef(CONFIG_MAP)?.columns.some((c) => c.id === "reflection")).toBe(true);
  });
});

describe("wiring", () => {
  it("the problems store's source of the category holds the cluster-wide lists and hands in the problems", async () => {
    const [def] = sourcesFor(["reflector"], []);
    expect(def).toMatchObject({ category: "reflector", external: true, discovered: false });
    expect(sourceKey("c1", def!)).toMatch(/\|reflector$/);
    const release = acquireSource("c1", def!);
    await settle();
    expect(metadataLists().map((s) => s.namespaces)).toEqual([null, null]);
    await feed();
    await waitFor(() => expect(getSource(sourceKey("c1", def!))?.problems.map((p) => p.reason)).toEqual(["Stale", "SourceMissing"]));
    release();
  });

  it("the column: a mirror's state from its source's namespace only, a source's role", async () => {
    const ctx = { clusterId: "c1", kind: SECRET, now: 0 };
    const { container } = render(
      <div>
        {reflectionColumn.render!(fx.staleMirror!, ctx)}
        {reflectionColumn.render!(fx.sourceSecret!, ctx)}
        {reflectionColumn.render!(fx.conflict!, ctx)}
      </div>,
    );
    await feed();
    await waitFor(() => expect(container.textContent).toBe("StaleSource, mirrored automatically"));
    expect(metadataLists().map((s) => [s.kind.kind, s.namespaces])).toEqual([["Secret", ["default"]]]);
    expect(reflectionColumn.value(fx.staleMirror!)).toBe("mirror");
  });
});
