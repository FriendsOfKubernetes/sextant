import { useDetailsDisclosure } from "../../layout/details/disclosure";
// Details of Linkerd objects (#155), in plain words: a ServiceProfile's routes (which are retried, timeouts, the
// retry budget); a Server (which pods and port it describes, its default access) with the authorizations that target
// it; ServerAuthorizations, AuthorizationPolicies, MeshTLSAuthentications and NetworkAuthentications as who is let in;
// an HTTPRoute's parents and rules. The authorizations of a Server are listed from its namespace only (where Linkerd
// requires them to be), watched while the details are open.
import { useTranslation } from "react-i18next";
import { useWatch, type ClusterId, type KindRef, type KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { status, useClusterKinds } from "../../resources";
import { Block, chips, Fields, mapChips, type FieldRow } from "../details";
import { SimpleTable } from "../gateway-api/details";
import { inNamespaces, servedKind } from "../gateway-api/hooks";
import { LINKERD_AUTHORIZATION_POLICY, LINKERD_HTTP_ROUTE, LINKERD_SERVER, SERVER_AUTHORIZATION } from "./kinds";
import type { Ref } from "./istio";
import { meshLink, type T } from "./ui";

const { arr, get, record, str } = status;

const FIELDS = "mesh:fields";

const refTo = (kind: KindRef, namespace: string, name: string): Ref => ({ kind, namespace, name });

function ServiceProfileDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const routes = arr(get(obj, "spec", "routes"));
  const budget = get(obj, "spec", "retryBudget");
  const condition = (c: unknown): string =>
    [str(get(c, "method")), str(get(c, "pathRegex"))].filter(Boolean).join(" ") ||
    (arr(get(c, "all")).length > 0 || arr(get(c, "any")).length > 0 ? t("mesh:linkerd.compoundCondition") : "");
  const rows = routes.map((r, i) => ({
    key: `${i}`,
    cells: [
      str(get(r, "name")) ?? "",
      condition(get(r, "condition")),
      get(r, "isRetryable") === true ? t("mesh:yes") : t("mesh:no"),
      str(get(r, "timeout")) ?? "",
    ],
  }));
  return (
    <>
      <Block id="mesh:blocks.serviceProfile" title={t("mesh:blocks.serviceProfile")}>
        <p className="mesh-line">{t("mesh:linkerd.profileMeaning", { host: obj.metadata?.name ?? "" })}</p>
        {budget !== undefined && (
          <p className="mesh-line">
            {t("mesh:linkerd.retryBudget", {
              ratio: String(get(budget, "retryRatio") ?? ""),
              min: String(get(budget, "minRetriesPerSecond") ?? ""),
              ttl: str(get(budget, "ttl")) ?? "",
            })}
          </p>
        )}
      </Block>
      <Block id="mesh:blocks.profileRoutes" title={t("mesh:blocks.profileRoutes")}>
        <SimpleTable
          tableId="mesh.profileRoutes"
          headers={[t("mesh:columns.name"), t("mesh:columns.condition"), t("mesh:columns.retryable"), t("mesh:columns.timeout")]}
          rows={rows}
        />
      </Block>
    </>
  );
}

/** ServerAuthorizations and AuthorizationPolicies of the Server's namespace that target it. */
function ServerAuthorizations({ clusterId, server }: { clusterId: ClusterId; server: KubeObject }) {
  const { t } = useTranslation();
  const kinds = useClusterKinds(clusterId);
  const ns = server.metadata?.namespace ?? "";
  const name = server.metadata?.name ?? "";
  const labels = record(server.metadata?.labels);
  const open = useDetailsDisclosure("mesh:blocks.serverAuthorizations")?.open ?? true;
  const sa = useWatch(clusterId, open ? inNamespaces(servedKind(kinds, SERVER_AUTHORIZATION), [ns]) : null);
  const ap = useWatch(clusterId, open ? inNamespaces(servedKind(kinds, LINKERD_AUTHORIZATION_POLICY), [ns]) : null);
  const bySa = [...sa.items.values()].filter((o) => {
    const target = get(o, "spec", "server");
    if (str(get(target, "name"))) return str(get(target, "name")) === name;
    const sel = record(get(target, "selector", "matchLabels"));
    return Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => String(labels[k]) === String(v));
  });
  const byAp = [...ap.items.values()].filter((o) => {
    const target = get(o, "spec", "targetRef");
    const kind = str(get(target, "kind"));
    return (kind === "Server" && str(get(target, "name")) === name) || kind === "Namespace";
  });
  const list = [
    ...bySa.map((o) => refTo(SERVER_AUTHORIZATION, ns, o.metadata?.name ?? "")),
    ...byAp.map((o) => refTo(LINKERD_AUTHORIZATION_POLICY, ns, o.metadata?.name ?? "")),
  ];
  return (
    <Block id="mesh:blocks.serverAuthorizations" title={t("mesh:blocks.serverAuthorizations")}>
      {list.length === 0 ? (
        <p className="mesh-line">{t("mesh:linkerd.noAuthorizations")}</p>
      ) : (
        <span className="dt-links">{list.map((r) => meshLink(r, `${r.kind.kind} ${r.name}`))}</span>
      )}
    </Block>
  );
}

function ServerDetails({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const selector = get(obj, "spec", "podSelector") ?? get(obj, "spec", "externalWorkloadSelector");
  const access = str(get(obj, "spec", "accessPolicy"));
  const rows: FieldRow[] = [
    ["podSelector", mapChips(get(selector, "matchLabels"))],
    ["port", String(get(obj, "spec", "port") ?? "")],
    ["proxyProtocol", str(get(obj, "spec", "proxyProtocol"))],
    ["accessPolicy", access],
  ];
  return (
    <>
      <Block id="mesh:blocks.server" title={t("mesh:blocks.server")}>
        <Fields rows={rows} labelPrefix={FIELDS} />
        <p className="mesh-line">{t("mesh:linkerd.serverMeaning")}</p>
      </Block>
      <ServerAuthorizations clusterId={clusterId} server={obj} />
    </>
  );
}

function clientLines(client: unknown, t: T): string[] {
  const out: string[] = [];
  if (get(client, "unauthenticated") === true) out.push(t("mesh:linkerd.client.unauthenticated"));
  const tls = get(client, "meshTLS");
  if (get(tls, "unauthenticatedTLS") === true) out.push(t("mesh:linkerd.client.unauthenticatedTls"));
  const ids = arr(get(tls, "identities")).map(String);
  if (ids.length > 0) out.push(t("mesh:linkerd.client.identities", { values: formatList(ids) }));
  const sas = arr(get(tls, "serviceAccounts")).map((s) => [str(get(s, "namespace")), str(get(s, "name"))].filter(Boolean).join("/"));
  if (sas.length > 0) out.push(t("mesh:linkerd.client.serviceAccounts", { values: formatList(sas) }));
  const nets = arr(get(client, "networks")).map((n) => str(get(n, "cidr")) ?? "");
  if (nets.length > 0) out.push(t("mesh:linkerd.client.networks", { values: formatList(nets) }));
  return out;
}

function ServerAuthorizationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? "";
  const server = str(get(obj, "spec", "server", "name"));
  const rows: FieldRow[] = [
    ["server", server ? meshLink(refTo(LINKERD_SERVER, ns, server)) : mapChips(get(obj, "spec", "server", "selector", "matchLabels"))],
  ];
  const clients = clientLines(get(obj, "spec", "client"), t);
  return (
    <Block id="mesh:blocks.serverAuthorization" title={t("mesh:blocks.serverAuthorization")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
      <p className="mesh-line">{t("mesh:linkerd.allows")}</p>
      {clients.map((l) => (
        <p key={l} className="mesh-line">
          {l}
        </p>
      ))}
    </Block>
  );
}

function LinkerdAuthorizationPolicyDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? "";
  const target = get(obj, "spec", "targetRef");
  const kind = str(get(target, "kind")) ?? "";
  const name = str(get(target, "name")) ?? "";
  const targetRef =
    kind === "Server" ? meshLink(refTo(LINKERD_SERVER, ns, name)) : kind === "HTTPRoute" ? meshLink(refTo(LINKERD_HTTP_ROUTE, ns, name)) : `${kind} ${name}`;
  const auth = arr(get(obj, "spec", "requiredAuthenticationRefs")).map((r) => `${str(get(r, "kind")) ?? ""} ${str(get(r, "name")) ?? ""}`);
  const rows: FieldRow[] = [
    ["target", targetRef],
    ["requiredAuthentications", chips(auth)],
  ];
  return (
    <Block id="mesh:blocks.linkerdAuthorizationPolicy" title={t("mesh:blocks.linkerdAuthorizationPolicy")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
      <p className="mesh-line">{auth.length === 0 ? t("mesh:linkerd.policyNoAuth") : t("mesh:linkerd.policyMeaning")}</p>
    </Block>
  );
}

function MeshTlsAuthenticationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const refs = arr(get(obj, "spec", "identityRefs")).map((r) =>
    [str(get(r, "kind")), [str(get(r, "namespace")), str(get(r, "name"))].filter(Boolean).join("/")].filter(Boolean).join(" "),
  );
  const rows: FieldRow[] = [
    ["identities", chips(arr(get(obj, "spec", "identities")).map(String))],
    ["identityRefs", chips(refs)],
  ];
  return (
    <Block id="mesh:blocks.meshTlsAuthentication" title={t("mesh:blocks.meshTlsAuthentication")}>
      <p className="mesh-line">{t("mesh:linkerd.meshTlsMeaning")}</p>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function NetworkAuthenticationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const nets = arr(get(obj, "spec", "networks")).map((n) => {
    const except = arr(get(n, "except")).map(String);
    const cidr = str(get(n, "cidr")) ?? "";
    return except.length > 0 ? t("mesh:linkerd.networkExcept", { cidr, except: formatList(except) }) : cidr;
  });
  const rows: FieldRow[] = [["networks", chips(nets)]];
  return (
    <Block id="mesh:blocks.networkAuthentication" title={t("mesh:blocks.networkAuthentication")}>
      <p className="mesh-line">{t("mesh:linkerd.networkMeaning")}</p>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function LinkerdHttpRouteDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? "";
  const parents = arr(get(obj, "spec", "parentRefs")).map((p) => {
    const kind = str(get(p, "kind")) ?? "";
    const name = str(get(p, "name")) ?? "";
    return kind === "Server" ? meshLink(refTo(LINKERD_SERVER, str(get(p, "namespace")) ?? ns, name)) : `${kind} ${name}`;
  });
  const fields: FieldRow[] = [
    ["parents", <span className="dt-links">{parents}</span>],
    ["hostnames", chips(arr(get(obj, "spec", "hostnames")).map(String))],
  ];
  const rows = arr(get(obj, "spec", "rules")).map((r, i) => ({
    key: `${i}`,
    cells: [
      formatList(arr(get(r, "matches")).map((m) => [str(get(m, "method")), str(get(m, "path", "value"))].filter(Boolean).join(" "))) ||
        t("mesh:route.everyRequest"),
      formatList(arr(get(r, "backendRefs")).map((b) => [str(get(b, "name")), get(b, "port")].filter((x) => x !== undefined).join(":"))),
    ],
  }));
  return (
    <>
      <Block id="mesh:blocks.linkerdHttpRoute" title={t("mesh:blocks.linkerdHttpRoute")}>
        <Fields rows={fields} labelPrefix={FIELDS} />
      </Block>
      <Block id="mesh:blocks.httpRoutes" title={t("mesh:blocks.httpRoutes")}>
        <SimpleTable
          tableId="mesh.httpRoutes"
          headers={[t("mesh:columns.match"), t("mesh:columns.destinations")]}
          rows={rows}
        />
      </Block>
    </>
  );
}

export function LinkerdDetails({ clusterId, obj, kind }: { clusterId: ClusterId; obj: KubeObject; kind: KindRef }) {
  if (kind.group === "linkerd.io") return <ServiceProfileDetails obj={obj} />;
  switch (kind.kind) {
    case "Server":
      return <ServerDetails clusterId={clusterId} obj={obj} />;
    case "ServerAuthorization":
      return <ServerAuthorizationDetails obj={obj} />;
    case "AuthorizationPolicy":
      return <LinkerdAuthorizationPolicyDetails obj={obj} />;
    case "MeshTLSAuthentication":
      return <MeshTlsAuthenticationDetails obj={obj} />;
    case "NetworkAuthentication":
      return <NetworkAuthenticationDetails obj={obj} />;
    case "HTTPRoute":
      return <LinkerdHttpRouteDetails obj={obj} />;
    default:
      return null;
  }
}
