// Storage: PersistentVolumeClaims, PersistentVolumes, StorageClasses.
import { column, ObjectLink, standardColumns, statusColumn } from "../columns";
import { registerResource } from "../registry";
import { get, labelsOf, str } from "../status";

registerResource({
  kind: { group: "", version: "v1", kind: "PersistentVolumeClaim" },
  sidebar: { section: "storage", order: 10, labelKey: "resources:kinds.persistentvolumeclaims" },
  columns: [
    ...standardColumns(
      true,
      column("storageClass", (o) => str(get(o, "spec", "storageClassName")), { width: "minmax(120px, 1fr)" }),
      column(
        "size",
        (o) => str(get(o, "status", "capacity", "storage")) ?? str(get(o, "spec", "resources", "requests", "storage")),
        { width: "90px" },
      ),
    ),
    statusColumn("status", (o) => str(get(o, "status", "phase"))),
  ],
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "", version: "v1", kind: "PersistentVolume" },
  sidebar: { section: "storage", order: 20, labelKey: "resources:kinds.persistentvolumes" },
  namespaced: false,
  columns: [
    ...standardColumns(
      false,
      column("storageClass", (o) => str(get(o, "spec", "storageClassName")), { width: "minmax(120px, 1fr)" }),
      column("capacity", (o) => str(get(o, "spec", "capacity", "storage")), { width: "90px" }),
      column(
        "claim",
        (o) => {
          const ns = str(get(o, "spec", "claimRef", "namespace"));
          const name = str(get(o, "spec", "claimRef", "name"));
          return name ? `${ns ?? ""}/${name}` : undefined;
        },
        {
          width: "minmax(140px, 2fr)",
          render: (o) => {
            const name = str(get(o, "spec", "claimRef", "name"));
            const ns = str(get(o, "spec", "claimRef", "namespace")) ?? null;
            return name ? (
              <ObjectLink target={{ apiVersion: "v1", kind: "PersistentVolumeClaim", name }} namespace={ns}>
                {name}
              </ObjectLink>
            ) : null;
          },
        },
      ),
    ),
    statusColumn("status", (o) => str(get(o, "status", "phase"))),
  ],
  actions: ["edit", "delete"],
});

const DEFAULT_CLASS = "storageclass.kubernetes.io/is-default-class";

registerResource({
  kind: { group: "storage.k8s.io", version: "v1", kind: "StorageClass" },
  sidebar: { section: "storage", order: 30, labelKey: "resources:kinds.storageclasses" },
  namespaced: false,
  columns: standardColumns(
    false,
    column("provisioner", (o) => str(get(o, "provisioner")), { width: "minmax(160px, 2fr)" }),
    column("reclaimPolicy", (o) => str(get(o, "reclaimPolicy")), { width: "110px" }),
    column(
      "isDefault",
      (o) => String((get(o, "metadata", "annotations", DEFAULT_CLASS) ?? labelsOf(o)[DEFAULT_CLASS]) === "true"),
      { width: "80px" },
    ),
  ),
  actions: ["edit", "delete"],
});
