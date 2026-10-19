// The "Request routing" page of the Istio section (#155) — "Where does this request go?": a URL, method and headers
// sent by a workload in the mesh (its namespace and labels) or into an Istio Gateway → the VirtualService and the
// route that takes it, the weighted destinations with their DestinationRule, subset, TLS mode and ready pods, or what
// the proxy answers itself; every VirtualService that did not apply with the reason, and the routes skipped before
// the one that matched. Built like the Gateway API request check (same form and steps). The Istio configuration comes
// from the shared store; the Services and pods of the destinations' namespaces are watched only while a result shows
// them (shared watches of the resource map).
import { useMemo, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, WatchSpec } from "../../api";
import { Button, EmptyState, Icon } from "../../components";
import { formatList, listSeparator } from "../../i18n";
import { registerPage, type PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import type { Tone } from "../../resources/status";
import { LoadingLine, SimpleTable } from "../gateway-api/details";
import { HTTP_METHODS } from "../gateway-api/checkState";
import "../gateway-api/gateway.css";
import { useSharedWatches } from "../resource-map/watches";
import { MESH_CHECK_PAGE, meshInputOf, useMeshCheck, useMeshCheckStore, type MeshForm } from "./checkState";
import { matchPhrases, routeExtras } from "./phrases";
import {
  destinationSelector,
  explainMeshRequest,
  parseMeshUrl,
  podsWithLabels,
  type DestinationOutcome,
  type MeshRouteResult,
  type Outcome,
} from "./routing";
import { useMeshConfig, type MeshConfig } from "./store";
import { meshLink, PhraseLines, type T } from "./ui";

const SERVICE: KindRef = { group: "", version: "v1", kind: "Service" };
const POD: KindRef = { group: "", version: "v1", kind: "Pod" };

const OUTCOME_TONE: Record<Outcome, Tone> = {
  routed: "success",
  defaultRoute: "success",
  redirected: "neutral",
  directResponse: "neutral",
  noRoute: "danger",
  passthrough: "warning",
  noGatewayServer: "danger",
  unknownGateway: "danger",
  delegateMissing: "danger",
  l4Only: "warning",
  notEvaluated: "warning",
};

type StepTone = "ok" | "warning" | "problem";

const BROKEN_ROW = "gw-row--broken";

function Step({ id, label, tone = "ok", children }: { id: string; label: string; tone?: StepTone; children: ReactNode }) {
  return (
    <li className={`gw-step gw-step--${tone}`} data-step={id}>
      <div className="gw-step__label">{label}</div>
      <div className="gw-step__body">{children}</div>
    </li>
  );
}

// ---------- The form ----------

function MeshFormView({ form, config, onChange, onSubmit, errors }: {
  form: MeshForm;
  config: MeshConfig;
  onChange: (patch: Partial<MeshForm>) => void;
  onSubmit: () => void;
  errors: { url: boolean; badLines: number[]; badLabels: string[] };
}) {
  const { t } = useTranslation();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const gateways = config.gateways ?? [];
  const FROM_MESH: MeshForm["from"] = "mesh";
  const FROM_GATEWAY: MeshForm["from"] = "gateway";
  return (
    <form className="gw-check__form" onSubmit={submit} noValidate>
      <div className="gw-check__line">
        <label className="gw-check__field">
          <span className="gw-check__label">{t("mesh:check.form.method")}</span>
          <select value={form.method} onChange={(e) => onChange({ method: e.target.value })}>
            {HTTP_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="gw-check__field gw-check__field--grow">
          <span className="gw-check__label">{t("mesh:check.form.url")}</span>
          <input
            type="text"
            className="gw-check__url"
            value={form.url}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("mesh:check.form.urlPlaceholder")}
            aria-invalid={errors.url || undefined}
            onChange={(e) => onChange({ url: e.target.value })}
          />
        </label>
        <Button type="submit" variant="primary" icon="requestCheck">
          {t("mesh:check.form.check")}
        </Button>
      </div>
      {errors.url && (
        <p className="gw-check__error" role="alert">
          {t("mesh:check.form.invalidUrl")}
        </p>
      )}
      <div className="gw-check__line">
        <label className="gw-check__field">
          <span className="gw-check__label">{t("mesh:check.form.from")}</span>
          <select value={form.from} onChange={(e) => onChange({ from: e.target.value === "gateway" ? "gateway" : "mesh" })}>
            <option value={FROM_MESH}>{t("mesh:check.form.fromMesh")}</option>
            <option value={FROM_GATEWAY} disabled={gateways.length === 0}>
              {t("mesh:check.form.fromGateway")}
            </option>
          </select>
        </label>
        {form.from === "gateway" ? (
          <label className="gw-check__field gw-check__field--grow">
            <span className="gw-check__label">{t("mesh:check.form.gateway")}</span>
            <select value={form.gateway} onChange={(e) => onChange({ gateway: e.target.value })}>
              <option value="">{t("mesh:check.form.pickGateway")}</option>
              {gateways.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.key}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="gw-check__field">
              <span className="gw-check__label">{t("mesh:check.form.namespace")}</span>
              <input type="text" value={form.namespace} spellCheck={false} autoComplete="off" onChange={(e) => onChange({ namespace: e.target.value })} />
            </label>
            <label className="gw-check__field gw-check__field--grow">
              <span className="gw-check__label">{t("mesh:check.form.labels")}</span>
              <input
                type="text"
                value={form.labels}
                spellCheck={false}
                autoComplete="off"
                placeholder={t("mesh:check.form.labelsPlaceholder")}
                aria-invalid={errors.badLabels.length > 0 || undefined}
                onChange={(e) => onChange({ labels: e.target.value })}
              />
            </label>
          </>
        )}
      </div>
      {errors.badLabels.length > 0 && (
        <p className="gw-check__error" role="alert">
          {t("mesh:check.form.badLabels", { labels: errors.badLabels.join(listSeparator()) })}
        </p>
      )}
      <label className="gw-check__field">
        <span className="gw-check__label">{t("mesh:check.form.headers")}</span>
        <textarea
          className="gw-check__headers"
          rows={2}
          value={form.headers}
          spellCheck={false}
          placeholder={t("mesh:check.form.headersPlaceholder")}
          aria-invalid={errors.badLines.length > 0 || undefined}
          onChange={(e) => onChange({ headers: e.target.value })}
        />
      </label>
      {errors.badLines.length > 0 && (
        <p className="gw-check__error" role="alert">
          {t("mesh:check.form.badHeaders", { count: errors.badLines.length, lines: errors.badLines.join(listSeparator()) })}
        </p>
      )}
    </form>
  );
}

// ---------- The result ----------

function GatewayStep({ result, t }: { result: MeshRouteResult; t: T }) {
  if (result.outcome === "unknownGateway")
    return (
      <Step id="gateway" label={t("mesh:check.steps.gateway")} tone="problem">
        <p className="mesh-line">{t("mesh:check.why.unknownGateway")}</p>
      </Step>
    );
  const g = result.gateway;
  if (!g) return null;
  const server = g.server;
  return (
    <Step id="gateway" label={t("mesh:check.steps.gateway")} tone={server ? "ok" : "problem"}>
      <span className="dt-links">{meshLink(g.ref)}</span>
      {server ? (
        <p className="mesh-line">
          {t("mesh:check.server", { port: server.port ?? "", protocol: server.protocol ?? "", hosts: formatList(server.hosts) })}
        </p>
      ) : (
        <p className="mesh-line">{t("mesh:check.why.noGatewayServer", { host: result.request.host })}</p>
      )}
    </Step>
  );
}

function VirtualServiceStep({ result, t }: { result: MeshRouteResult; t: T }) {
  if (result.outcome === "unknownGateway" || result.outcome === "noGatewayServer") return null;
  if (result.used.length === 0)
    return (
      <Step id="virtualService" label={t("mesh:check.steps.virtualService")} tone={result.outcome === "defaultRoute" ? "ok" : "warning"}>
        <p className="mesh-line">{t(result.gateway ? "mesh:check.why.noVirtualServiceGateway" : "mesh:check.why.noVirtualService", { host: result.request.host })}</p>
      </Step>
    );
  return (
    <Step id="virtualService" label={t("mesh:check.steps.virtualService")}>
      <span className="dt-links">{result.used.map((r) => meshLink(r))}</span>
      <p className="mesh-line">{t("mesh:check.matchedHost", { host: result.matchedHost ?? "" })}</p>
      {result.used.length > 1 && <p className="dt-muted">{t("mesh:check.merged")}</p>}
    </Step>
  );
}

function RouteStep({ result, t }: { result: MeshRouteResult; t: T }) {
  if (result.used.length === 0) return null;
  const r = result.route;
  const skipped = result.skipped.map((s) => (
    <li key={`${s.vs.name}/${s.index}`}>
      {t(s.failedOn ? `mesh:check.skipped.${s.failedOn}` : "mesh:check.skippedNoReason", { route: s.name ?? `#${s.index + 1}`, vs: s.vs.name })}
    </li>
  ));
  const tone: StepTone = result.outcome === "notEvaluated" || result.outcome === "l4Only" ? "warning" : r && result.outcome !== "delegateMissing" ? "ok" : "problem";
  return (
    <Step id="route" label={t("mesh:check.steps.route")} tone={tone}>
      {r ? (
        <>
          <p className="mesh-line">
            {r.route.name
              ? t("mesh:route.titleNamed", { n: r.route.index + 1, name: r.route.name })
              : t("mesh:route.title", { n: r.route.index + 1 })}{" "}
            <span className="dt-links">{meshLink(r.vs)}</span>
          </p>
          {r.via && <p className="dt-muted">{t("mesh:check.viaDelegate", { name: r.via.name })}</p>}
          {result.outcome === "notEvaluated" ? (
            <p className="mesh-line">{t("mesh:check.why.notEvaluated")}</p>
          ) : r.matchIndex !== undefined ? (
            <PhraseLines phrases={matchPhrases(r.route.matches[r.matchIndex]!)} />
          ) : (
            <p className="mesh-line">{t("mesh:route.everyRequest")}</p>
          )}
          {result.outcome === "delegateMissing" && <p className="mesh-line">{t("mesh:check.why.delegateMissing")}</p>}
          <PhraseLines phrases={routeExtras(r.route)} />
        </>
      ) : (
        <p className="mesh-line">{t(result.outcome === "l4Only" ? "mesh:check.why.l4Only" : "mesh:check.why.noRoute")}</p>
      )}
      {skipped.length > 0 && <ul className="gw-step__list">{skipped}</ul>}
    </Step>
  );
}

function podsText(d: DestinationOutcome, pods: PodCounts, t: T): string {
  const counted = pods(d);
  if (!counted) return "";
  return t("mesh:check.pods", { ready: counted.ready, total: counted.total });
}

type PodCounts = (d: DestinationOutcome) => { ready: number; total: number } | undefined;

function DestinationsStep({ result, pods, t }: { result: MeshRouteResult; pods: PodCounts; t: T }) {
  if (result.destinations.length === 0) return null;
  const tone: StepTone = result.destinations.some((d) => d.problem) ? "problem" : "ok";
  return (
    <Step id="destinations" label={t("mesh:check.steps.destinations")} tone={tone}>
      <SimpleTable
        tableId="mesh.destinations"
        headers={[t("mesh:columns.destination"), t("mesh:columns.weight"), t("mesh:columns.subset"), t("mesh:columns.destinationRule"), t("mesh:columns.tlsMode"), t("mesh:columns.pods")]}
        rows={result.destinations.map((d, i) => ({
          key: `${i}`,
          className: d.problem ? BROKEN_ROW : undefined,
          cells: [
            <>
              {d.destination.port !== undefined ? `${d.destination.fqdn}:${d.destination.port}` : d.destination.fqdn}
              {d.problem && <p className="mesh-line mesh-line--warning">{t(`mesh:check.problem.${d.problem}`, { subset: d.destination.subset ?? "" })}</p>}
            </>,
            `${d.weight}%`,
            d.destination.subset ?? "",
            d.rule ? meshLink(d.rule) : "",
            d.tlsMode ?? "",
            podsText(d, pods, t),
          ],
        }))}
      />
    </Step>
  );
}

function AnswerStep({ result, t }: { result: MeshRouteResult; t: T }) {
  if (!["redirected", "directResponse", "noRoute", "passthrough", "noGatewayServer", "delegateMissing"].includes(result.outcome)) return null;
  return (
    <Step id="answer" label={t("mesh:check.steps.answer")} tone={result.outcome === "redirected" || result.outcome === "directResponse" ? "ok" : "warning"}>
      <p className="mesh-line">{t(`mesh:check.answer.${result.outcome}`, { status: result.status ?? "" })}</p>
    </Step>
  );
}

function AlsoConsidered({ result, t }: { result: MeshRouteResult; t: T }) {
  const shown = result.candidates.filter((c) => c.reason !== "notBound" && c.reason !== "hostMismatch");
  if (shown.length === 0) return null;
  return (
    <div className="mesh-considered">
      <h3 className="dt-block__title">{t("mesh:check.alsoConsidered")}</h3>
      <ul className="gw-step__list">
        {shown.map((c) => (
          <li key={`${c.ref.namespace}/${c.ref.name}`}>
            <span className="dt-links">{meshLink(c.ref)}</span> <span className="mesh-line">{t(`mesh:check.candidate.${c.reason}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultView({ result, pods }: { result: MeshRouteResult; pods: PodCounts }) {
  const { t } = useTranslation();
  return (
    <section className="gw-check__result" aria-label={t("mesh:check.result")}>
      <div className="gw-check__outcome" role="status">
        <StatusText value={t(`mesh:check.outcome.${result.outcome}`, { status: result.status ?? "" })} tone={OUTCOME_TONE[result.outcome]} />
      </div>
      <ol className="gw-steps">
        <GatewayStep result={result} t={t} />
        <VirtualServiceStep result={result} t={t} />
        <RouteStep result={result} t={t} />
        <DestinationsStep result={result} pods={pods} t={t} />
        <AnswerStep result={result} t={t} />
      </ol>
      {result.notes.length > 0 && (
        <div className="gw-check__notes" role="note" aria-label={t("mesh:check.notesTitle")}>
          {result.notes.map((n) => (
            <p key={n} className="gw-check__note">
              <Icon name="warning" />
              {t(`mesh:check.notes.${n}`)}
            </p>
          ))}
        </div>
      )}
      <AlsoConsidered result={result} t={t} />
    </section>
  );
}

/** Watches the Services and pods of the destinations' namespaces; counts each destination's pods. */
function usePodCounts(clusterId: ClusterId, result: MeshRouteResult | undefined): PodCounts {
  const namespaces = useMemo(
    () => [...new Set((result?.destinations ?? []).flatMap((d) => (d.service ? [d.service.namespace] : [])))].sort(),
    [result],
  );
  const specs: WatchSpec[] = useMemo(
    () =>
      namespaces.length > 0
        ? [
            { kind: SERVICE, namespaces, labelSelector: null, fieldSelector: null },
            { kind: POD, namespaces, labelSelector: null, fieldSelector: null },
          ]
        : [],
    [namespaces],
  );
  const [services, pods] = useSharedWatches(clusterId, specs);
  return (d) => {
    if (!d.service || services?.status !== "ready" || pods?.status !== "ready") return undefined;
    const svc = [...services.items.values()].find((s) => s.metadata?.namespace === d.service!.namespace && s.metadata?.name === d.service!.name);
    const selector = destinationSelector(svc, d);
    if (!selector) return undefined;
    const list = podsWithLabels(pods.items.values(), d.service.namespace, selector);
    const ready = list.filter((p) =>
      ((p.status as { conditions?: { type?: string; status?: string }[] } | undefined)?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
    ).length;
    return { ready, total: list.length };
  };
}

export function MeshRequestCheckPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const config = useMeshConfig(clusterId);
  const { form, checked } = useMeshCheck(clusterId);
  const patch = useMeshCheckStore((s) => s.patch);
  const parsed = useMemo(() => (checked ? meshInputOf(checked) : undefined), [checked]);
  const urlError = !!parsed && !parseMeshUrl(parsed.input.url);
  const badLines = parsed?.badLines ?? [];
  const badLabels = parsed?.badLabels ?? [];
  const result = useMemo(
    () =>
      parsed && !urlError && badLines.length === 0 && badLabels.length === 0 && !config.loading
        ? explainMeshRequest(parsed.input, config)
        : undefined,
    [parsed, urlError, badLines.length, badLabels.length, config],
  );
  const pods = usePodCounts(clusterId, result);
  return (
    <div className="gw-page">
      <header className="gw-page__header">
        <h2 className="gw-page__title">{t("mesh:check.title")}</h2>
      </header>
      <div className="gw-page__body">
        {!config.loading && !config.istio ? (
          <EmptyState title={t("mesh:check.notServed")} />
        ) : (
          <div className="gw-check">
            <MeshFormView
              form={form}
              config={config}
              errors={{ url: urlError, badLines, badLabels }}
              onChange={(change) => patch(clusterId, { form: { ...form, ...change } })}
              onSubmit={() => patch(clusterId, { checked: form })}
            />
            {config.loading ? (
              <LoadingLine text={t("mesh:loading")} />
            ) : result ? (
              <ResultView result={result} pods={pods} />
            ) : (
              !checked && <p className="dt-muted">{t("mesh:check.hint")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

registerPage({
  id: MESH_CHECK_PAGE,
  section: "istio",
  order: 200,
  labelKey: "mesh:sidebar.requestCheck",
  icon: "requestCheck",
  Component: MeshRequestCheckPage,
});
