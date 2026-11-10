import { describe, expect, it } from "vitest";
import type { KubeObject } from "../../api";
import { getDetailsSections } from "../../layout/details/registry";
import { getResourceDef } from "../../resources";
import { delegationFor, HTTP_PROXY, includesOf, joinPrefixes, proxyState, routesOf, servedInPart, shares, tlsOf } from "./contourModel";
import delegationJson from "./fixtures/contour-delegation.json";
import proxiesJson from "./fixtures/contour-proxies.json";
import "./register";

const proxies = proxiesJson as KubeObject[];
const [root, blog, , duplicate] = proxies as [KubeObject, KubeObject, KubeObject, KubeObject, KubeObject];
const delegation = delegationJson as KubeObject;

describe("what the diagnosis reads of an HTTPProxy", () => {
  it("reads Contour's states, including the CRD's default NotReconciled", () => {
    expect(proxies.map(proxyState)).toEqual(["invalid", "valid", "orphaned", "invalid", "pending"]);
    // An include that is not found leaves the rest served; a duplicate host drops the virtual host.
    expect(servedInPart(root)).toBe(true);
    expect(servedInPart(duplicate)).toBe(false);
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

  it("reads the includes and joins their prefixes as Contour does", () => {
    expect(includesOf(root).map((i) => `${i.namespace}/${i.name} ${i.prefix}`)).toEqual(["marketing/blogsite /blog", "marketing/missing-site /missing"]);
    // As Contour's mergePathMatchConditions: concatenated, slashes collapsed, a trailing slash kept.
    expect(joinPrefixes(["/api", "/v1/"])).toBe("/api/v1/");
    expect(joinPrefixes(["/blog", "/"])).toBe("/blog/");
    expect(joinPrefixes(["/", "/blog"])).toBe("/blog");
    expect(joinPrefixes(["/a/", "/b"])).toBe("/a/b");
    expect(joinPrefixes(["///", "/"])).toBe("/");
    expect(joinPrefixes([undefined, "/"])).toBe("/");
    expect(joinPrefixes([])).toBe("/");
  });

  it("offers the Diagnose action and the Diagnosis tab on HTTPProxies, whose views are an extension's", () => {
    expect(getResourceDef(HTTP_PROXY).actions).toContain("diagnose");
    expect(getDetailsSections(HTTP_PROXY).map((s) => s.id)).toContain("diagnosis");
  });
});
