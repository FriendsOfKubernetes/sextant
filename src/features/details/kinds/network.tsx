// Service (type, IPs, ports, selector, link to its Endpoints), Endpoints (addresses with their pods and nodes) and
// Ingress (rules with backend services, TLS).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import { Block, chips, Fields, KINDS, link, mapChips, nsOf, strings, table, text, type FieldRow } from "../ui";

const { arr, externalIps, get, str } = status;

export function ServiceDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec");
  const ns = nsOf(obj);
  const clusterIps = strings(get(spec, "clusterIPs"));
  const rows: FieldRow[] = [
    ["type", str(get(spec, "type"))],
    ["clusterIps", (clusterIps.length > 0 ? clusterIps : strings([get(spec, "clusterIP")])).join(", ")],
    ["externalIps", externalIps(obj)],
    ["externalName", str(get(spec, "externalName"))],
    ["sessionAffinity", str(get(spec, "sessionAffinity"))],
    ["ipFamilies", strings(get(spec, "ipFamilies")).join(", ")],
    ["externalTrafficPolicy", str(get(spec, "externalTrafficPolicy"))],
    ["selector", mapChips(get(spec, "selector"))],
    ["endpoints", link(KINDS.endpoints, obj.metadata?.name, ns)],
  ];
  const ports = table(
    [
      t("details:columns.name"),
      t("details:columns.port"),
      t("details:columns.targetPort"),
      t("details:columns.nodePort"),
      t("details:columns.protocol"),
    ],
    arr(get(spec, "ports")).map((p) => [
      str(get(p, "name")),
      text(get(p, "port")),
      text(get(p, "targetPort")),
      text(get(p, "nodePort")),
      str(get(p, "protocol")) ?? "TCP",
    ]),
  );
  return (
    <>
      <Fields rows={rows} />
      {ports && <Block title={t("details:service.ports")}>{ports}</Block>}
    </>
  );
}

export function EndpointsDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = nsOf(obj);
  const rows = arr(get(obj, "subsets")).flatMap((subset) => {
    const ports = arr(get(subset, "ports"))
      .map((p) => {
        const name = str(get(p, "name"));
        return `${name ? `${name}: ` : ""}${text(get(p, "port")) ?? ""}/${str(get(p, "protocol")) ?? "TCP"}`;
      })
      .join(", ");
    const address = (a: unknown, ready: boolean): ReactNode[] => {
      const target = get(a, "targetRef");
      const kind = str(get(target, "kind")) ?? "Pod";
      const name = str(get(target, "name"));
      return [
        str(get(a, "ip")),
        link(KINDS.node, str(get(a, "nodeName"))),
        target
          ? link({ apiVersion: str(get(target, "apiVersion")) ?? "v1", kind }, name, str(get(target, "namespace")) ?? ns, `${kind} ${name ?? ""}`)
          : null,
        ports,
        ready ? t("details:endpoints.ready") : t("details:endpoints.notReady"),
      ];
    };
    return [
      ...arr(get(subset, "addresses")).map((a) => address(a, true)),
      ...arr(get(subset, "notReadyAddresses")).map((a) => address(a, false)),
    ];
  });
  const content = table(
    [
      t("details:columns.address"),
      t("details:columns.node"),
      t("details:columns.target"),
      t("details:fields.ports"),
      t("details:columns.status"),
    ],
    rows,
  );
  if (!content) return null;
  return <Block title={t("details:endpoints.subsets")}>{content}</Block>;
}

function backend(value: unknown, namespace: string | null): ReactNode {
  const service = get(value, "service");
  if (service) {
    const port = text(get(service, "port", "number")) ?? text(get(service, "port", "name"));
    const name = str(get(service, "name"));
    return link(KINDS.service, name, namespace, port ? `${name ?? ""}:${port}` : name);
  }
  const resource = get(value, "resource");
  if (resource) return `${str(get(resource, "kind")) ?? ""}/${str(get(resource, "name")) ?? ""}`;
  return null;
}

export function IngressDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const spec = get(obj, "spec");
  const ns = nsOf(obj);
  const lb = arr(get(obj, "status", "loadBalancer", "ingress"))
    .map((i) => str(get(i, "ip")) ?? str(get(i, "hostname")) ?? "")
    .filter(Boolean);
  const fields: FieldRow[] = [
    ["ingressClass", link(KINDS.ingressClass, str(get(spec, "ingressClassName")))],
    ["defaultBackend", backend(get(spec, "defaultBackend"), ns)],
    ["loadBalancer", chips(lb)],
  ];
  const rules = table(
    [t("details:columns.host"), t("details:columns.path"), t("details:columns.pathType"), t("details:columns.backend")],
    arr(get(spec, "rules")).flatMap((rule) => {
      const host = str(get(rule, "host")) ?? "*";
      return arr(get(rule, "http", "paths")).map((p) => [
        host,
        str(get(p, "path")) ?? "/",
        str(get(p, "pathType")),
        backend(get(p, "backend"), ns),
      ]);
    }),
  );
  const tls = table(
    [t("details:columns.hosts"), t("details:columns.secret")],
    arr(get(spec, "tls")).map((entry) => [
      strings(get(entry, "hosts")).join(", "),
      link(KINDS.secret, str(get(entry, "secretName")), ns),
    ]),
  );
  return (
    <>
      <Fields rows={fields} />
      {rules && <Block title={t("details:ingress.rules")}>{rules}</Block>}
      {tls && <Block title={t("details:ingress.tls")}>{tls}</Block>}
    </>
  );
}
