// A Route's details: whether a router admitted it (and why not, in the router's words), where it answers, its TLS
// termination with only whether each inline certificate field is set (the private key is never shown, nor any PEM),
// its backends — each Service with its weight, its share of the requests and its pods ready — and what each router
// says of it. The "Diagnosis" tab follows the path on to the pods (src/features/diagnose/openshift.ts).
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { status, StatusText } from "../../resources";
import { Block, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { isReady } from "../diagnose/objects";
import { serviceInfo } from "../netpol/model";
import { indexPods, selectPods } from "../resource-map/selectors";
import { percentText, RouteStateText } from "./columns";
import { useNamespaceBackends } from "./hooks";
import { routeAdmissions, routeBackends, routeReason, routeState, routeTargetPort, routeTls, routeUrl } from "./model";
import { date, LABELS, Muted, Note } from "./parts";

const { get, str } = status;

const BACKEND_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap", "nowrap"];
const ROUTER_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined, "nowrap"];
const TABLE_ROUTE_BACKENDS = "openshiftRouteBackends";
const TABLE_ROUTERS = "openshiftRouters";

export function RouteView({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const state = routeState(obj);
  const reason = routeReason(obj);
  const tls = routeTls(obj);
  const target = routeTargetPort(obj);
  const set = (value: boolean) => (value ? t("openshift:set") : null);
  const { services, pods } = useNamespaceBackends(clusterId, ns);
  const index = indexPods(pods.items);
  const rows: FieldRow[] = [
    ["status", <RouteStateText key="s" obj={obj} />],
    ["url", routeUrl(obj)],
    ["path", str(get(obj, "spec", "path"))],
    ["wildcardPolicy", str(get(obj, "spec", "wildcardPolicy"))],
    ["targetPort", target === undefined ? t("openshift:allPorts") : String(target)],
    ["termination", tls ? tls.termination : t("openshift:noTls")],
    ["insecure", tls ? (tls.insecure ?? t("openshift:insecureDefault")) : null],
    ["certificate", tls ? set(tls.certificate) : null],
    ["key", tls ? set(tls.key) : null],
    ["caCertificate", tls ? set(tls.caCertificate) : null],
    ["destinationCACertificate", tls ? set(tls.destinationCACertificate) : null],
    ["externalCertificate", tls ? link(KINDS.secret, tls.externalCertificate, ns) : null],
  ];
  const backends = routeBackends(obj).map((b) => {
    const svc = services.items.find((s) => s.metadata?.name === b.name);
    let ready = "";
    if (svc && ns && !pods.loading && !pods.error) {
      const selected = selectPods(index, ns, serviceInfo(svc).selector);
      ready = t("openshift:podsReady", { ready: selected.filter(isReady).length, total: selected.length });
    } else if (!services.loading && !services.error && !svc) ready = t("openshift:serviceMissing");
    return [link(KINDS.service, b.name, ns), String(b.weight), percentText(t, b.percent), ready];
  });
  const routers = routeAdmissions(obj).map((a) => [
    a.routerName,
    a.host ?? "",
    <StatusText key="a" value={t(`openshift:admitted.${a.admitted === "True" ? "yes" : a.admitted === "False" ? "no" : "unknown"}`)} tone={a.admitted === "True" ? "success" : a.admitted === "False" ? "danger" : "warning"} />,
    a.message || a.reason || "",
    date(a.since),
  ]);
  return (
    <>
      {state === "rejected" && reason && <Note text={reason} tone="danger" />}
      {state === "pending" && <Note text={t("openshift:routePending")} tone="warning" />}
      <Fields rows={rows} labelPrefix={LABELS} />
      {tls?.key && <Muted text={t("openshift:keyHidden")} />}
      <Block id="openshift:backends.title" title={t("openshift:backends.title")}>
        {table(
          TABLE_ROUTE_BACKENDS,
          [t("openshift:backends.service"), t("openshift:backends.weight"), t("openshift:backends.share"), t("openshift:backends.pods")],
          backends,
          BACKEND_WRAP,
        )}
        {backends.length === 0 && <Muted text={t("openshift:backends.none")} />}
      </Block>
      <Block id="openshift:routers.title" title={t("openshift:routers.title")}>
        {table(
          TABLE_ROUTERS,
          [t("openshift:routers.router"), t("openshift:routers.host"), t("openshift:routers.admitted"), t("openshift:routers.message"), t("openshift:routers.since")],
          routers,
          ROUTER_WRAP,
        )}
        {routers.length === 0 && <Muted text={t("openshift:routers.none")} />}
      </Block>
    </>
  );
}
