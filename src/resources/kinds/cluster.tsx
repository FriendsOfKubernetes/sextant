// Nodes and Namespaces — columns as in Lens (CPU/Memory/Disk of nodes come from the metrics feature).
import { column, labelsColumn, standardColumns, StatusList, statusColumn } from "../columns";
import { registerResource } from "../registry";
import { arr, get, nodeConditions, nodeRoles, str } from "../status";

registerResource({
  kind: { group: "", version: "v1", kind: "Node" },
  sidebar: { section: "nodes", order: 0, labelKey: "resources:kinds.nodes", icon: "node" },
  namespaced: false,
  columns: [
    ...standardColumns(
      false,
      column("taints", (o) => arr(get(o, "spec", "taints")).length, { width: "70px" }),
      column("roles", (o) => nodeRoles(o).join(", "), { width: "minmax(100px, 1fr)" }),
      column("version", (o) => str(get(o, "status", "nodeInfo", "kubeletVersion")), { width: "100px" }),
    ),
    column("conditions", (o) => nodeConditions(o).join(" "), {
      width: "minmax(120px, 1.5fr)",
      render: (o) => (
        <StatusList
          values={nodeConditions(o)}
          tone={(c) => (c === "Ready" ? "success" : c === "SchedulingDisabled" ? "warning" : "danger")}
        />
      ),
    }),
  ],
  actions: ["cordon", "drain", "edit", "delete"],
});

registerResource({
  kind: { group: "", version: "v1", kind: "Namespace" },
  sidebar: { section: "namespaces", order: 0, labelKey: "resources:kinds.namespaces", icon: "namespace" },
  namespaced: false,
  columns: [
    ...standardColumns(false, labelsColumn),
    statusColumn("status", (o) => str(get(o, "status", "phase"))),
  ],
  actions: ["edit", "delete"],
});
