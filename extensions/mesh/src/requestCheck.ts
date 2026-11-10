// The "Request routing" page of the Istio section (#155), drawn as the built-in `RequestCheck.tsx` — "Where does this
// request go?": a URL, method and headers sent by a workload in the mesh (its namespace and labels) or into an Istio
// Gateway → the VirtualService and the route that takes it, the weighted destinations with their DestinationRule,
// subset, TLS mode and ready pods, or what the proxy answers itself; every VirtualService that did not apply with the
// reason, and the routes skipped before the one that matched. Built like Sextant's Gateway API request check (same form
// and steps). The Istio configuration comes from the shared lists (store.ts); the Services and pods of the
// destinations' namespaces are watched only while a result shows them. Nothing is sent anywhere.
import { ui, type KubeObject, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { batched, el, line, links, meshLink, muted, phraseLines, table, warningIcon } from "./dom";
import { matchPhrases, routeExtras } from "./engine/phrases";
import { destinationSelector, explainMeshRequest, parseMeshUrl, podsWithLabels, type DestinationOutcome, type MeshRouteResult, type Outcome } from "./engine/routing";
import { formatList, listSeparator, t } from "./i18n";
import { EMPTY_MESH_FORM, HTTP_METHODS, loadCheck, meshInputOf, saveCheck, type ClusterCheck, type MeshForm } from "./checkState";
import { Discovery, Lists, meshConfig, type MeshConfig } from "./store";

const OUTCOME_TONE: Record<Outcome, "success" | "neutral" | "danger" | "warning"> = {
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

function step(id: string, label: string, tone: StepTone, ...body: UiContent[]): HTMLElement {
  const node = el("li", `gw-step gw-step--${tone}`, el("div", "gw-step__label", label), el("div", "gw-step__body", ...body));
  node.dataset.step = id;
  return node;
}

// ---------- The result ----------

type PodCounts = (d: DestinationOutcome) => { ready: number; total: number } | undefined;

function gatewayStep(sextant: Sextant, result: MeshRouteResult): HTMLElement | null {
  if (result.outcome === "unknownGateway") return step("gateway", t("check.steps.gateway"), "problem", line(t("check.why.unknownGateway")));
  const g = result.gateway;
  if (!g) return null;
  const server = g.server;
  return step(
    "gateway",
    t("check.steps.gateway"),
    server ? "ok" : "problem",
    links([meshLink(sextant, g.ref)]),
    server
      ? line(t("check.server", { port: server.port ?? "", protocol: server.protocol ?? "", hosts: formatList(server.hosts) }))
      : line(t("check.why.noGatewayServer", { host: result.request.host })),
  );
}

function virtualServiceStep(sextant: Sextant, result: MeshRouteResult): HTMLElement | null {
  if (result.outcome === "unknownGateway" || result.outcome === "noGatewayServer") return null;
  if (result.used.length === 0)
    return step(
      "virtualService",
      t("check.steps.virtualService"),
      result.outcome === "defaultRoute" ? "ok" : "warning",
      line(t(result.gateway ? "check.why.noVirtualServiceGateway" : "check.why.noVirtualService", { host: result.request.host })),
    );
  return step(
    "virtualService",
    t("check.steps.virtualService"),
    "ok",
    links(result.used.map((r) => meshLink(sextant, r))),
    line(t("check.matchedHost", { host: result.matchedHost ?? "" })),
    result.used.length > 1 ? muted(t("check.merged")) : null,
  );
}

function routeStep(sextant: Sextant, result: MeshRouteResult): HTMLElement | null {
  if (result.used.length === 0) return null;
  const r = result.route;
  const skipped = result.skipped.map((s) =>
    el("li", "", t(s.failedOn ? `check.skipped.${s.failedOn}` : "check.skippedNoReason", { route: s.name ?? `#${s.index + 1}`, vs: s.vs.name })),
  );
  const tone: StepTone = result.outcome === "notEvaluated" || result.outcome === "l4Only" ? "warning" : r && result.outcome !== "delegateMissing" ? "ok" : "problem";
  const body = r
    ? [
        el(
          "p",
          "mesh-line",
          r.route.name ? t("route.titleNamed", { n: r.route.index + 1, name: r.route.name }) : t("route.title", { n: r.route.index + 1 }),
          " ",
          links([meshLink(sextant, r.vs)]),
        ),
        r.via ? muted(t("check.viaDelegate", { name: r.via.name })) : null,
        result.outcome === "notEvaluated"
          ? line(t("check.why.notEvaluated"))
          : r.matchIndex !== undefined
            ? phraseLines(matchPhrases(r.route.matches[r.matchIndex]!))
            : line(t("route.everyRequest")),
        result.outcome === "delegateMissing" ? line(t("check.why.delegateMissing")) : null,
        phraseLines(routeExtras(r.route)),
      ]
    : [line(t(result.outcome === "l4Only" ? "check.why.l4Only" : "check.why.noRoute"))];
  return step("route", t("check.steps.route"), tone, body, skipped.length > 0 ? el("ul", "gw-step__list", skipped) : null);
}

function podsText(d: DestinationOutcome, pods: PodCounts): string {
  const counted = pods(d);
  if (!counted) return "";
  return t("check.pods", { ready: counted.ready, total: counted.total });
}

function destinationsStep(sextant: Sextant, result: MeshRouteResult, pods: PodCounts): HTMLElement | null {
  if (result.destinations.length === 0) return null;
  const tone: StepTone = result.destinations.some((d) => d.problem) ? "problem" : "ok";
  return step(
    "destinations",
    t("check.steps.destinations"),
    tone,
    table(
      sextant,
      "destinations",
      [t("columns.destination"), t("columns.weight"), t("columns.subset"), t("columns.destinationRule"), t("columns.tlsMode"), t("columns.pods")],
      result.destinations.map((d) => ({
        broken: !!d.problem,
        cells: [
          el(
            "span",
            "",
            d.destination.port !== undefined ? `${d.destination.fqdn}:${d.destination.port}` : d.destination.fqdn,
            d.problem ? line(t(`check.problem.${d.problem}`, { subset: d.destination.subset ?? "" }), true) : null,
          ),
          `${d.weight}%`,
          d.destination.subset ?? "",
          d.rule ? meshLink(sextant, d.rule) : "",
          d.tlsMode ?? "",
          podsText(d, pods),
        ],
      })),
    ),
  );
}

function answerStep(result: MeshRouteResult): HTMLElement | null {
  if (!["redirected", "directResponse", "noRoute", "passthrough", "noGatewayServer", "delegateMissing"].includes(result.outcome)) return null;
  return step(
    "answer",
    t("check.steps.answer"),
    result.outcome === "redirected" || result.outcome === "directResponse" ? "ok" : "warning",
    line(t(`check.answer.${result.outcome}`, { status: result.status ?? "" })),
  );
}

function alsoConsidered(sextant: Sextant, result: MeshRouteResult): HTMLElement | null {
  const shown = result.candidates.filter((c) => c.reason !== "notBound" && c.reason !== "hostMismatch");
  if (shown.length === 0) return null;
  return el(
    "div",
    "mesh-considered",
    el("h3", "sx-block__title", t("check.alsoConsidered")),
    el(
      "ul",
      "gw-step__list",
      shown.map((c) => el("li", "", links([meshLink(sextant, c.ref)]), " ", el("span", "mesh-line", t(`check.candidate.${c.reason}`)))),
    ),
  );
}

export function resultView(sextant: Sextant, result: MeshRouteResult, pods: PodCounts): HTMLElement {
  const outcome = el("div", "gw-check__outcome", ui.status(t(`check.outcome.${result.outcome}`, { status: result.status ?? "" }), OUTCOME_TONE[result.outcome]));
  outcome.setAttribute("role", "status");
  const notes =
    result.notes.length > 0
      ? el(
          "div",
          "gw-check__notes",
          result.notes.map((n) => el("p", "gw-check__note", warningIcon(), t(`check.notes.${n}`))),
        )
      : null;
  if (notes) {
    notes.setAttribute("role", "note");
    notes.setAttribute("aria-label", t("check.notesTitle"));
  }
  const section = el(
    "section",
    "gw-check__result",
    outcome,
    el("ol", "gw-steps", gatewayStep(sextant, result), virtualServiceStep(sextant, result), routeStep(sextant, result), destinationsStep(sextant, result, pods), answerStep(result)),
    notes,
    alsoConsidered(sextant, result),
  );
  section.setAttribute("aria-label", t("check.result"));
  return section;
}

/** Watches the Services and pods of the destinations' namespaces; counts each destination's pods. */
function podCounts(lists: Lists, result: MeshRouteResult | undefined): PodCounts {
  const namespaces = [...new Set((result?.destinations ?? []).flatMap((d) => (d.service ? [d.service.namespace] : [])))].sort();
  if (namespaces.length === 0) return () => undefined;
  const services = lists.get({ kind: { group: "", version: "v1", kind: "Service" }, namespaces });
  const pods = lists.get({ kind: { group: "", version: "v1", kind: "Pod" }, namespaces });
  return (d) => {
    if (!d.service || services.status !== "ready" || pods.status !== "ready") return undefined;
    const svc = services.items.find((s) => s.metadata.namespace === d.service!.namespace && s.metadata.name === d.service!.name);
    const selector = destinationSelector(svc, d);
    if (!selector) return undefined;
    const list = podsWithLabels(pods.items, d.service.namespace, selector);
    const ready = list.filter((p: KubeObject) =>
      ((p.status as { conditions?: { type?: string; status?: string }[] } | undefined)?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
    ).length;
    return { ready, total: list.length };
  };
}

// ---------- The form ----------

interface Errors {
  url: boolean;
  badLines: number[];
  badLabels: string[];
}

function field(label: string, control: HTMLElement, grow = false): HTMLElement {
  return el("label", grow ? "gw-check__field gw-check__field--grow" : "gw-check__field", el("span", "gw-check__label", label), control);
}

function select(name: string, value: string, options: readonly { value: string; label: string; disabled?: boolean }[], onChange: (v: string) => void): HTMLSelectElement {
  const node = el("select", "");
  node.dataset.field = name;
  for (const o of options) {
    const option = new Option(o.label, o.value);
    option.disabled = o.disabled === true;
    node.append(option);
  }
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

function input(name: string, value: string, onInput: (v: string) => void, options: { className?: string; placeholder?: string; invalid?: boolean } = {}): HTMLInputElement {
  const node = el("input", options.className ?? "");
  node.type = "text";
  node.value = value;
  node.spellcheck = false;
  node.autocomplete = "off";
  node.dataset.field = name;
  if (options.placeholder) node.placeholder = options.placeholder;
  if (options.invalid) node.setAttribute("aria-invalid", "true");
  node.addEventListener("input", () => onInput(node.value));
  return node;
}

function errorLine(text: string): HTMLElement {
  const node = el("p", "gw-check__error", text);
  node.setAttribute("role", "alert");
  return node;
}

export function formView(form: MeshForm, config: MeshConfig, errors: Errors, onChange: (patch: Partial<MeshForm>) => void, onSubmit: () => void): HTMLFormElement {
  const gateways = config.gateways ?? [];
  const check = ui.button(t("check.form.check"), () => undefined, { variant: "primary", icon: "requestCheck" });
  check.type = "submit";
  const headers = el("textarea", "gw-check__headers");
  headers.rows = 2;
  headers.value = form.headers;
  headers.spellcheck = false;
  headers.placeholder = t("check.form.headersPlaceholder");
  headers.dataset.field = "headers";
  if (errors.badLines.length > 0) headers.setAttribute("aria-invalid", "true");
  headers.addEventListener("input", () => onChange({ headers: headers.value }));
  const parts: UiContent[] = [
    el(
      "div",
      "gw-check__line",
      field(
        t("check.form.method"),
        select(
          "method",
          form.method,
          HTTP_METHODS.map((m) => ({ value: m, label: m })),
          (method) => onChange({ method }),
        ),
      ),
      field(
        t("check.form.url"),
        input("url", form.url, (url) => onChange({ url }), { className: "gw-check__url", placeholder: t("check.form.urlPlaceholder"), invalid: errors.url }),
        true,
      ),
      check,
    ),
    errors.url ? errorLine(t("check.form.invalidUrl")) : null,
    el(
      "div",
      "gw-check__line",
      field(
        t("check.form.from"),
        select(
          "from",
          form.from,
          [
            { value: "mesh", label: t("check.form.fromMesh") },
            { value: "gateway", label: t("check.form.fromGateway"), disabled: gateways.length === 0 },
          ],
          (from) => onChange({ from: from === "gateway" ? "gateway" : "mesh" }),
        ),
      ),
      form.from === "gateway"
        ? field(
            t("check.form.gateway"),
            select("gateway", form.gateway, [{ value: "", label: t("check.form.pickGateway") }, ...gateways.map((g) => ({ value: g.key, label: g.key }))], (gateway) => onChange({ gateway })),
            true,
          )
        : [
            field(t("check.form.namespace"), input("namespace", form.namespace, (namespace) => onChange({ namespace }))),
            field(
              t("check.form.labels"),
              input("labels", form.labels, (labels) => onChange({ labels }), { placeholder: t("check.form.labelsPlaceholder"), invalid: errors.badLabels.length > 0 }),
              true,
            ),
          ],
    ),
    errors.badLabels.length > 0 ? errorLine(t("check.form.badLabels", { labels: errors.badLabels.join(listSeparator()) })) : null,
    field(t("check.form.headers"), headers),
    errors.badLines.length > 0 ? errorLine(t("check.form.badHeaders", { count: errors.badLines.length, lines: errors.badLines.join(listSeparator()) })) : null,
  ];
  const node = el("form", "gw-check__form", parts);
  node.noValidate = true;
  node.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit();
  });
  return node;
}

// ---------- The page ----------

/** The result of a checked form, or nothing while it cannot be judged; and what of the form could not be read. */
export function checkResult(checked: MeshForm | null, config: MeshConfig): { result?: MeshRouteResult; errors: Errors } {
  const parsed = checked ? meshInputOf(checked) : undefined;
  const urlError = !!parsed && !parseMeshUrl(parsed.input.url);
  const errors = { url: urlError, badLines: parsed?.badLines ?? [], badLabels: parsed?.badLabels ?? [] };
  const result =
    parsed && !urlError && errors.badLines.length === 0 && errors.badLabels.length === 0 && !config.loading ? explainMeshRequest(parsed.input, config) : undefined;
  return { result, errors };
}

/** Starts the "Request routing" page on the cluster of the context. */
export function startRequestCheck(sextant: Sextant, root: HTMLElement): () => void {
  const clusterId = sextant.context.clusterId;
  let stopped = false;
  let check: ClusterCheck = { form: EMPTY_MESH_FORM, checked: null };
  let loaded = false;
  const schedule = batched(() => render());
  const lists = new Lists(sextant, schedule);
  const discovery = new Discovery(sextant, schedule);
  const title = el("h2", "gw-page__title", t("check.title"));
  const body = el("div", "gw-page__body");
  root.replaceChildren(el("div", "gw-page", el("header", "gw-page__header", title), body));
  const formHolder = el("div", "");
  const resultHolder = el("div", "");
  let formKey = "";
  const save = () => {
    if (clusterId) void saveCheck(sextant, clusterId, check).catch(() => undefined);
  };
  const onChange = (patch: Partial<MeshForm>) => {
    const structural = patch.from !== undefined && patch.from !== check.form.from;
    check = { ...check, form: { ...check.form, ...patch } };
    save();
    if (structural) render();
  };
  const onSubmit = () => {
    check = { ...check, checked: check.form };
    save();
    render();
  };
  function render(): void {
    if (stopped || !loaded) return;
    lists.begin();
    const config = meshConfig(lists, discovery.get());
    if (!config.loading && !config.istio) {
      lists.end();
      body.replaceChildren(ui.empty(t("check.notServed")));
      formKey = "";
      return;
    }
    const { result, errors } = checkResult(check.checked, config);
    const pods = podCounts(lists, result);
    lists.end();
    if (!body.contains(formHolder)) body.replaceChildren(el("div", "gw-check", formHolder, resultHolder));
    // The form is drawn again only when what it shows changes, so typing is never interrupted.
    const key = JSON.stringify([check.form.from, errors, (config.gateways ?? []).map((g) => g.key)]);
    if (key !== formKey) {
      formKey = key;
      const active = document.activeElement instanceof HTMLElement && formHolder.contains(document.activeElement) ? document.activeElement.dataset.field : undefined;
      formHolder.replaceChildren(formView(check.form, config, errors, onChange, onSubmit));
      if (active) formHolder.querySelector<HTMLElement>(`[data-field="${active}"]`)?.focus();
    }
    resultHolder.replaceChildren(
      config.loading ? loadingLine(t("loading")) : result ? resultView(sextant, result, pods) : !check.checked ? muted(t("check.hint")) : el("span", ""),
    );
  }
  void (clusterId ? loadCheck(sextant, clusterId) : Promise.resolve(check)).then((stored) => {
    if (stopped) return;
    check = stored;
    loaded = true;
    render();
  });
  const offKinds = sextant.onContextChange(() => {
    if (discovery.follow()) schedule();
  });
  return () => {
    stopped = true;
    offKinds();
    lists.stop();
  };
}

function loadingLine(text: string): HTMLElement {
  const node = muted(text);
  node.setAttribute("role", "status");
  return node;
}
