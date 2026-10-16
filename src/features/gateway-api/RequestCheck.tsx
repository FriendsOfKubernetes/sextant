// The "Request check" page of the Gateway API section — "Where does this request go?" (#128, item 7): method, URL
// and headers → the Gateway listener, route, rule, filters and backends that would serve the request under the
// Gateway API matching rules (`explainRequest`), or what the Gateway answers itself (redirect, 404, 500), and every
// candidate that lost with its reason; a second tab maps hostnames to listeners, routes and backends with conflicting
// routes marked (`HostnameMap.tsx`). Each named object opens its details. Gateways, routes, Services, EndpointSlices
// and ReferenceGrants are watched only while the page is open (`useCheckData`); the form of each cluster is kept
// while the app runs (`checkState.ts`).
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { Button, Checkbox, EmptyState, Icon, Tabs } from "../../components";
import { registerPage, type PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { useCheckData, type CheckData } from "./checkData";
import { CopyGrantButton, gatewayRef, LIST_SEPARATOR, LoadingLine, MATCH_SEPARATOR, phrasesText, refLink, useGrantApiVersion } from "./details";
import { HostnameMap } from "./HostnameMap";
import {
  explainRequest,
  hostnameMap,
  parseRequest,
  type BackendOutcome,
  type Candidate,
  type HostnameRow,
  type NamespacedName,
  type RequestExplanation,
  type RequestInput,
  type RouteId,
} from "./matching";
import { backendText, explainReason, GATEWAY, GATEWAY_GROUP, referenceGrantFor, type ObjRef } from "./model";
import {
  EMPTY_FORM,
  HTTP_METHODS,
  parseHeaderLines,
  PRECEDENCE_CRITERIA,
  REQUEST_CHECK_PAGE,
  routePrefill,
  rowPrefill,
  useClusterCheck,
  useRequestCheckStore,
  type CheckTab,
  type RequestForm,
} from "./checkState";

type T = (key: string, options?: Record<string, unknown>) => string;

const fullName = (n: NamespacedName) => (n.namespace ? `${n.namespace}/${n.name}` : n.name);

const sameName = (a: NamespacedName | undefined, b: NamespacedName | undefined) =>
  !!a && !!b && a.namespace === b.namespace && a.name === b.name;

const routeRef = (r: RouteId): ObjRef => ({ group: GATEWAY_GROUP, kind: r.kind, name: r.name, namespace: r.namespace });

const gatewayLink = (g: NamespacedName) => refLink(gatewayRef(g.name, g.namespace), fullName(g));

const routeLink = (r: RouteId) => refLink(routeRef(r), fullName(r));

/** The engine's input for a form, and the header lines it could not read. */
export function requestInputOf(form: RequestForm): { input: RequestInput; badLines: number[] } {
  const { headers, badLines } = parseHeaderLines(form.headers);
  return {
    input: { method: form.grpc ? "POST" : form.method, url: form.url, headers, protocol: form.grpc ? "grpc" : "http" },
    badLines,
  };
}

// ---------- The form ----------

function RequestFormView({
  form,
  urlError,
  badLines,
  onChange,
  onSubmit,
}: {
  form: RequestForm;
  urlError: boolean;
  badLines: number[];
  onChange: (patch: Partial<RequestForm>) => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="gw-check__form" onSubmit={submit} noValidate>
      <div className="gw-check__line">
        <label className="gw-check__field">
          <span className="gw-check__label">{t("gateway:check.form.method")}</span>
          <select
            value={form.grpc ? "POST" : form.method}
            disabled={form.grpc}
            onChange={(e) => onChange({ method: e.target.value })}
          >
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="gw-check__toggle">
          <Checkbox checked={form.grpc} onChange={(e) => onChange({ grpc: e.target.checked })} />
          {t("gateway:check.form.grpc")}
        </label>
        <label className="gw-check__field gw-check__field--grow">
          <span className="gw-check__label">{t("gateway:check.form.url")}</span>
          <input
            type="text"
            className="gw-check__url"
            value={form.url}
            spellCheck={false}
            autoComplete="off"
            placeholder={t(form.grpc ? "gateway:check.form.grpcPlaceholder" : "gateway:check.form.urlPlaceholder")}
            aria-invalid={urlError || undefined}
            aria-describedby={urlError ? "gw-check-url-error" : undefined}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" icon="requestCheck">
          {t("gateway:check.form.check")}
        </Button>
      </div>
      {urlError && (
        <p id="gw-check-url-error" className="gw-check__error" role="alert">
          {t("gateway:check.form.invalidUrl")}
        </p>
      )}
      <label className="gw-check__field">
        <span className="gw-check__label">{t("gateway:check.form.headers")}</span>
        <textarea
          className="gw-check__headers"
          rows={3}
          value={form.headers}
          spellCheck={false}
          placeholder={t("gateway:check.form.headersPlaceholder")}
          aria-invalid={badLines.length > 0 || undefined}
          onChange={(e) => onChange({ headers: e.target.value })}
        />
      </label>
      {badLines.length > 0 && (
        <p className="gw-check__error" role="alert">
          {t("gateway:check.form.badHeaders", { count: badLines.length, lines: badLines.join(LIST_SEPARATOR) })}
        </p>
      )}
    </form>
  );
}

// ---------- The result ----------

type StepTone = "ok" | "warning" | "problem";

function Step({ id, label, tone = "ok", children }: { id: string; label: string; tone?: StepTone; children: ReactNode }) {
  return (
    <li className={`gw-step gw-step--${tone}`} data-step={id}>
      <div className="gw-step__label">{label}</div>
      <div className="gw-step__body">{children}</div>
    </li>
  );
}

const Why = ({ children }: { children: ReactNode }) => <p className="gw-step__why dt-muted">{children}</p>;

/** What the Gateway answers: the gRPC status of a gRPC call it answers itself, else the outcome (with its HTTP status). */
function outcomeText(result: RequestExplanation, t: T): string {
  return result.grpcStatus
    ? t(`gateway:check.grpcStatus.${result.grpcStatus}`)
    : t(`gateway:check.outcome.${result.outcome}`, { status: result.status ?? "" });
}

function ruleLabel(t: T, index: number, name?: string): string {
  return name ? t("gateway:check.ruleNamed", { n: index + 1, name }) : t("gateway:check.rule", { n: index + 1 });
}

/** The criteria the chosen rule won on, against the other matching rules on its listener. */
function wonOn(result: RequestExplanation): { count: number; criteria: string[] } {
  const losers = result.candidates.filter(
    (c) => c.reason === "lowerPrecedence" && sameName(c.gateway, result.gateway) && c.listener === result.listener?.name,
  );
  const used = new Set(losers.map((c) => c.lostOn));
  return { count: losers.length, criteria: PRECEDENCE_CRITERIA.filter((c) => used.has(c)) };
}

function GatewayStep({ result }: { result: RequestExplanation }) {
  const { t } = useTranslation();
  const { gateway, listener, request } = result;
  if (!gateway || !listener || !request) {
    return (
      <Step id="gateway" label={t("gateway:check.steps.gateway")} tone="problem">
        <StatusText value={t("gateway:check.outcome.noListener")} tone="danger" />
        <Why>{t("gateway:check.why.noListener")}</Why>
      </Step>
    );
  }
  const params = { port: listener.port ?? "", protocol: listener.protocol, hostname: listener.hostname, host: request.host };
  const lessSpecific = result.candidates
    .filter((c) => c.level === "listener" && c.reason === "lessSpecificListener" && sameName(c.gateway, gateway))
    .map((c) => c.listener);
  return (
    <Step id="gateway" label={t("gateway:check.steps.gateway")} tone={listener.health === "pending" ? "warning" : "ok"}>
      <div className="gw-step__main">
        {gatewayLink(gateway)}
        <span className="dt-muted">
          {MATCH_SEPARATOR}
          {t("gateway:check.listener", { name: listener.name, port: listener.port ?? "", protocol: listener.protocol })}
          {listener.hostname ? `${MATCH_SEPARATOR}${listener.hostname}` : ""}
        </span>
      </div>
      <Why>
        {listener.hostname ? t("gateway:check.why.listenerHostname", params) : t("gateway:check.why.listenerAnyHost", params)}
        {lessSpecific.length > 0 && ` ${t("gateway:check.why.moreSpecific", { listeners: lessSpecific.join(LIST_SEPARATOR) })}`}
      </Why>
    </Step>
  );
}

function RouteStep({ result }: { result: RequestExplanation }) {
  const { t } = useTranslation();
  const { route, rule, request } = result;
  if (result.outcome === "noRoute") {
    return (
      <Step id="route" label={t("gateway:check.steps.route")} tone="problem">
        <StatusText value={outcomeText(result, t)} tone="danger" />
        <Why>
          {t(result.grpcStatus ? "gateway:check.why.noRouteGrpc" : "gateway:check.why.noRoute", {
            listener: result.listener?.name ?? "",
          })}
        </Why>
      </Step>
    );
  }
  if (!route || !rule || !request) return null;
  const won = wonOn(result);
  return (
    <Step id="route" label={t("gateway:check.steps.route")}>
      <div className="gw-step__main">
        <span className="dt-muted">{`${route.kind} `}</span>
        {routeLink(route)}
        <span className="dt-muted">
          {MATCH_SEPARATOR}
          {ruleLabel(t, rule.index, rule.name)}
        </span>
      </div>
      <div className="gw-step__match">{phrasesText(rule.phrases, t, MATCH_SEPARATOR)}</div>
      <Why>
        {route.hostname
          ? t("gateway:check.why.routeHostname", { hostname: route.hostname, host: request.host })
          : t("gateway:check.why.routeAnyHost")}{" "}
        {won.count > 0
          ? t("gateway:check.why.won", {
              count: won.count,
              criteria: won.criteria.map((c) => t(`gateway:check.criteria.${c}`)).join(LIST_SEPARATOR),
            })
          : t("gateway:check.why.only")}
      </Why>
    </Step>
  );
}

function FiltersStep({ result }: { result: RequestExplanation }) {
  const { t } = useTranslation();
  const ns = result.route?.namespace ?? null;
  return (
    <Step id="filters" label={t("gateway:check.steps.filters")}>
      {result.filters.length > 0 ? (
        <ul className="gw-step__list">
          {result.filters.map((f, i) => (
            <li key={i}>{phrasesText(f.phrases, t, LIST_SEPARATOR)}</li>
          ))}
        </ul>
      ) : (
        <span className="dt-muted">{t("gateway:check.noFilters")}</span>
      )}
      {result.rewrite && (
        <Why>
          {t("gateway:check.rewrite", {
            host: result.rewrite.hostname ?? result.request?.host ?? "",
            path: result.rewrite.path ?? result.request?.path ?? "",
          })}
        </Why>
      )}
      {result.mirrors.length > 0 && (
        <Why>{t("gateway:check.mirrors", { backends: result.mirrors.map((b) => backendText(b, ns)).join(LIST_SEPARATOR) })}</Why>
      )}
    </Step>
  );
}

function BackendLine({ backend, routeNamespace, several }: { backend: BackendOutcome; routeNamespace: string | null; several: boolean }) {
  const { t } = useTranslation();
  const text = backendText(backend, routeNamespace);
  const service = backend.group === "" && backend.kind === "Service";
  let state: ReactNode = null;
  if (backend.issue) {
    const value = t(`gateway:check.issues.${backend.issue}`, { namespace: backend.namespace ?? "", defaultValue: backend.issue });
    const explained = explainReason(backend.issue);
    state = (
      <span title={explained ? t(explained) : undefined}>
        <StatusText value={value} tone="danger" />
      </span>
    );
  } else if (backend.total !== undefined && backend.ready !== undefined) {
    const value =
      backend.total > 0 ? t("gateway:check.podsReady", { ready: backend.ready, total: backend.total }) : t("gateway:check.noEndpoints");
    state = <StatusText value={value} tone={backend.total > 0 && backend.ready === backend.total ? "success" : "danger"} />;
  }
  return (
    <li className={backend.issue ? "gw-step__backend gw-step__backend--broken" : "gw-step__backend"} data-backend={backend.name}>
      {service ? refLink(backend, text) : text}
      {several && <span className="gw-step__share">{t("gateway:check.share", { percent: backend.percent })}</span>}
      {state}
    </li>
  );
}

function BackendsStep({ clusterId, result }: { clusterId: ClusterId; result: RequestExplanation }) {
  const { t } = useTranslation();
  const grantVersion = useGrantApiVersion(clusterId);
  const route = result.route;
  const ns = route?.namespace ?? null;
  const several = result.backends.length > 1;
  const notPermitted = result.backends.filter((b) => b.issue === "RefNotPermitted" && b.namespace);
  return (
    <Step id="backends" label={t("gateway:check.steps.backends")} tone={result.outcome === "noBackend" ? "problem" : result.notes.includes("partialBackends") ? "warning" : "ok"}>
      {result.backends.length > 0 ? (
        <ul className="gw-step__list">
          {result.backends.map((b, i) => (
            <BackendLine key={i} backend={b} routeNamespace={ns} several={several} />
          ))}
        </ul>
      ) : (
        <span className="dt-muted">{t("gateway:check.why.noBackends")}</span>
      )}
      {route &&
        ns &&
        notPermitted.map((b) => (
          <CopyGrantButton
            key={`${b.namespace ?? ""}/${b.name}`}
            target={`${b.kind} ${b.namespace ?? ""}/${b.name}`}
            grant={referenceGrantFor(
              { group: GATEWAY_GROUP, kind: route.kind, namespace: ns },
              { group: b.group, kind: b.kind, namespace: b.namespace ?? ns, name: b.name },
              grantVersion,
            )}
          />
        ))}
    </Step>
  );
}

function AnswerStep({ result }: { result: RequestExplanation }) {
  const { t } = useTranslation();
  if (result.outcome === "redirected" && result.redirect) {
    return (
      <Step id="answer" label={t("gateway:check.steps.answer")} tone="warning">
        <StatusText value={t("gateway:check.outcome.redirected", { status: result.redirect.statusCode })} tone="warning" />
        <div className="gw-step__match">{result.redirect.location}</div>
        <Why>{t("gateway:check.why.redirect", { status: result.redirect.statusCode, location: result.redirect.location })}</Why>
      </Step>
    );
  }
  if (result.outcome === "noBackend") {
    return (
      <Step id="answer" label={t("gateway:check.steps.answer")} tone="problem">
        <StatusText value={outcomeText(result, t)} tone="danger" />
        <Why>{t(result.grpcStatus ? "gateway:check.why.noBackendGrpc" : "gateway:check.why.noBackend")}</Why>
      </Step>
    );
  }
  return null;
}

function lossText(c: Candidate, t: T): string {
  const text = t(`gateway:check.loss.${c.reason}`, {
    field: c.field ?? "",
    criterion: c.lostOn ? t(`gateway:check.criteria.${c.lostOn}`) : "",
  });
  return c.condition ? `${text}: ${c.condition}` : text;
}

function CandidateSubject({ c }: { c: Candidate }) {
  const { t } = useTranslation();
  if (c.level === "gateway") {
    return (
      <>
        <span className="dt-muted">{`${GATEWAY.kind} `}</span>
        {gatewayLink(c.gateway)}
      </>
    );
  }
  if (c.level === "listener" || !c.route) {
    return (
      <>
        {gatewayLink(c.gateway)}
        <span className="dt-muted">{` / ${t("gateway:topology.listener")} `}</span>
        {c.listener}
      </>
    );
  }
  const where = [
    c.rule !== undefined ? t("gateway:check.candidateRule", { n: c.rule + 1 }) : undefined,
    c.match !== undefined ? t("gateway:check.matchN", { n: c.match + 1 }) : undefined,
  ].filter(Boolean);
  return (
    <>
      <span className="dt-muted">{`${c.route.kind} `}</span>
      {routeLink(c.route)}
      {where.length > 0 && <span>{`${MATCH_SEPARATOR}${where.join(MATCH_SEPARATOR)}`}</span>}
      <span className="dt-muted">
        {` ${t("gateway:check.candidateOn", { gateway: fullName(c.gateway), listener: c.listener ?? "" })}`}
      </span>
    </>
  );
}

function AlsoConsidered({ candidates }: { candidates: Candidate[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="gw-considered">
      <Button
        size="compact"
        icon={open ? "chevronDown" : "chevronRight"}
        aria-expanded={open}
        aria-controls="gw-considered-list"
        onClick={() => setOpen(!open)}
      >
        {t("gateway:check.considered", { count: candidates.length })}
      </Button>
      {open &&
        (candidates.length > 0 ? (
          <ul id="gw-considered-list" className="gw-considered__list">
            {candidates.map((c, i) => {
              const explained = explainReason(c.condition);
              return (
                <li key={i} data-reason={c.reason} data-level={c.level}>
                  <span className="gw-considered__subject">
                    <CandidateSubject c={c} />
                  </span>
                  <span className="gw-considered__reason" title={explained ? t(explained) : undefined}>
                    {lossText(c, t)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p id="gw-considered-list" className="dt-muted">
            {t("gateway:check.consideredNone")}
          </p>
        ))}
    </section>
  );
}

const OUTCOME_TONE: Record<RequestExplanation["outcome"], "success" | "warning" | "danger"> = {
  forwarded: "success",
  redirected: "warning",
  noListener: "danger",
  noRoute: "danger",
  noBackend: "danger",
  invalidUrl: "danger",
};

export function RequestResult({ clusterId, result }: { clusterId: ClusterId; result: RequestExplanation }) {
  const { t } = useTranslation();
  const outcome = outcomeText(result, t);
  const routed = result.outcome === "forwarded" || result.outcome === "redirected" || result.outcome === "noBackend";
  return (
    <section className="gw-check__result" aria-label={t("gateway:check.result")}>
      <div className="gw-check__outcome" role="status">
        <StatusText value={outcome} tone={OUTCOME_TONE[result.outcome]} />
      </div>
      <ol className="gw-steps">
        <GatewayStep result={result} />
        {result.gateway && <RouteStep result={result} />}
        {routed && <FiltersStep result={result} />}
        {routed && result.outcome !== "redirected" && <BackendsStep clusterId={clusterId} result={result} />}
        <AnswerStep result={result} />
      </ol>
      {result.notes.length > 0 && (
        <div className="gw-check__notes" role="note" aria-label={t("gateway:check.notesTitle")}>
          {result.notes.map((n) => (
            <p key={n} className="gw-check__note">
              <Icon name="warning" />
              {t(`gateway:check.notes.${n}`)}
            </p>
          ))}
        </div>
      )}
      <AlsoConsidered candidates={result.candidates} />
    </section>
  );
}

// ---------- The page ----------

function RequestPanel({ clusterId, data }: { clusterId: ClusterId; data: CheckData }) {
  const { t } = useTranslation();
  const { form, checked } = useClusterCheck(clusterId);
  const patch = useRequestCheckStore((s) => s.patch);
  const parsed = useMemo(() => (checked ? requestInputOf(checked) : undefined), [checked]);
  const urlError = !!parsed && !parseRequest(parsed.input);
  const badLines = parsed?.badLines ?? [];
  const result = useMemo(
    () =>
      parsed && !urlError && badLines.length === 0 && !data.loading ? explainRequest(parsed.input, data.snapshot) : undefined,
    [parsed, urlError, badLines.length, data.loading, data.snapshot],
  );
  return (
    <div className="gw-check">
      <RequestFormView
        form={form}
        urlError={urlError}
        badLines={badLines}
        onChange={(change) => patch(clusterId, { form: { ...form, ...change } })}
        onSubmit={() => patch(clusterId, { checked: form })}
      />
      {data.loading ? (
        <LoadingLine text={t("gateway:check.loading")} />
      ) : result ? (
        <RequestResult clusterId={clusterId} result={result} />
      ) : (
        !checked && <p className="dt-muted">{t("gateway:check.hint")}</p>
      )}
    </div>
  );
}

export function RequestCheckPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const { tab, pending } = useClusterCheck(clusterId);
  const patch = useRequestCheckStore((s) => s.patch);
  const data = useCheckData(clusterId);
  const { snapshot, loading } = data;

  // A route from its details: once the Gateways and routes are in, the URL of a listener it is accepted on.
  useEffect(() => {
    if (!pending || loading) return;
    const rows = hostnameMap(snapshot.gateways, snapshot);
    const list = pending.route.kind === "GRPCRoute" ? snapshot.grpcRoutes : snapshot.httpRoutes;
    const obj =
      list?.find((r) => r.metadata?.name === pending.route.name && (r.metadata?.namespace ?? null) === pending.route.namespace) ??
      pending.obj;
    const form = { ...EMPTY_FORM, ...routePrefill(pending.route, rows, snapshot.gateways, obj) };
    patch(clusterId, { form, checked: form, pending: null });
  }, [pending, loading, snapshot, clusterId, patch]);

  const checkRow = (row: HostnameRow) => {
    const list = row.route.kind === "GRPCRoute" ? snapshot.grpcRoutes : snapshot.httpRoutes;
    const obj = list?.find((r) => r.metadata?.name === row.route.name && (r.metadata?.namespace ?? null) === row.route.namespace);
    const form = { ...EMPTY_FORM, ...rowPrefill(row, snapshot.gateways, obj) };
    patch(clusterId, { form, checked: form, tab: "request", pending: null });
  };

  const tabs: { id: CheckTab; label: string }[] = [
    { id: "request", label: t("gateway:check.tabs.request") },
    { id: "hostnames", label: t("gateway:check.tabs.hostnames") },
  ];
  return (
    <div className="gw-page">
      <header className="gw-page__header">
        <h2 className="gw-page__title">{t("gateway:check.title")}</h2>
      </header>
      <div className="gw-page__body">
        {data.notServed ? (
          <EmptyState title={t("gateway:check.notServed")} />
        ) : (
          <Tabs label={t("gateway:check.tabs.label")} tabs={tabs} selected={tab} onSelect={(id) => patch(clusterId, { tab: id })}>
            {tab === "hostnames" ? (
              <HostnameMap data={data} onCheck={checkRow} />
            ) : (
              <RequestPanel clusterId={clusterId} data={data} />
            )}
          </Tabs>
        )}
      </div>
    </div>
  );
}

registerPage({
  id: REQUEST_CHECK_PAGE,
  section: "gatewayApi",
  order: 70,
  labelKey: "gateway:sidebar.requestCheck",
  icon: "requestCheck",
  Component: RequestCheckPage,
});
