import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultAppSettings, type KindRef, type KubeObject, type ObjectRef, type ResourceKind } from "../../api";
import { resetSettingsCache } from "../../api/settings";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { getResourceDef, resetClusterKinds } from "../../resources";
import { axeViolations } from "../../test/axe";
import "../details";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import { resolve } from "../problems/model";
import { sourceKey, sourcesFor } from "../problems/sources";
import { acquireSource, getSource, resetProblemSources } from "../problems/store";
import { toldThroughInvalid } from "./across";
import { explain } from "./explain";
import delegationJson from "./fixtures/delegation.json";
import extensionJson from "./fixtures/extension.json";
import proxiesJson from "./fixtures/proxies.json";
import { resetContourTaps } from "./hooks";
import "./index";
import {
  delegationFor,
  delegationTree,
  EXTENSION_SERVICE,
  includesOf,
  indexRows,
  joinPrefixes,
  proxyRow,
  proxyState,
  rootsReaching,
  routesOf,
  servedInPart,
  shares,
  TLS_DELEGATION,
  tlsOf,
  HTTP_PROXY,
} from "./model";
import { contourProblems } from "./problemRules";

const proxies = proxiesJson as KubeObject[];
const [root, blog, orphan, duplicate, fresh] = proxies as [KubeObject, KubeObject, KubeObject, KubeObject, KubeObject];
const delegation = delegationJson as KubeObject;
const extension = extensionJson as KubeObject;

describe("the model", () => {
  it("reads Contour's states, including the CRD's default NotReconciled", () => {
    expect(proxies.map(proxyState)).toEqual(["invalid", "valid", "orphaned", "invalid", "pending"]);
    // An include that is not found leaves the rest served; a duplicate host drops the virtual host.
    expect(servedInPart(root)).toBe(true);
    expect(servedInPart(duplicate)).toBe(false);
    expect(explain(duplicate)).toMatchObject({ key: "duplicateVhost", params: { fqdn: "root.bar.com" } });
    expect(explain(fresh)).toEqual({ key: "pendingClass", params: { class: "contour-internal" } });
    expect(explain(orphan)).toEqual({ key: "orphaned" });
  });

  it("splits requests by weight as Contour does, a mirror's weight being its percent", () => {
    const [weighted, plain] = routesOf(blog);
    expect(shares(weighted!.services)).toEqual([90, 10, 20]);
    expect(shares(plain!.services)).toEqual([50, 50]);
    // Some weights set: a service without one gets nothing; a mirror without a weight copies everything.
    expect(shares([{ name: "a", weight: 3, mirror: false }, { name: "b", mirror: false }, { name: "m", mirror: true }])).toEqual([100, 0, 100]);
    expect(plain!.conditions).toEqual(["prefix=/admin", "header x-env exact=staging"]);
  });

  it("reads a delegated Secret and the delegation that allows it", () => {
    const tls = tlsOf(root)!;
    expect(tls.secret).toEqual({ namespace: "www-admin", name: "example-com-wildcard", delegated: true });
    expect(delegationFor([delegation], tls.secret!, "roots")).toBe(delegation);
    expect(delegationFor([delegation], tls.secret!, "other")).toBeUndefined();
    expect(delegationFor([delegation], { namespace: "www-admin", name: "shared-ca", delegated: true }, "any")).toBe(delegation);
  });

  it("builds the delegation tree, prefixes concatenated, a missing include marked", () => {
    expect(includesOf(root).map((i) => `${i.namespace}/${i.name} ${i.prefix}`)).toEqual(["marketing/blogsite /blog", "marketing/missing-site /missing"]);
    // As Contour's mergePathMatchConditions: concatenated, slashes collapsed, a trailing slash kept.
    expect(joinPrefixes(["/api", "/v1/"])).toBe("/api/v1/");
    expect(joinPrefixes(["/blog", "/"])).toBe("/blog/");
    expect(joinPrefixes(["/", "/blog"])).toBe("/blog");
    expect(joinPrefixes(["/a/", "/b"])).toBe("/a/b");
    expect(joinPrefixes(["///", "/"])).toBe("/");
    expect(joinPrefixes([undefined, "/"])).toBe("/");
    expect(joinPrefixes([])).toBe("/");
    const index = indexRows(proxies.map(proxyRow));
    expect(rootsReaching(index, "marketing/blogsite")).toEqual(["roots/root-blog"]);
    expect(rootsReaching(index, "marketing/old-blog")).toEqual([]);
    const { node } = delegationTree(index, "roots/root-blog");
    expect(node.children.map((c) => [c.key, c.prefix, Boolean(c.row)])).toEqual([
      ["marketing/blogsite", "/blog", true],
      ["marketing/missing-site", "/missing", false],
    ]);
    // Focused on an included proxy: only the branches that lead to it.
    expect(delegationTree(index, "roots/root-blog", "marketing/blogsite").node.children.map((c) => c.key)).toEqual(["marketing/blogsite"]);
  });

  it("marks an include cycle", () => {
    const a = proxyRow(blog);
    const index = indexRows([{ ...a, includes: [{ key: "marketing/blogsite", conditions: [], tcp: false }] }]);
    const { node } = delegationTree(index, "marketing/blogsite");
    expect(node.children[0]).toMatchObject({ cycle: true, children: [] });
  });
});

describe("problems", () => {
  it("invalid and orphaned proxies are problems with Contour's reason; a proxy not processed yet is not", () => {
    expect(contourProblems(HTTP_PROXY, root)).toMatchObject([{ reason: "IncludeNotFound", notify: true, graceMs: 120_000 }]);
    expect(contourProblems(HTTP_PROXY, orphan)).toMatchObject([{ reason: "Orphaned", group: "orphaned" }]);
    expect(contourProblems(HTTP_PROXY, blog)).toEqual([]);
    expect(contourProblems(HTTP_PROXY, fresh)).toEqual([]);
    expect(contourProblems(EXTENSION_SERVICE, extension)).toEqual([]);
    const [resolved] = resolve(HTTP_PROXY, duplicate, Date.parse("2026-10-20T12:00:00Z"));
    expect(resolved).toMatchObject({ category: "contour", reason: "DuplicateVhost" });
  });

  it("an orphan whose include path goes up to an invalid proxy is told through that proxy", () => {
    const row = (name: string, state: "valid" | "invalid" | "orphaned", includes: string[] = [], root = false) =>
      [name, { namespace: "ns", name, root, state, includes: includes.map((i) => ({ key: `ns/${i}`, conditions: [], tcp: false })) }] as const;
    const rows = new Map([row("root", "invalid", ["a"], true), row("a", "orphaned", ["b"]), row("b", "orphaned"), row("loose", "orphaned")]);
    const problem = (name: string, reason: string) => ({ reason, object: { kind: HTTP_PROXY, namespace: "ns", name } }) as Parameters<typeof toldThroughInvalid>[0][number];
    const kept = toldThroughInvalid([problem("root", "TLSError"), problem("a", "Orphaned"), problem("b", "Orphaned"), problem("loose", "Orphaned")], rows);
    expect(kept.map((p) => p.object.name)).toEqual(["root", "loose"]);
  });

  it("the HTTPProxy table offers the problem filter", () => {
    expect(getResourceDef(HTTP_PROXY).problem?.(orphan)).toBe(true);
    expect(getResourceDef(HTTP_PROXY).problem?.(blog)).toBe(false);
  });
});

// ---------- In the app ----------

const served = (kind: KindRef): ResourceKind => ({ kindRef: kind, plural: `${kind.kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const BUILT_IN: KindRef[] = [{ group: "", version: "v1", kind: "Pod" }];

let wb: WatchBackend;
let discovery: KindRef[];

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetProblemSources();
  resetSettingsCache();
  resetNamespaceRestore();
  discovery = [...BUILT_IN, HTTP_PROXY, TLS_DELEGATION, EXTENSION_SERVICE];
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => discovery.map(served));
  wb.backend.on("settings_get", () => defaultAppSettings());
});

afterEach(() => {
  resetContourTaps();
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

const everywhere = (kind: string) => (spec: { kind: KindRef; namespaces: string[] | null; fieldSelector: string | null }) =>
  spec.kind.group === "projectcontour.io" && spec.kind.kind === kind && spec.namespaces === null && spec.fieldSelector === null;

describe("the Contour section", () => {
  it("lists the kinds the cluster serves and counts the proxies that need attention", async () => {
    discovery = [...BUILT_IN, HTTP_PROXY, TLS_DELEGATION];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(sections()).toContain("Contour"));
    fireEvent.click(screen.getByRole("button", { name: /Contour/ }));
    const section = within(screen.getByRole("button", { name: /Contour/ }).closest("li")!);
    for (const label of ["HTTP Proxies", "TLS Certificate Delegations"]) expect(section.getByRole("button", { name: label })).toBeInTheDocument();
    expect(section.queryByRole("button", { name: "Extension Services" })).toBeNull();
    emitSnapshot(wb, await watchOf(wb, "HTTPProxy", everywhere("HTTPProxy")), [blog, orphan, duplicate]);
    await waitFor(() => expect(screen.getByTitle("2 HTTPProxies need attention")).toHaveTextContent("2"));
  });

  it("a root with 20 includes and a bad TLS Secret is one problem, not 21", async () => {
    const [def] = sourcesFor(["contour"], [served(HTTP_PROXY)]);
    const release = acquireSource("c1", def!);
    const since = "2026-01-01T00:00:00Z";
    const valid = (state: string, error: { type: string; reason: string; message: string }) => ({
      currentStatus: state,
      conditions: [{ type: "Valid", status: "False", reason: "ErrorPresent", lastTransitionTime: since, errors: [error] }],
    });
    const proxy = (name: string, spec: Record<string, unknown>, status: Record<string, unknown>): KubeObject => ({
      apiVersion: "projectcontour.io/v1",
      kind: "HTTPProxy",
      metadata: { name, namespace: "web", uid: `uid-${name}`, creationTimestamp: since },
      spec,
      status,
    });
    const sites = Array.from({ length: 20 }, (_, i) => `site-${i}`);
    const bad = proxy(
      "root",
      { virtualhost: { fqdn: "example.com", tls: { secretName: "gone" } }, includes: sites.map((name) => ({ name, conditions: [{ prefix: `/${name}` }] })) },
      valid("invalid", { type: "TLSError", reason: "SecretNotValid", message: 'Secret "web/gone" not found' }),
    );
    const orphaned = (name: string) => proxy(name, { routes: [{ services: [{ name: "web", port: 80 }] }] }, valid("orphaned", { type: "Orphaned", reason: "Orphaned", message: "not part of a delegation chain from a root" }));
    const id = await watchOf(wb, "HTTPProxy", everywhere("HTTPProxy"));
    emitSnapshot(wb, id, [bad, ...sites.map(orphaned)]);
    const key = sourceKey("c1", def!);
    await waitFor(() => expect(getSource(key)?.status).toBe("ready"));
    expect(getSource(key)!.problems.map((p) => [p.object.name, p.reason])).toEqual([["root", "SecretNotValid"]]);
    // A proxy nobody includes is still an orphan of its own.
    emitSnapshot(wb, id, [bad, ...sites.map(orphaned), orphaned("loose")]);
    await waitFor(() => expect(getSource(key)!.problems.map((p) => p.object.name).sort()).toEqual(["loose", "root"]));
    release();
  });

  it("is not there without Contour", async () => {
    discovery = [...BUILT_IN];
    render(<Sidebar clusterId="c1" />);
    await waitFor(() => expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(true));
    await waitFor(() => expect(sections()).toContain("Workloads"));
    expect(sections()).not.toContain("Contour");
  });
});

function refTo(obj: KubeObject): ObjectRef {
  const [group, version] = (obj.apiVersion ?? "").split("/");
  return { kind: { group: group!, version: version!, kind: obj.kind ?? "" }, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject): Promise<void> {
  const ref = refTo(obj);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, ref.kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const section = (id: string) => within(document.querySelector<HTMLElement>(`[data-section='${id}']`)!);

describe("details", () => {
  it("of a root: Contour's error, the delegated Secret with its delegation, routes, includes and the tree", async () => {
    await openDetails(root);
    const ct = section("contour");
    await waitFor(() => expect(ct.getByText(/Contour serves the proxy in part \(IncludeNotFound\)/)).toBeInTheDocument());
    expect(ct.getByText("include marketing/missing-site not found")).toBeInTheDocument();
    expect(ct.getByRole("button", { name: "Open Secret example-com-wildcard" })).toBeInTheDocument();
    expect(ct.getByRole("button", { name: "Open ExtensionService authserver" })).toBeInTheDocument();
    emitSnapshot(wb, await watchOf(wb, "TLSCertificateDelegation", (s) => s.namespaces?.[0] === "www-admin"), [delegation]);
    await waitFor(() => expect(ct.getByRole("button", { name: "Open TLSCertificateDelegation example-com-wildcard" })).toBeInTheDocument());
    emitSnapshot(wb, await watchOf(wb, "HTTPProxy", everywhere("HTTPProxy")), proxies);
    await waitFor(() => expect(ct.getAllByText("Does not exist: Contour answers 502").length).toBeGreaterThan(0));
    expect(ct.getAllByRole("button", { name: "Open HTTPProxy blogsite" }).length).toBe(2);
    expect(ct.getByText("/blog")).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of an included proxy: shares and mirror per service, the roots that reach it", async () => {
    await openDetails(blog);
    const ct = section("contour");
    await waitFor(() => expect(ct.getByText(/a root proxy includes it/)).toBeInTheDocument());
    expect(ct.getByText("90% of requests")).toBeInTheDocument();
    expect(ct.getByText("Mirror: a copy of 20% of requests")).toBeInTheDocument();
    expect(ct.getAllByText("50% of requests")).toHaveLength(2);
    emitSnapshot(wb, await watchOf(wb, "HTTPProxy", everywhere("HTTPProxy")), proxies);
    await waitFor(() => expect(ct.getByRole("button", { name: "Open HTTPProxy root-blog" })).toBeInTheDocument());
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of an orphan, a delegation and an extension service", async () => {
    await openDetails(orphan);
    await waitFor(() => expect(section("contour").getByText(/No root HTTPProxy includes this proxy, so Contour ignores it/)).toBeInTheDocument());
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of a TLSCertificateDelegation and an ExtensionService", async () => {
    await openDetails(copy(delegation));
    await waitFor(() => expect(section("contour").getByText("All namespaces")).toBeInTheDocument());
    expect(section("contour").getByRole("button", { name: "Open Secret example-com-wildcard" })).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it("of an ExtensionService that Contour does not accept", async () => {
    await openDetails(copy(extension));
    await waitFor(() => expect(section("contour").getByText(/Contour does not accept this extension service \(ServiceUnresolvedReference\)/)).toBeInTheDocument());
    expect(section("contour").getByRole("button", { name: "Open Service htpasswd" })).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
