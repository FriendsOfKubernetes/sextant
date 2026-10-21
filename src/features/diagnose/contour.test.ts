import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { HTTP_PROXY, TLS_DELEGATION } from "../contour/model";
import proxiesJson from "../contour/fixtures/proxies.json";
import delegationJson from "../contour/fixtures/delegation.json";
import "../contour/register";
import { contourDiagnoser, diagnoseProxy, MAX_DEPTH } from "./contour";
import { diagnose, diagnosedKind } from "./engine";
import { chainStatus, firstBroken, type Chain, type ClusterView } from "./model";
import { certificate, pod, service, slice, view, type ViewInput } from "./testData";

const [root, blog, orphan, duplicate, fresh] = structuredClone(proxiesJson) as KubeObject[] as [KubeObject, KubeObject, KubeObject, KubeObject, KubeObject];
const delegation = delegationJson as KubeObject;

const steps = (chain: Chain) => [...chain.findings.map((f) => `${f.id}:${f.status}`), ...(chain.stopped ? ["…"] : [])];
const keys = (chain: Chain) => chain.findings.map((f) => f.text.key);

/** Moves a testData object into `namespace`. */
const into = (namespace: string, obj: KubeObject): KubeObject => ({ ...obj, metadata: { ...obj.metadata, namespace } });

function contourView(input: ViewInput, objects: { proxies?: KubeObject[]; delegations?: KubeObject[]; unreadable?: string[] } = {}): ClusterView {
  const base = view(input);
  return {
    ...base,
    objects: (kind, ns) => {
      if (objects.unreadable?.includes(ns)) return undefined;
      const list = kind.kind === HTTP_PROXY.kind ? objects.proxies : kind.kind === TLS_DELEGATION.kind ? objects.delegations : undefined;
      return (list ?? []).filter((o) => o.metadata?.namespace === ns);
    },
  };
}

const WEB = { app: "blog" };
const healthyBlog = (namespace: string): ViewInput => ({
  services: [
    into(namespace, service("blog", { selector: WEB })),
    into(namespace, service("blog-canary", { selector: WEB })),
    into(namespace, service("blog-shadow", { selector: WEB })),
    into(namespace, service("blog-admin", { selector: WEB, ports: [{ name: "http", port: 8080, targetPort: 8080, protocol: "TCP" }] })),
    into(namespace, service("blog-admin-old", { selector: WEB, ports: [{ name: "http", port: 8080, targetPort: 8080, protocol: "TCP" }] })),
    into("roots", service("rootapp", { selector: WEB })),
  ],
  pods: [pod("blog-1", WEB, { namespace }), pod("root-1", WEB, { namespace: "roots" })],
  slices: ["blog", "blog-canary", "blog-shadow", "blog-admin", "blog-admin-old"].map((s) => into(namespace, slice(s, [{ pod: "blog-1" }]))).concat([into("roots", slice("rootapp", [{ pod: "root-1" }]))]),
  certificates: { "www-admin/example-com-wildcard": { state: "ready", info: { chain: [certificate(["*.bar.com"])], chainTruncated: false, ca: [], caInvalid: false } } },
});

describe("the Contour diagnosis", () => {
  it("is registered for HTTPProxy and reads the include namespaces and a delegated Secret", () => {
    expect(diagnosedKind(HTTP_PROXY)).toBe("registered");
    expect(contourDiagnoser.lists(root, "roots").map((l) => `${l.kind.kind}/${l.namespace}`)).toEqual([
      "HTTPProxy/roots",
      "HTTPProxy/marketing",
      "TLSCertificateDelegation/www-admin",
    ]);
    expect(contourDiagnoser.namespaces(root, "roots")).toEqual(["marketing", "marketing"]);
    expect(contourDiagnoser.secrets(root, "roots")).toEqual([{ namespace: "www-admin", name: "example-com-wildcard" }]);
  });

  it("follows a root through TLS, its routes and includes to the Services; a missing include breaks only its branch", () => {
    const chain = diagnose(HTTP_PROXY, root, contourView(healthyBlog("marketing"), { proxies: [root, blog], delegations: [delegation] }));
    // IncludeNotFound leaves the rest served: a warning, then the checks go on.
    expect(steps(chain)).toEqual(["contour.status:warn", "contour.host:ok", "contour.delegation:ok", "contour.certificate:ok"]);
    const titles = chain.chains.map((c) => c.title?.key);
    expect(titles).toEqual(["contour:diagnose.serviceTitle", "contour:diagnose.includeTitle", "contour:diagnose.includeTitle"]);
    const [rootRoute, included, missing] = chain.chains as [Chain, Chain, Chain];
    expect(chainStatus(rootRoute)).toBe("ok");
    expect(included.title?.params).toMatchObject({ name: "marketing/blogsite", prefix: "/blog" });
    expect(steps(included)).toEqual(["contour.include.status:ok"]);
    // The included proxy's routes go on under the include, with the prefixes joined.
    expect(included.chains.map((c) => c.title?.params?.prefix)).toEqual(["/blog", "/blog", "/blog", "/blog/admin", "/blog/admin"]);
    const mirror = included.chains[2]!;
    expect(keys(mirror)[0]).toBe("contour:diagnose.mirror");
    expect(steps(missing)).toEqual(["contour.include:broken", "…"]);
    expect(firstBroken(chain)?.text.key).toBe("contour:diagnose.includeMissing");
  });

  it("refuses a delegated Secret without a delegation for the namespace", () => {
    const chain = diagnoseProxy(root, HTTP_PROXY, contourView(healthyBlog("marketing"), { proxies: [root, blog], delegations: [] }));
    expect(steps(chain)).toEqual(["contour.status:warn", "contour.host:ok", "contour.delegation:broken", "…"]);
    expect(chain.chains).toEqual([]);
  });

  it("an orphaned proxy and a rejected one stop at once; one not processed yet only warns", () => {
    const v = contourView(healthyBlog("marketing"), { proxies: [orphan, duplicate, fresh] });
    expect(steps(diagnoseProxy(orphan, HTTP_PROXY, v))).toEqual(["contour.status:broken", "…"]);
    const rejected = diagnoseProxy(duplicate, HTTP_PROXY, v);
    expect(steps(rejected)).toEqual(["contour.status:broken", "…"]);
    expect(rejected.findings[0]!.notes?.[0]?.params).toMatchObject({ reason: "DuplicateVhost" });
    expect(diagnoseProxy(fresh, HTTP_PROXY, v).findings[0]).toMatchObject({ status: "warn", text: { key: "contour:diagnose.pendingClass" } });
  });

  it("a Service missing in the proxy's namespace breaks its branch; a weightless one among weighted gets nothing", () => {
    const route = structuredClone(blog);
    (route.spec as { routes: { services: { name: string; weight?: number }[] }[] }).routes[0]!.services[1] = { name: "nowhere", port: 80 } as never;
    (route.spec as { routes: { services: { weight?: number }[] }[] }).routes[1]!.services[0]!.weight = 5;
    const chain = diagnoseProxy(route, HTTP_PROXY, contourView(healthyBlog("marketing"), { proxies: [route] }));
    expect(steps(chain)).toEqual(["contour.status:ok", "contour.included:ok"]);
    const [, nowhere, , weighted, weightless] = chain.chains as Chain[];
    expect(steps(nowhere!)).toEqual(["contour.share:warn", "contour.service:broken", "…"]);
    expect(keys(nowhere!)[1]).toBe("contour:diagnose.serviceMissing");
    expect(steps(weighted!)[0]).toBe("contour.service:ok");
    expect(steps(weightless!)[0]).toBe("contour.share:warn");
  });

  it("an include in a namespace it cannot read is unknown, and deep includes stop at MAX_DEPTH", () => {
    const unknown = diagnoseProxy(root, HTTP_PROXY, contourView(healthyBlog("marketing"), { proxies: [root], delegations: [delegation], unreadable: ["marketing"] }));
    expect(steps(unknown.chains[1]!)).toEqual(["contour.include:unknown"]);
    // A chain of included proxies, each including the next.
    const level = (i: number): KubeObject => ({
      apiVersion: "projectcontour.io/v1",
      kind: "HTTPProxy",
      metadata: { name: `p${i}`, namespace: "marketing", uid: `p${i}` },
      spec: { includes: [{ name: `p${i + 1}`, conditions: [{ prefix: `/l${i}` }] }] },
      status: { currentStatus: "valid", conditions: [{ type: "Valid", status: "True", reason: "Valid", message: "Valid HTTPProxy" }] },
    });
    const all = Array.from({ length: MAX_DEPTH + 3 }, (_, i) => level(i));
    let chain = diagnoseProxy(all[0]!, HTTP_PROXY, contourView(healthyBlog("marketing"), { proxies: all }));
    let depth = 0;
    while (chain.chains.length > 0) {
      chain = chain.chains[0]!;
      depth++;
    }
    expect(depth).toBe(MAX_DEPTH);
    expect(steps(chain).at(-1)).toBe("contour.depth:unknown");
  });
});
