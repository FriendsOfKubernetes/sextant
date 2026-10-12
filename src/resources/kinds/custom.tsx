// Custom Resources → Definitions: the list of CRDs (watched only while this table is open: CRDs carry their
// schemas). The per-group tree of custom resources is built by the sidebar from discovery; each CR table uses the
// generic description with the printer columns of its one CRD.
import type { KubeObject } from "../../api";
import { column, standardColumns } from "../columns";
import { registerResource } from "../registry";
import { arr, get, str } from "../status";

export const CRD_KIND = { group: "apiextensions.k8s.io", version: "v1", kind: "CustomResourceDefinition" };

/** The version a CRD stores (served first if none is marked). */
export function crdVersion(crd: KubeObject): string {
  const versions = arr(get(crd, "spec", "versions"));
  const storage = versions.find((v) => get(v, "storage") === true) ?? versions.find((v) => get(v, "served") === true);
  return str(get(storage, "name")) ?? "";
}

registerResource({
  kind: CRD_KIND,
  sidebar: { section: "customResources", order: 0, labelKey: "resources:kinds.definitions" },
  namespaced: false,
  columns: standardColumns(
    false,
    column("resource", (o) => str(get(o, "spec", "names", "kind")), { width: "minmax(120px, 1.5fr)" }),
    column("group", (o) => str(get(o, "spec", "group")), { width: "minmax(140px, 2fr)" }),
    column("version", crdVersion, { width: "80px" }),
    column("scope", (o) => str(get(o, "spec", "scope")), { width: "100px" }),
  ),
  actions: ["edit", "delete"],
});
