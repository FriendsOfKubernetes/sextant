// Network: Services, Endpoints, Ingresses, IngressClasses, NetworkPolicies (Port Forwarding is a page).
import { column, standardColumns, StatusText } from "../columns";
import { registerResource } from "../registry";
import { arr, externalIps, get, selectorText, servicePorts, str } from "../status";

registerResource({
  kind: { group: "", version: "v1", kind: "Service" },
  sidebar: { section: "network", order: 10, labelKey: "resources:kinds.services" },
  columns: [
    ...standardColumns(
      true,
      column("type", (o) => str(get(o, "spec", "type")), { width: "100px" }),
      column("clusterIp", (o) => str(get(o, "spec", "clusterIP")), { width: "minmax(100px, 1fr)" }),
      column("ports", servicePorts, { width: "minmax(110px, 1.5fr)" }),
      column("externalIp", externalIps, { width: "minmax(100px, 1fr)" }),
      column("selector", (o) => selectorText(get(o, "spec", "selector")), { width: "minmax(120px, 1.5fr)" }),
    ),
    column("status", (o) => serviceStatus(o), {
      width: "80px",
      render: (o) => <StatusText value={serviceStatus(o)} tone={serviceStatus(o) === "Active" ? "success" : "warning"} />,
    }),
  ],
  actions: ["portForward", "edit", "delete"],
});

/** Lens: a LoadBalancer without an address is "Pending", everything else "Active". */
function serviceStatus(o: unknown): string {
  if (str(get(o, "spec", "type")) !== "LoadBalancer") return "Active";
  return arr(get(o, "status", "loadBalancer", "ingress")).length > 0 ? "Active" : "Pending";
}

/** "10.244.0.5:80, 10.244.0.6:80". */
function endpointAddresses(o: unknown): string {
  return arr(get(o, "subsets"))
    .flatMap((subset) => {
      const ports = arr(get(subset, "ports")).map((p) => get(p, "port"));
      return arr(get(subset, "addresses")).flatMap((a) => {
        const ip = str(get(a, "ip")) ?? "";
        return ports.length > 0 ? ports.map((p) => `${ip}:${String(p)}`) : [ip];
      });
    })
    .join(", ");
}

registerResource({
  kind: { group: "", version: "v1", kind: "Endpoints" },
  sidebar: { section: "network", order: 20, labelKey: "resources:kinds.endpoints" },
  columns: standardColumns(true, column("endpoints", endpointAddresses, { width: "minmax(200px, 4fr)" })),
  actions: ["edit", "delete"],
});

/** "host/path ⇢ service:port" per rule. */
function ingressRules(o: unknown): string {
  return arr(get(o, "spec", "rules"))
    .flatMap((rule) => {
      const host = str(get(rule, "host")) ?? "*";
      return arr(get(rule, "http", "paths")).map((p) => {
        const service = str(get(p, "backend", "service", "name")) ?? "";
        const port = get(p, "backend", "service", "port", "number") ?? get(p, "backend", "service", "port", "name") ?? "";
        return `${host}${str(get(p, "path")) ?? "/"} ⇢ ${service}:${String(port)}`;
      });
    })
    .join(", ");
}

registerResource({
  kind: { group: "networking.k8s.io", version: "v1", kind: "Ingress" },
  sidebar: { section: "network", order: 30, labelKey: "resources:kinds.ingresses" },
  columns: standardColumns(
    true,
    column(
      "loadBalancers",
      (o) =>
        arr(get(o, "status", "loadBalancer", "ingress"))
          .map((i) => str(get(i, "ip")) ?? str(get(i, "hostname")) ?? "")
          .join(", "),
      { width: "minmax(120px, 1fr)" },
    ),
    column("rules", ingressRules, { width: "minmax(200px, 3fr)" }),
  ),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "networking.k8s.io", version: "v1", kind: "IngressClass" },
  sidebar: { section: "network", order: 40, labelKey: "resources:kinds.ingressclasses" },
  namespaced: false,
  columns: standardColumns(
    false,
    column("controller", (o) => str(get(o, "spec", "controller")), { width: "minmax(160px, 2fr)" }),
    column("apiGroup", (o) => str(get(o, "spec", "parameters", "apiGroup")), { width: "minmax(100px, 1fr)" }),
    column("scope", (o) => str(get(o, "spec", "parameters", "scope")), { width: "90px" }),
    column("kind", (o) => str(get(o, "spec", "parameters", "kind")), { width: "100px" }),
  ),
  actions: ["edit", "delete"],
});

registerResource({
  kind: { group: "networking.k8s.io", version: "v1", kind: "NetworkPolicy" },
  sidebar: { section: "network", order: 50, labelKey: "resources:kinds.networkpolicies" },
  columns: standardColumns(
    true,
    column("policyTypes", (o) => arr(get(o, "spec", "policyTypes")).map(String).join(", "), {
      width: "minmax(120px, 2fr)",
    }),
  ),
  actions: ["edit", "delete"],
});
