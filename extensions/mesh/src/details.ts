// The details section `mesh` (the manifest's `contributes.detailsSections`) of every Istio and Linkerd kind, untitled
// at the built-in section's place (order 20: in place of the generic fields, before the conditions), drawn as the
// built-in `istioDetails.tsx` and `linkerdDetails.tsx` drew it (#155, ADR-0089), in plain words:
//   VirtualService — its mesh problems, hosts, gateways, export, "Check a request…", its HTTP routes as "when … then …"
//                    lines with weights, retries, timeouts and faults, and its TCP/TLS routes;
//   DestinationRule — its mesh problems, host, TLS mode, load balancer, port TLS and subsets;
//   Gateway — its selector, servers and the VirtualServices bound to it;
//   ServiceEntry, Sidecar, WorkloadEntry, Telemetry, PeerAuthentication, RequestAuthentication, AuthorizationPolicy;
//   ServiceProfile, Server (with the authorizations that target it), ServerAuthorization, Linkerd AuthorizationPolicy,
//   MeshTLSAuthentication, NetworkAuthentication, HTTPRoute.
// The Istio configuration (store.ts) is watched only where the built-in held it: always for a VirtualService's or
// DestinationRule's problems, and for a Gateway's bound VirtualServices while that block is open; a Server's
// authorizations are watched in its namespace while their block is open. Read-only.
import { ui, type KindRef, type KubeObject, type ObjectRef, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { block, BlockMemory, batched, el, errorText, fieldsOf, line, links, mapChips, meshLink, muted, phraseLines, redraw, table, warningIcon, type Blocks } from "./dom";
import { parseAuthorizationPolicy } from "./engine/authz";
import {
  parseDestinationRule,
  parseIstioGateway,
  parseServiceEntry,
  parseVirtualService,
  ROOT_NAMESPACE,
  type HttpRoute,
  type L4Route,
  type Ref,
  type VirtualService,
} from "./engine/istio";
import { LINKERD, LINKERD_AUTHORIZATION_POLICY, LINKERD_HTTP_ROUTE, LINKERD_SERVER, meshKind, SERVER_AUTHORIZATION } from "./engine/kinds";
import { parsePeerAuthentication } from "./engine/mtls";
import { destinationText, matchPhrases, policyPhrases, routeAction, routeExtras, ruleLines, type RuleLine } from "./engine/phrases";
import { weightsOf } from "./engine/routing";
import { arr, get, record, str } from "./engine/util";
import { formatList, t, tOr } from "./i18n";
import { openMeshCheck } from "./checkState";
import { Discovery, Lists, meshConfig, servedKind, type MeshConfig } from "./store";

/** What a view needs besides its object: links, blocks, the shared configuration and the lists it watches. */
export interface DetailsEnv {
  sextant: Sextant;
  blocks: Blocks;
  /** The cluster's Istio configuration, watched from now on (while the drawing asks for it). */
  config: () => MeshConfig;
  lists: Lists;
  discovery: Discovery;
}

const exportText = (exportTo: string[]) => (exportTo.length === 0 ? t("exportTo.everywhere") : formatList(exportTo));

// ---------- problems ----------

/** The mesh problems of `obj` (VirtualServices and DestinationRules), each a warning line, as the built-in. */
function objectProblems(env: DetailsEnv, obj: KubeObject): HTMLElement | null {
  const config = env.config();
  const uid = obj.metadata.uid;
  const mine = config.problems.filter((p) => p.uid === uid);
  if (mine.length === 0) return null;
  const node = el(
    "div",
    "mesh-problems",
    mine.map((p) => el("p", "mesh-problem", warningIcon(), el("span", "", el("strong", "", p.reason), " ", t(`problem.${p.reason}`, p.params)))),
  );
  node.setAttribute("role", "alert");
  return node;
}

// ---------- VirtualService ----------

function routeCard(route: HttpRoute): HTMLElement {
  const title = route.name ? t("route.titleNamed", { n: route.index + 1, name: route.name }) : t("route.title", { n: route.index + 1 });
  const action = routeAction(route);
  const weights = weightsOf(route.destinations);
  const when = el(
    "div",
    "mesh-route__part",
    el("span", "mesh-route__label", t("route.when")),
    route.matches.length === 0
      ? line(t("route.everyRequest"))
      : route.matches.map((m, i) =>
          el("div", "mesh-route__match", route.matches.length > 1 ? el("span", "sx-muted", t("route.alternative", { n: i + 1 })) : null, phraseLines(matchPhrases(m))),
        ),
  );
  const then = el(
    "div",
    "mesh-route__part",
    el("span", "mesh-route__label", t("route.then")),
    action
      ? line(t(action.key, action.params))
      : route.destinations.map((d, i) =>
          line(
            d.subset
              ? t("route.toSubset", { host: destinationText(d), subset: d.subset, percent: weights[i] ?? 0 })
              : t("route.to", { host: destinationText(d), percent: weights[i] ?? 0 }),
          ),
        ),
    phraseLines(routeExtras(route)),
  );
  const card = el("div", "mesh-route", el("h4", "mesh-route__title", title), when, then);
  card.dataset.route = String(route.index);
  return card;
}

function l4Table(sextant: Sextant, routes: L4Route[]): HTMLElement {
  return table(
    sextant,
    "l4Routes",
    [t("l4.kind"), t("l4.match"), t("l4.destinations")],
    routes.map((r) => ({
      cells: [
        r.kind.toUpperCase(),
        formatList([...r.ports.map(String), ...r.sniHosts]) || t("route.everyConnection"),
        formatList(r.destinations.map((d, i) => `${destinationText(d)}${d.subset ? ` (${d.subset})` : ""} ${weightsOf(r.destinations)[i] ?? 0}%`)),
      ],
    })),
  );
}

function virtualServiceView(env: DetailsEnv, vs: VirtualService): UiContent[] {
  const { sextant, blocks } = env;
  const firstHost = vs.hosts.find((h) => !h.startsWith("*")) ?? vs.hosts[0]?.replace(/^\*\./, "www.");
  const gateway = vs.gateways.find((g) => g !== "mesh");
  const check = ui.button(
    t("check.open"),
    () =>
    void openMeshCheck(sextant, {
      url: firstHost ? `http://${firstHost}/` : "",
      from: vs.gateways.includes("mesh") || !gateway ? "mesh" : "gateway",
      namespace: vs.namespace,
      gateway: gateway ?? "",
    }),
    { icon: "requestCheck" },
  );
  const canCheck = !vs.delegate && vs.http.length > 0;
  return [
    objectProblems(env, vs.obj),
    block(
      blocks,
      "virtualService",
      t("blocks.virtualService"),
      () =>
        fieldsOf([
          ["hosts", vs.delegate ? t("vs.delegate") : ui.chips(vs.hosts)],
          ["gateways", ui.chips(vs.gateways.map((g) => (g === "mesh" ? t("vs.meshGateway") : g)))],
          ["exportTo", exportText(vs.exportTo)],
        ]),
      canCheck ? [check] : undefined,
    ),
    vs.http.length > 0 ? block(blocks, "httpRoutes", t("blocks.httpRoutes"), () => [muted(t("route.order")), ...vs.http.map(routeCard)]) : null,
    vs.l4.length > 0 ? block(blocks, "l4Routes", t("blocks.l4Routes"), () => l4Table(env.sextant, vs.l4)) : null,
  ];
}

// ---------- DestinationRule ----------

function destinationRuleView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const { blocks } = env;
  const rule = parseDestinationRule(obj);
  return [
    objectProblems(env, obj),
    block(blocks, "destinationRule", t("blocks.destinationRule"), () =>
      fieldsOf([
        ["host", rule.host],
        ["tlsMode", rule.tlsMode ? tOr(`tls.mode.${rule.tlsMode}`, rule.tlsMode) : t("tls.auto")],
        ["loadBalancer", rule.loadBalancer],
        ["exportTo", exportText(rule.exportTo)],
        ["workloadSelector", rule.hasWorkloadSelector ? mapChips(get(obj, "spec", "workloadSelector", "matchLabels")) : null],
      ]),
    ),
    rule.portTls.length > 0
      ? block(blocks, "portTls", t("blocks.portTls"), () => table(env.sextant, "portTls", [t("columns.port"), t("columns.tlsMode")], rule.portTls.map((p) => ({ cells: [p.port, p.mode] }))))
      : null,
    rule.subsets.length > 0
      ? block(blocks, "subsets", t("blocks.subsets"), () => [
          muted(t("dr.subsetsHint")),
          table(
            env.sextant,
            "subsets",
            [t("columns.name"), t("columns.labels"), t("columns.tlsMode")],
            rule.subsets.map((s) => ({ cells: [s.name, mapChips(s.labels), s.tlsMode ?? ""] })),
          ),
        ])
      : null,
  ];
}

// ---------- Gateway ----------

function boundVirtualServices(env: DetailsEnv, obj: KubeObject): HTMLElement {
  const gateway = parseIstioGateway(obj);
  const config = env.config();
  const bound = config.virtualServices.filter((vs) => vs.gateways.includes(gateway.key));
  return bound.length === 0
    ? muted(config.loading ? t("loading") : t("gateway.noneBound"))
    : links(bound.map((vs) => meshLink(env.sextant, vs.ref, undefined, gateway.ref.namespace)));
}

function gatewayView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const { blocks } = env;
  const gateway = parseIstioGateway(obj);
  return [
    block(blocks, "gateway", t("blocks.gateway"), () => [fieldsOf([["selector", mapChips(gateway.selector)]]), muted(t("gateway.selectorHint"))]),
    block(blocks, "servers", t("blocks.servers"), () =>
      table(
        env.sextant,
        "servers",
        [t("columns.port"), t("columns.protocol"), t("columns.hosts"), t("columns.tlsMode")],
        gateway.servers.map((s) => ({ cells: [s.port ?? "", s.protocol ?? "", formatList(s.hosts), s.tlsMode ?? ""] })),
      ),
    ),
    block(blocks, "boundVirtualServices", t("blocks.boundVirtualServices"), () => boundVirtualServices(env, obj)),
  ];
}

// ---------- ServiceEntry, Sidecar, WorkloadEntry, Telemetry ----------

function serviceEntryView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const entry = parseServiceEntry(obj);
  return [
    block(env.blocks, "serviceEntry", t("blocks.serviceEntry"), () =>
      fieldsOf([
        ["hosts", ui.chips(entry.hosts)],
        ["location", entry.location ? tOr(`serviceEntry.location.${entry.location}`, entry.location) : null],
        ["resolution", entry.resolution ? tOr(`serviceEntry.resolution.${entry.resolution}`, entry.resolution) : null],
        ["ports", ui.chips(entry.ports.map((p) => [p.number, p.protocol, p.name].filter((x) => x !== undefined).join(" ")))],
        ["addresses", ui.chips(arr(get(obj, "spec", "addresses")).map(String))],
        ["exportTo", exportText(entry.exportTo)],
      ]),
    ),
  ];
}

function sidecarView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const selector = record(get(obj, "spec", "workloadSelector", "labels"));
  const egress = arr(get(obj, "spec", "egress")).flatMap((e) => arr(get(e, "hosts")).map(String));
  return [
    block(env.blocks, "sidecar", t("blocks.sidecar"), () => [
      line(t("sidecar.meaning")),
      fieldsOf([
        ["appliesTo", Object.keys(selector).length > 0 ? mapChips(selector) : t("sidecar.wholeNamespace")],
        ["egressHosts", ui.chips(egress)],
        ["outboundTrafficPolicy", str(get(obj, "spec", "outboundTrafficPolicy", "mode"))],
      ]),
    ]),
  ];
}

function workloadEntryView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  return [
    block(env.blocks, "workloadEntry", t("blocks.workloadEntry"), () => [
      line(t("workloadEntry.meaning")),
      fieldsOf([
        ["address", str(get(obj, "spec", "address"))],
        ["labels", mapChips(get(obj, "spec", "labels"))],
        ["serviceAccount", str(get(obj, "spec", "serviceAccount"))],
        ["network", str(get(obj, "spec", "network"))],
        ["ports", mapChips(get(obj, "spec", "ports"))],
      ]),
    ]),
  ];
}

function telemetryView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const providers = (part: string) => ui.chips(arr(get(obj, "spec", part)).flatMap((x) => arr(get(x, "providers")).map((p) => str(get(p, "name")))));
  return [
    block(env.blocks, "telemetry", t("blocks.telemetry"), () =>
      fieldsOf([
        ["appliesTo", get(obj, "spec", "selector") ? mapChips(get(obj, "spec", "selector", "matchLabels")) : t("sidecar.wholeNamespace")],
        ["tracing", providers("tracing")],
        ["metrics", providers("metrics")],
        ["accessLogging", providers("accessLogging")],
      ]),
    ),
  ];
}

// ---------- Security ----------

function scopeRow(obj: KubeObject): readonly [string, UiContent] {
  const selector = get(obj, "spec", "selector", "matchLabels");
  return ["appliesTo", selector ? mapChips(selector) : obj.metadata.namespace === ROOT_NAMESPACE ? t("scope.mesh") : t("scope.namespace")];
}

function peerAuthenticationView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const pa = parsePeerAuthentication(obj);
  const mode = pa.mode ?? "UNSET";
  return [
    block(env.blocks, "peerAuthentication", t("blocks.peerAuthentication"), () => [
      fieldsOf([scopeRow(obj), ["mtlsMode", mode]]),
      line(t(`mtls.meaning.${mode}`)),
      muted(t("mtls.precedence")),
    ]),
    pa.ports.length > 0
      ? block(env.blocks, "portMtls", t("blocks.portMtls"), () =>
          table(env.sextant, "portMtls", [t("columns.port"), t("columns.mtlsMode")], pa.ports.map((p) => ({ cells: [p.port, p.mode ?? "UNSET"] }))),
        )
      : null,
  ];
}

function requestAuthenticationView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const rules = arr(get(obj, "spec", "jwtRules")).map((r) => ({
    cells: [
      str(get(r, "issuer")) ?? "",
      formatList(arr(get(r, "audiences")).map(String)),
      str(get(r, "jwksUri")) ?? (get(r, "jwks") !== undefined ? t("jwt.inlineKeys") : ""),
    ],
  }));
  return [
    block(env.blocks, "requestAuthentication", t("blocks.requestAuthentication"), () => [
      fieldsOf([scopeRow(obj)]),
      line(t("jwt.meaning")),
      table(env.sextant, "requestAuthentication", [t("columns.issuer"), t("columns.audiences"), t("columns.keys")], rules),
    ]),
  ];
}

function valuesText(l: RuleLine): string {
  const except = l.notValues ?? [];
  if (except.length === 0) return formatList(l.values);
  if (l.values.length === 0) return t("authz.anythingExcept", { except: formatList(except) });
  return t("authz.valuesExcept", { values: formatList(l.values), except: formatList(except) });
}

/** A rule's lines; `from` and `to` entries are alternatives: each one after the first starts with its number. */
export function ruleLinesView(lines: RuleLine[]): HTMLElement {
  const list = el("dl", "sx-fields");
  lines.forEach((l, i) => {
    const first = lines.findIndex((x) => x.part === l.part && x.entry === l.entry) === i;
    if (first && l.entry > 0 && l.part !== "when") list.append(el("dt", "sx-fields__label mesh-rule-alt", t("route.alternative", { n: l.entry + 1 })));
    list.append(
      el("dt", "sx-fields__label", l.field === "condition" ? t("authz.fields.condition", { key: l.key ?? "" }) : t(`authz.fields.${l.field}`)),
      el("dd", "sx-fields__value", valuesText(l)),
    );
  });
  return list;
}

function authorizationPolicyView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const policy = parseAuthorizationPolicy(obj);
  return [
    block(env.blocks, "authorizationPolicy", t("blocks.authorizationPolicy"), () => [
      fieldsOf([["action", policy.action], ["provider", policy.provider], scopeRow(obj)]),
      phraseLines(policyPhrases(policy)),
      muted(t("authz.order")),
    ]),
    // Every rule's block shares one id, as the built-in's did (one open-or-closed choice for all of them).
    ...policy.rules.map((rule, i) =>
      block(env.blocks, "authzRule", t("authz.rule", { n: i + 1 }), () =>
        ruleLines(rule).length === 0 ? line(t("authz.emptyRule")) : ruleLinesView(ruleLines(rule)),
      ),
    ),
  ];
}

// ---------- Linkerd ----------

const refTo = (kind: KindRef, namespace: string, name: string): Ref => ({ kind, namespace, name });

function serviceProfileView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const routes = arr(get(obj, "spec", "routes"));
  const budget = get(obj, "spec", "retryBudget");
  const condition = (c: unknown): string =>
    [str(get(c, "method")), str(get(c, "pathRegex"))].filter(Boolean).join(" ") ||
    (arr(get(c, "all")).length > 0 || arr(get(c, "any")).length > 0 ? t("linkerd.compoundCondition") : "");
  const rows = routes.map((r) => ({
    cells: [str(get(r, "name")) ?? "", condition(get(r, "condition")), get(r, "isRetryable") === true ? t("yes") : t("no"), str(get(r, "timeout")) ?? ""],
  }));
  return [
    block(env.blocks, "serviceProfile", t("blocks.serviceProfile"), () => [
      line(t("linkerd.profileMeaning", { host: obj.metadata.name })),
      budget !== undefined
        ? line(
            t("linkerd.retryBudget", {
              ratio: String(get(budget, "retryRatio") ?? ""),
              min: String(get(budget, "minRetriesPerSecond") ?? ""),
              ttl: str(get(budget, "ttl")) ?? "",
            }),
          )
        : null,
    ]),
    block(env.blocks, "profileRoutes", t("blocks.profileRoutes"), () =>
      table(env.sextant, "profileRoutes", [t("columns.name"), t("columns.condition"), t("columns.retryable"), t("columns.timeout")], rows),
    ),
  ];
}

/** ServerAuthorizations and AuthorizationPolicies of the Server's namespace that target it, watched while open. */
function serverAuthorizations(env: DetailsEnv, server: KubeObject): HTMLElement {
  const ns = server.metadata.namespace ?? "";
  const name = server.metadata.name;
  const labels = record(server.metadata.labels);
  const list = (kind: KindRef) => {
    const served = servedKind(env.discovery.get(), kind);
    return served ? env.lists.get({ kind: { group: served.group, version: served.version, kind: served.kind }, namespaces: [ns] }).items : [];
  };
  const bySa = list(SERVER_AUTHORIZATION).filter((o) => {
    const target = get(o, "spec", "server");
    if (str(get(target, "name"))) return str(get(target, "name")) === name;
    const sel = record(get(target, "selector", "matchLabels"));
    return Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => String(labels[k]) === String(v));
  });
  const byAp = list(LINKERD_AUTHORIZATION_POLICY).filter((o) => {
    const target = get(o, "spec", "targetRef");
    const kind = str(get(target, "kind"));
    return (kind === "Server" && str(get(target, "name")) === name) || kind === "Namespace";
  });
  const refs = [
    ...bySa.map((o) => refTo(SERVER_AUTHORIZATION, ns, o.metadata.name)),
    ...byAp.map((o) => refTo(LINKERD_AUTHORIZATION_POLICY, ns, o.metadata.name)),
  ];
  return refs.length === 0 ? line(t("linkerd.noAuthorizations")) : links(refs.map((r) => meshLink(env.sextant, r, `${r.kind.kind} ${r.name}`)));
}

function serverView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const selector = get(obj, "spec", "podSelector") ?? get(obj, "spec", "externalWorkloadSelector");
  return [
    block(env.blocks, "server", t("blocks.server"), () => [
      fieldsOf([
        ["podSelector", mapChips(get(selector, "matchLabels"))],
        ["port", String(get(obj, "spec", "port") ?? "")],
        ["proxyProtocol", str(get(obj, "spec", "proxyProtocol"))],
        ["accessPolicy", str(get(obj, "spec", "accessPolicy"))],
      ]),
      line(t("linkerd.serverMeaning")),
    ]),
    block(env.blocks, "serverAuthorizations", t("blocks.serverAuthorizations"), () => serverAuthorizations(env, obj)),
  ];
}

function clientLines(client: unknown): string[] {
  const out: string[] = [];
  if (get(client, "unauthenticated") === true) out.push(t("linkerd.client.unauthenticated"));
  const tls = get(client, "meshTLS");
  if (get(tls, "unauthenticatedTLS") === true) out.push(t("linkerd.client.unauthenticatedTls"));
  const ids = arr(get(tls, "identities")).map(String);
  if (ids.length > 0) out.push(t("linkerd.client.identities", { values: formatList(ids) }));
  const sas = arr(get(tls, "serviceAccounts")).map((s) => [str(get(s, "namespace")), str(get(s, "name"))].filter(Boolean).join("/"));
  if (sas.length > 0) out.push(t("linkerd.client.serviceAccounts", { values: formatList(sas) }));
  const nets = arr(get(client, "networks")).map((n) => str(get(n, "cidr")) ?? "");
  if (nets.length > 0) out.push(t("linkerd.client.networks", { values: formatList(nets) }));
  return out;
}

function serverAuthorizationView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const ns = obj.metadata.namespace ?? "";
  const server = str(get(obj, "spec", "server", "name"));
  return [
    block(env.blocks, "serverAuthorization", t("blocks.serverAuthorization"), () => [
      fieldsOf([["server", server ? meshLink(env.sextant, refTo(LINKERD_SERVER, ns, server)) : mapChips(get(obj, "spec", "server", "selector", "matchLabels"))]]),
      line(t("linkerd.allows")),
      clientLines(get(obj, "spec", "client")).map((l) => line(l)),
    ]),
  ];
}

function linkerdAuthorizationPolicyView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const ns = obj.metadata.namespace ?? "";
  const target = get(obj, "spec", "targetRef");
  const kind = str(get(target, "kind")) ?? "";
  const name = str(get(target, "name")) ?? "";
  const targetRef =
    kind === "Server"
      ? meshLink(env.sextant, refTo(LINKERD_SERVER, ns, name))
      : kind === "HTTPRoute"
        ? meshLink(env.sextant, refTo(LINKERD_HTTP_ROUTE, ns, name))
        : `${kind} ${name}`;
  const auth = arr(get(obj, "spec", "requiredAuthenticationRefs")).map((r) => `${str(get(r, "kind")) ?? ""} ${str(get(r, "name")) ?? ""}`);
  return [
    block(env.blocks, "linkerdAuthorizationPolicy", t("blocks.linkerdAuthorizationPolicy"), () => [
      fieldsOf([
        ["target", targetRef],
        ["requiredAuthentications", ui.chips(auth)],
      ]),
      line(auth.length === 0 ? t("linkerd.policyNoAuth") : t("linkerd.policyMeaning")),
    ]),
  ];
}

function meshTlsAuthenticationView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const refs = arr(get(obj, "spec", "identityRefs")).map((r) =>
    [str(get(r, "kind")), [str(get(r, "namespace")), str(get(r, "name"))].filter(Boolean).join("/")].filter(Boolean).join(" "),
  );
  return [
    block(env.blocks, "meshTlsAuthentication", t("blocks.meshTlsAuthentication"), () => [
      line(t("linkerd.meshTlsMeaning")),
      fieldsOf([
        ["identities", ui.chips(arr(get(obj, "spec", "identities")).map(String))],
        ["identityRefs", ui.chips(refs)],
      ]),
    ]),
  ];
}

function networkAuthenticationView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const nets = arr(get(obj, "spec", "networks")).map((n) => {
    const except = arr(get(n, "except")).map(String);
    const cidr = str(get(n, "cidr")) ?? "";
    return except.length > 0 ? t("linkerd.networkExcept", { cidr, except: formatList(except) }) : cidr;
  });
  return [
    block(env.blocks, "networkAuthentication", t("blocks.networkAuthentication"), () => [line(t("linkerd.networkMeaning")), fieldsOf([["networks", ui.chips(nets)]])]),
  ];
}

function linkerdHttpRouteView(env: DetailsEnv, obj: KubeObject): UiContent[] {
  const ns = obj.metadata.namespace ?? "";
  const parents = arr(get(obj, "spec", "parentRefs")).map((p) => {
    const kind = str(get(p, "kind")) ?? "";
    const name = str(get(p, "name")) ?? "";
    return kind === "Server" ? meshLink(env.sextant, refTo(LINKERD_SERVER, str(get(p, "namespace")) ?? ns, name)) : `${kind} ${name}`;
  });
  const rows = arr(get(obj, "spec", "rules")).map((r) => ({
    cells: [
      formatList(arr(get(r, "matches")).map((m) => [str(get(m, "method")), str(get(m, "path", "value"))].filter(Boolean).join(" "))) || t("route.everyRequest"),
      formatList(arr(get(r, "backendRefs")).map((b) => [str(get(b, "name")), get(b, "port")].filter((x) => x !== undefined).join(":"))),
    ],
  }));
  return [
    block(env.blocks, "linkerdHttpRoute", t("blocks.linkerdHttpRoute"), () =>
      fieldsOf([
        ["parents", ui.inline(parents)],
        ["hostnames", ui.chips(arr(get(obj, "spec", "hostnames")).map(String))],
      ]),
    ),
    block(env.blocks, "httpRoutes", t("blocks.httpRoutes"), () => table(env.sextant, "httpRoutes", [t("columns.match"), t("columns.destinations")], rows)),
  ];
}

// ---------- the section ----------

/** The section of `obj` (of `kind`) as it is drawn now. */
export function meshView(env: DetailsEnv, kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): UiContent[] {
  const def = meshKind(kind);
  if (!def) return [];
  if (def.section === "istio") {
    switch (def.kind.kind) {
      case "VirtualService":
        return virtualServiceView(env, parseVirtualService(obj));
      case "DestinationRule":
        return destinationRuleView(env, obj);
      case "Gateway":
        return gatewayView(env, obj);
      case "ServiceEntry":
        return serviceEntryView(env, obj);
      case "Sidecar":
        return sidecarView(env, obj);
      case "WorkloadEntry":
        return workloadEntryView(env, obj);
      case "Telemetry":
        return telemetryView(env, obj);
      case "PeerAuthentication":
        return peerAuthenticationView(env, obj);
      case "RequestAuthentication":
        return requestAuthenticationView(env, obj);
      case "AuthorizationPolicy":
        return authorizationPolicyView(env, obj);
      default:
        return [];
    }
  }
  if (def.kind.group === LINKERD) return serviceProfileView(env, obj);
  switch (def.kind.kind) {
    case "Server":
      return serverView(env, obj);
    case "ServerAuthorization":
      return serverAuthorizationView(env, obj);
    case "AuthorizationPolicy":
      return linkerdAuthorizationPolicyView(env, obj);
    case "MeshTLSAuthentication":
      return meshTlsAuthenticationView(env, obj);
    case "NetworkAuthentication":
      return networkAuthenticationView(env, obj);
    case "HTTPRoute":
      return linkerdHttpRouteView(env, obj);
    default:
      return [];
  }
}

const nodesOf = (content: readonly UiContent[]): Node[] => {
  const out: Node[] = [];
  const add = (c: UiContent) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else out.push(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : (c as Node));
  };
  content.forEach(add);
  return out;
};

/**
 * Follows the shown object: `onObject` with it, now and whenever its resourceVersion changes; `onError` when it cannot
 * be read. Returns the function that stops following it.
 */
export function followShown(sextant: Sextant, onObject: (ref: ObjectRef, obj: KubeObject) => void, onError: (err: unknown) => void, onNone: () => void): () => void {
  let shown: string | null = null;
  let version: string | null | undefined;
  let reading = 0;
  let stopped = false;
  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const obj = await sextant.resources.get({ ref });
      if (!stopped && attempt === reading) onObject(ref, obj);
    } catch (err) {
      if (!stopped && attempt === reading) onError(err);
    }
  };
  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      shown = null;
      onNone();
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shown) {
      shown = key;
      version = undefined;
    }
    if (sextant.context.resourceVersion === version) return;
    version = sextant.context.resourceVersion;
    void read(ref);
  };
  follow();
  const off = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    off();
  };
}

/** Starts the details section `mesh` on the object in the context. */
export function startDetails(sextant: Sextant, root: HTMLElement): () => void {
  let object: { ref: ObjectRef; obj: KubeObject } | null = null;
  let stopped = false;
  const schedule = batched(() => render());
  const memory = new BlockMemory(sextant, schedule);
  const lists = new Lists(sextant, schedule);
  const discovery = new Discovery(sextant, schedule);
  let config: MeshConfig | undefined;
  const env: DetailsEnv = {
    sextant,
    blocks: memory,
    lists,
    discovery,
    config: () => (config ??= meshConfig(lists, discovery.get())),
  };
  function render(): void {
    if (stopped || !object) return;
    lists.begin();
    config = undefined;
    const nodes = nodesOf(meshView(env, object.ref.kind, object.obj));
    lists.end();
    redraw(root, nodes);
  }
  const stopFollowing = followShown(
    sextant,
    (ref, obj) => {
      const same = object && object.ref.kind.kind === ref.kind.kind && object.ref.namespace === ref.namespace && object.ref.name === ref.name;
      if (!same) memory.reset();
      object = { ref, obj };
      render();
    },
    (err) => {
      object = null;
      lists.stop();
      root.replaceChildren(ui.errorState(errorText(err)));
    },
    () => {
      object = null;
      lists.stop();
      root.replaceChildren();
    },
  );
  const offBlocks = sextant.onContextChange(() => {
    const kindsMoved = discovery.follow();
    if (memory.follow() || kindsMoved) schedule();
  });
  return () => {
    stopped = true;
    stopFollowing();
    offBlocks();
    lists.stop();
  };
}
