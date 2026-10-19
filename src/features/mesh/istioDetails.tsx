// Details of Istio objects (#155), in plain words: a VirtualService's routes as "when … then …" lines with weights,
// retries, timeouts and faults; a DestinationRule's subsets and TLS mode; a Gateway's servers and the
// VirtualServices bound to it; ServiceEntries, Sidecars and WorkloadEntries; PeerAuthentication, RequestAuthentication
// and AuthorizationPolicy with what they mean for the workloads they select. Conditions and YAML are the panel's own.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Button } from "../../components";
import { formatList } from "../../i18n";
import { status } from "../../resources";
import { Block, chips, Fields, mapChips, type FieldRow } from "../details";
import { SimpleTable } from "../gateway-api/details";
import { parseAuthorizationPolicy } from "./authz";
import { openMeshCheck } from "./checkState";
import {
  parseDestinationRule,
  parseIstioGateway,
  parseServiceEntry,
  parseVirtualService,
  ROOT_NAMESPACE,
  type HttpRoute,
  type L4Route,
  type VirtualService,
} from "./istio";
import { parsePeerAuthentication } from "./mtls";
import { destinationText, matchPhrases, policyPhrases, routeAction, routeExtras, ruleLines, type RuleLine } from "./phrases";
import { weightsOf } from "./routing";
import { useMeshConfig } from "./store";
import { meshLink, ObjectProblems, PhraseLines, phraseText, type T } from "./ui";

const { arr, get, record, str } = status;

const FIELDS = "mesh:fields";

const exportText = (exportTo: string[], t: T) => (exportTo.length === 0 ? t("mesh:exportTo.everywhere") : formatList(exportTo));

// ---------- VirtualService ----------

function RouteCard({ route, t }: { route: HttpRoute; t: T }) {
  const title = route.name ? t("mesh:route.titleNamed", { n: route.index + 1, name: route.name }) : t("mesh:route.title", { n: route.index + 1 });
  const action = routeAction(route);
  const weights = weightsOf(route.destinations);
  return (
    <div className="mesh-route" data-route={route.index}>
      <h4 className="mesh-route__title">{title}</h4>
      <div className="mesh-route__part">
        <span className="mesh-route__label">{t("mesh:route.when")}</span>
        {route.matches.length === 0 ? (
          <p className="mesh-line">{t("mesh:route.everyRequest")}</p>
        ) : (
          route.matches.map((m, i) => (
            <div key={i} className="mesh-route__match">
              {route.matches.length > 1 && <span className="dt-muted">{t("mesh:route.alternative", { n: i + 1 })}</span>}
              <PhraseLines phrases={matchPhrases(m)} />
            </div>
          ))
        )}
      </div>
      <div className="mesh-route__part">
        <span className="mesh-route__label">{t("mesh:route.then")}</span>
        {action ? (
          <p className="mesh-line">{phraseText(action, t)}</p>
        ) : (
          route.destinations.map((d, i) => (
            <p key={i} className="mesh-line">
              {d.subset
                ? t("mesh:route.toSubset", { host: destinationText(d), subset: d.subset, percent: weights[i] ?? 0 })
                : t("mesh:route.to", { host: destinationText(d), percent: weights[i] ?? 0 })}
            </p>
          ))
        )}
        <PhraseLines phrases={routeExtras(route)} />
      </div>
    </div>
  );
}

function L4Table({ routes, t }: { routes: L4Route[]; t: T }) {
  return (
    <SimpleTable
      headers={[t("mesh:l4.kind"), t("mesh:l4.match"), t("mesh:l4.destinations")]}
      rows={routes.map((r) => ({
        key: `${r.kind}${r.index}`,
        cells: [
          r.kind.toUpperCase(),
          formatList([...r.ports.map(String), ...r.sniHosts]) || t("mesh:route.everyConnection"),
          formatList(r.destinations.map((d, i) => `${destinationText(d)}${d.subset ? ` (${d.subset})` : ""} ${weightsOf(r.destinations)[i] ?? 0}%`)),
        ],
      }))}
    />
  );
}

function VirtualServiceDetails({ clusterId, vs }: { clusterId: ClusterId; vs: VirtualService }) {
  const { t } = useTranslation();
  const rows: FieldRow[] = [
    ["hosts", vs.delegate ? t("mesh:vs.delegate") : chips(vs.hosts)],
    ["gateways", chips(vs.gateways.map((g) => (g === "mesh" ? t("mesh:vs.meshGateway") : g)))],
    ["exportTo", exportText(vs.exportTo, t)],
  ];
  const firstHost = vs.hosts.find((h) => !h.startsWith("*")) ?? vs.hosts[0]?.replace(/^\*\./, "www.");
  const gateway = vs.gateways.find((g) => g !== "mesh");
  const check = () =>
    openMeshCheck(clusterId, {
      url: firstHost ? `http://${firstHost}/` : "",
      from: vs.gateways.includes("mesh") || !gateway ? "mesh" : "gateway",
      namespace: vs.namespace,
      gateway: gateway ?? "",
    });
  return (
    <>
      <ObjectProblems clusterId={clusterId} obj={vs.obj} />
      <Block
        title={t("mesh:blocks.virtualService")}
        actions={
          !vs.delegate && vs.http.length > 0 ? (
            <Button size="compact" icon="requestCheck" onClick={check}>
              {t("mesh:check.open")}
            </Button>
          ) : undefined
        }
      >
        <Fields rows={rows} labelPrefix={FIELDS} />
      </Block>
      {vs.http.length > 0 && (
        <Block title={t("mesh:blocks.httpRoutes")}>
          <p className="dt-muted">{t("mesh:route.order")}</p>
          {vs.http.map((r) => (
            <RouteCard key={r.index} route={r} t={t} />
          ))}
        </Block>
      )}
      {vs.l4.length > 0 && (
        <Block title={t("mesh:blocks.l4Routes")}>
          <L4Table routes={vs.l4} t={t} />
        </Block>
      )}
    </>
  );
}

// ---------- DestinationRule ----------

function DestinationRuleDetails({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const rule = parseDestinationRule(obj);
  const rows: FieldRow[] = [
    ["host", rule.host],
    ["tlsMode", rule.tlsMode ? t(`mesh:tls.mode.${rule.tlsMode}`, { defaultValue: rule.tlsMode }) : t("mesh:tls.auto")],
    ["loadBalancer", rule.loadBalancer],
    ["exportTo", exportText(rule.exportTo, t)],
    ["workloadSelector", rule.hasWorkloadSelector ? mapChips(get(obj, "spec", "workloadSelector", "matchLabels")) : null],
  ];
  return (
    <>
      <ObjectProblems clusterId={clusterId} obj={obj} />
      <Block title={t("mesh:blocks.destinationRule")}>
        <Fields rows={rows} labelPrefix={FIELDS} />
      </Block>
      {rule.portTls.length > 0 && (
        <Block title={t("mesh:blocks.portTls")}>
          <SimpleTable
            headers={[t("mesh:columns.port"), t("mesh:columns.tlsMode")]}
            rows={rule.portTls.map((p) => ({ key: `${p.port}`, cells: [p.port, p.mode] }))}
          />
        </Block>
      )}
      {rule.subsets.length > 0 && (
        <Block title={t("mesh:blocks.subsets")}>
          <p className="dt-muted">{t("mesh:dr.subsetsHint")}</p>
          <SimpleTable
            headers={[t("mesh:columns.name"), t("mesh:columns.labels"), t("mesh:columns.tlsMode")]}
            rows={rule.subsets.map((s) => ({
              key: s.name,
              cells: [s.name, mapChips(s.labels), s.tlsMode ?? ""],
            }))}
          />
        </Block>
      )}
    </>
  );
}

// ---------- Gateway ----------

function GatewayDetails({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const gateway = parseIstioGateway(obj);
  const config = useMeshConfig(clusterId);
  const bound = config.virtualServices.filter((vs) => vs.gateways.includes(gateway.key));
  const rows: FieldRow[] = [["selector", mapChips(gateway.selector)]];
  return (
    <>
      <Block title={t("mesh:blocks.gateway")}>
        <Fields rows={rows} labelPrefix={FIELDS} />
        <p className="dt-muted">{t("mesh:gateway.selectorHint")}</p>
      </Block>
      <Block title={t("mesh:blocks.servers")}>
        <SimpleTable
          headers={[t("mesh:columns.port"), t("mesh:columns.protocol"), t("mesh:columns.hosts"), t("mesh:columns.tlsMode")]}
          rows={gateway.servers.map((s, i) => ({
            key: `${i}`,
            cells: [s.port ?? "", s.protocol ?? "", formatList(s.hosts), s.tlsMode ?? ""],
          }))}
        />
      </Block>
      <Block title={t("mesh:blocks.boundVirtualServices")}>
        {bound.length === 0 ? (
          <p className="dt-muted">{config.loading ? t("mesh:loading") : t("mesh:gateway.noneBound")}</p>
        ) : (
          <span className="dt-links">{bound.map((vs) => meshLink(vs.ref, undefined, gateway.ref.namespace))}</span>
        )}
      </Block>
    </>
  );
}

// ---------- ServiceEntry, Sidecar, WorkloadEntry, Telemetry ----------

function ServiceEntryDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const entry = parseServiceEntry(obj);
  const rows: FieldRow[] = [
    ["hosts", chips(entry.hosts)],
    ["location", entry.location ? t(`mesh:serviceEntry.location.${entry.location}`, { defaultValue: entry.location }) : null],
    ["resolution", entry.resolution ? t(`mesh:serviceEntry.resolution.${entry.resolution}`, { defaultValue: entry.resolution }) : null],
    ["ports", chips(entry.ports.map((p) => [p.number, p.protocol, p.name].filter((x) => x !== undefined).join(" ")))],
    ["addresses", chips(arr(get(obj, "spec", "addresses")).map(String))],
    ["exportTo", exportText(entry.exportTo, t)],
  ];
  return (
    <Block title={t("mesh:blocks.serviceEntry")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function SidecarDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const selector = record(get(obj, "spec", "workloadSelector", "labels"));
  const egress = arr(get(obj, "spec", "egress")).flatMap((e) => arr(get(e, "hosts")).map(String));
  const rows: FieldRow[] = [
    ["appliesTo", Object.keys(selector).length > 0 ? mapChips(selector) : t("mesh:sidecar.wholeNamespace")],
    ["egressHosts", chips(egress)],
    ["outboundTrafficPolicy", str(get(obj, "spec", "outboundTrafficPolicy", "mode"))],
  ];
  return (
    <Block title={t("mesh:blocks.sidecar")}>
      <p className="mesh-line">{t("mesh:sidecar.meaning")}</p>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function WorkloadEntryDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const rows: FieldRow[] = [
    ["address", str(get(obj, "spec", "address"))],
    ["labels", mapChips(get(obj, "spec", "labels"))],
    ["serviceAccount", str(get(obj, "spec", "serviceAccount"))],
    ["network", str(get(obj, "spec", "network"))],
    ["ports", mapChips(get(obj, "spec", "ports"))],
  ];
  return (
    <Block title={t("mesh:blocks.workloadEntry")}>
      <p className="mesh-line">{t("mesh:workloadEntry.meaning")}</p>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

function TelemetryDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const providers = (part: string) =>
    chips(arr(get(obj, "spec", part)).flatMap((x) => arr(get(x, "providers")).map((p) => str(get(p, "name")))));
  const rows: FieldRow[] = [
    ["appliesTo", get(obj, "spec", "selector") ? mapChips(get(obj, "spec", "selector", "matchLabels")) : t("mesh:sidecar.wholeNamespace")],
    ["tracing", providers("tracing")],
    ["metrics", providers("metrics")],
    ["accessLogging", providers("accessLogging")],
  ];
  return (
    <Block title={t("mesh:blocks.telemetry")}>
      <Fields rows={rows} labelPrefix={FIELDS} />
    </Block>
  );
}

// ---------- Security ----------

function scopeRow(obj: KubeObject, t: T): FieldRow {
  const selector = get(obj, "spec", "selector", "matchLabels");
  return ["appliesTo", selector ? mapChips(selector) : obj.metadata?.namespace === ROOT_NAMESPACE ? t("mesh:scope.mesh") : t("mesh:scope.namespace")];
}

function PeerAuthenticationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const pa = parsePeerAuthentication(obj);
  const mode = pa.mode ?? "UNSET";
  const rows: FieldRow[] = [scopeRow(obj, t), ["mtlsMode", mode]];
  const ports = pa.ports.map((p) => ({ key: `${p.port}`, cells: [p.port, p.mode ?? "UNSET"] }));
  return (
    <>
      <Block title={t("mesh:blocks.peerAuthentication")}>
        <Fields rows={rows} labelPrefix={FIELDS} />
        <p className="mesh-line">{t(`mesh:mtls.meaning.${mode}`)}</p>
        <p className="dt-muted">{t("mesh:mtls.precedence")}</p>
      </Block>
      {pa.ports.length > 0 && (
        <Block title={t("mesh:blocks.portMtls")}>
          <SimpleTable
            headers={[t("mesh:columns.port"), t("mesh:columns.mtlsMode")]}
            rows={ports}
          />
        </Block>
      )}
    </>
  );
}

function RequestAuthenticationDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const rules = arr(get(obj, "spec", "jwtRules")).map((r, i) => ({
    key: `${i}`,
    cells: [
      str(get(r, "issuer")) ?? "",
      formatList(arr(get(r, "audiences")).map(String)),
      str(get(r, "jwksUri")) ?? (get(r, "jwks") !== undefined ? t("mesh:jwt.inlineKeys") : ""),
    ],
  }));
  return (
    <Block title={t("mesh:blocks.requestAuthentication")}>
      <Fields rows={[scopeRow(obj, t)]} labelPrefix={FIELDS} />
      <p className="mesh-line">{t("mesh:jwt.meaning")}</p>
      <SimpleTable
        headers={[t("mesh:columns.issuer"), t("mesh:columns.audiences"), t("mesh:columns.keys")]}
        rows={rules}
      />
    </Block>
  );
}

function valuesText(l: RuleLine, t: T): string {
  const except = l.notValues ?? [];
  if (except.length === 0) return formatList(l.values);
  if (l.values.length === 0) return t("mesh:authz.anythingExcept", { except: formatList(except) });
  return t("mesh:authz.valuesExcept", { values: formatList(l.values), except: formatList(except) });
}

export function RuleLinesView({ lines, t }: { lines: RuleLine[]; t: T }) {
  return (
    <dl className="dt-fields">
      {lines.map((l, i) => {
        // `from` and `to` entries are alternatives: each one after the first starts with its number.
        const first = lines.findIndex((x) => x.part === l.part && x.entry === l.entry) === i;
        return (
          <div key={i} className="mesh-rule-line">
            {first && l.entry > 0 && l.part !== "when" && (
              <dt className="dt-fields__label mesh-rule-alt">{t("mesh:route.alternative", { n: l.entry + 1 })}</dt>
            )}
            <dt className="dt-fields__label">
              {l.field === "condition" ? t("mesh:authz.fields.condition", { key: l.key ?? "" }) : t(`mesh:authz.fields.${l.field}`)}
            </dt>
            <dd className="dt-fields__value">{valuesText(l, t)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function AuthorizationPolicyDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const policy = parseAuthorizationPolicy(obj);
  const rows: FieldRow[] = [["action", policy.action], ["provider", policy.provider], scopeRow(obj, t)];
  return (
    <>
      <Block title={t("mesh:blocks.authorizationPolicy")}>
        <Fields rows={rows} labelPrefix={FIELDS} />
        <PhraseLines phrases={policyPhrases(policy)} />
        <p className="dt-muted">{t("mesh:authz.order")}</p>
      </Block>
      {policy.rules.map((rule, i) => (
        <Block key={i} title={t("mesh:authz.rule", { n: i + 1 })}>
          {ruleLines(rule).length === 0 ? <p className="mesh-line">{t("mesh:authz.emptyRule")}</p> : <RuleLinesView lines={ruleLines(rule)} t={t} />}
        </Block>
      ))}
    </>
  );
}

export function IstioDetails({ clusterId, obj, kind }: { clusterId: ClusterId; obj: KubeObject; kind: string }) {
  switch (kind) {
    case "VirtualService":
      return <VirtualServiceDetails clusterId={clusterId} vs={parseVirtualService(obj)} />;
    case "DestinationRule":
      return <DestinationRuleDetails clusterId={clusterId} obj={obj} />;
    case "Gateway":
      return <GatewayDetails clusterId={clusterId} obj={obj} />;
    case "ServiceEntry":
      return <ServiceEntryDetails obj={obj} />;
    case "Sidecar":
      return <SidecarDetails obj={obj} />;
    case "WorkloadEntry":
      return <WorkloadEntryDetails obj={obj} />;
    case "Telemetry":
      return <TelemetryDetails obj={obj} />;
    case "PeerAuthentication":
      return <PeerAuthenticationDetails obj={obj} />;
    case "RequestAuthentication":
      return <RequestAuthenticationDetails obj={obj} />;
    case "AuthorizationPolicy":
      return <AuthorizationPolicyDetails obj={obj} />;
    default:
      return null;
  }
}


