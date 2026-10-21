// The "Connectivity" page of the Network section (#148): may a source reach a destination under the cluster's
// policies? The source is a pod, a pod described by its namespace and labels, or an address outside the cluster; the
// destination a pod, a Service (each pod behind it, at its target port) or an outside address, with a port and
// protocol. The answer — allowed, denied or unknown — comes per side (the source's egress, the destination's ingress)
// with the policies that select each side and the rule that allows (index, peer, port), or why nothing does; plus the
// DNS warning for an egress-isolated source. A second tab maps a namespace's isolation (`PolicyMap.tsx`), a third shows
// which pods of the filter's namespaces no policy isolates (`CoverageView.tsx`, #239). Read-only:
// objects are watched only while the page is open, for the namespaces the form names (`useNetpolData`).
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Button, Radio, Tabs } from "../../components";
import { registerPage, type PageProps } from "../../layout/pages";
import { StatusText } from "../../resources";
import { parseIp } from "./cidr";
import { dnsCheck, evaluate, evaluateService, type ConnectionResult, type DnsCheck, type ServiceResult, type Traffic } from "./engine";
import { useNetpolData, type NetpolData } from "./hooks";
import {
  describedPod,
  parseLabels,
  podInfo,
  PROTOCOLS,
  resolvePodPort,
  serviceInfo,
  type Endpoint,
  type PodInfo,
  type Protocol,
  type ServiceInfo,
} from "./model";
import { CoverageView } from "./CoverageView";
import { PolicyMap } from "./PolicyMap";
import {
  CONNECTIVITY_PAGE,
  useClusterConnectivity,
  useConnectivityStore,
  type ConnectivityForm,
  type ConnectivityTab,
  type DestinationType,
  type SourceType,
} from "./state";
import { labelsText, VERDICT_TONE, verdictText, type T } from "./text";
import { Field, NamespaceField } from "./fields";
import { DnsWarning, EnforcementBanner, SideView } from "./views";
import { ResizableTable } from "../../components/Table";

/** Pods behind a Service shown at most. */
export const MAX_BACKENDS = 50;

// ---------- From the form to the engine's input ----------

type ErrorKey =
  | "choosePod"
  | "podGone"
  | "chooseNamespace"
  | "labels"
  | "ip"
  | "port"
  | "portName"
  | "chooseService"
  | "serviceGone"
  | "chooseServicePort";

export interface Resolved {
  source?: Endpoint;
  destination?: { type: "pod"; pod: PodInfo } | { type: "service"; service: ServiceInfo; portIndex: number } | { type: "external"; ip: string };
  traffic?: Traffic;
  errors: { field: string; key: ErrorKey; params?: Record<string, string> }[];
}

const findByName = (list: readonly KubeObject[] | undefined, name: string) => list?.find((o) => o.metadata?.name === name);

export function resolveForm(form: ConnectivityForm, data: NetpolData): Resolved {
  const errors: Resolved["errors"] = [];
  const out: Resolved = { errors };
  if (form.sourceType === "external") {
    if (parseIp(form.sourceIp)) out.source = { type: "external", ip: form.sourceIp.trim() };
    else errors.push({ field: "sourceIp", key: "ip" });
  } else if (!form.sourceNamespace) {
    errors.push({ field: "sourceNamespace", key: "chooseNamespace" });
  } else if (form.sourceType === "labels") {
    const labels = parseLabels(form.sourceLabels);
    if (labels) out.source = { type: "pod", pod: describedPod(form.sourceNamespace, labels) };
    else errors.push({ field: "sourceLabels", key: "labels" });
  } else if (!form.sourcePod) {
    errors.push({ field: "sourcePod", key: "choosePod" });
  } else {
    const obj = findByName(data.pods(form.sourceNamespace), form.sourcePod);
    if (obj) out.source = { type: "pod", pod: podInfo(obj) };
    else errors.push({ field: "sourcePod", key: "podGone", params: { name: form.sourcePod, namespace: form.sourceNamespace } });
  }

  if (form.destinationType === "external") {
    if (parseIp(form.destinationIp)) out.destination = { type: "external", ip: form.destinationIp.trim() };
    else errors.push({ field: "destinationIp", key: "ip" });
  } else if (!form.destinationNamespace) {
    errors.push({ field: "destinationNamespace", key: "chooseNamespace" });
  } else if (form.destinationType === "service") {
    const obj = form.service ? findByName(data.services(form.destinationNamespace), form.service) : undefined;
    if (!form.service) errors.push({ field: "service", key: "chooseService" });
    else if (!obj) errors.push({ field: "service", key: "serviceGone", params: { name: form.service, namespace: form.destinationNamespace } });
    else {
      const service = serviceInfo(obj);
      const portIndex = form.servicePort === "" ? -1 : Number(form.servicePort);
      const port = service.ports[portIndex];
      if (!port) errors.push({ field: "servicePort", key: "chooseServicePort" });
      else {
        out.destination = { type: "service", service, portIndex };
        out.traffic = { protocol: port.protocol, port: port.port };
      }
    }
  } else if (!form.destinationPod) {
    errors.push({ field: "destinationPod", key: "choosePod" });
  } else {
    const obj = findByName(data.pods(form.destinationNamespace), form.destinationPod);
    if (obj) out.destination = { type: "pod", pod: podInfo(obj) };
    else errors.push({ field: "destinationPod", key: "podGone", params: { name: form.destinationPod, namespace: form.destinationNamespace } });
  }

  if (form.destinationType !== "service") {
    const pod = out.destination?.type === "pod" ? out.destination.pod : null;
    const port = resolvePodPort(form.port, form.protocol, pod);
    if (port !== null) out.traffic = { protocol: form.protocol, port };
    else if (/^\d+$/.test(form.port.trim()) || form.port.trim() === "" || !pod) errors.push({ field: "port", key: "port" });
    else errors.push({ field: "port", key: "portName", params: { name: form.port.trim(), protocol: form.protocol } });
  }
  return out;
}

export interface CheckOutcome {
  result?: ConnectionResult;
  service?: ServiceResult;
  dns: DnsCheck | null;
}

export function runCheck(resolved: Resolved, data: NetpolData): CheckOutcome | null {
  const { source, destination, traffic } = resolved;
  if (!source || !destination || !traffic || resolved.errors.length > 0) return null;
  const dns = source.type === "pod" ? dnsCheck(source.pod, data.dnsPods, data.world) : null;
  if (destination.type === "service") {
    const pods = (data.pods(destination.service.namespace) ?? []).map(podInfo);
    return { service: evaluateService(source, destination.service, destination.portIndex, pods, data.world), dns };
  }
  return { result: evaluate(source, destination, traffic, data.world), dns };
}

// ---------- The form ----------

function NameSelect({ label, value, names, onChange }: { label: string; value: string; names: string[] | undefined; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const options = value && !(names ?? []).includes(value) ? [value, ...(names ?? [])] : (names ?? []);
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t(names === undefined ? "netpol:form.loadingNames" : "netpol:form.choose")}</option>
        {options.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </Field>
  );
}

function TypeChoice<V extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: V; options: { id: V; label: string }[]; onChange: (v: V) => void }) {
  return (
    <div className="np-types" role="radiogroup" aria-label={legend}>
      {options.map((o) => (
        <label key={o.id} className="np-types__item">
          <Radio name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
          {o.label}
        </label>
      ))}
    </div>
  );
}

const names = (list: readonly KubeObject[] | undefined) =>
  list?.map((o) => o.metadata?.name ?? "").filter(Boolean).sort();

function FormView({ clusterId, data }: { clusterId: ClusterId; data: NetpolData }) {
  const { t } = useTranslation();
  const { form } = useClusterConnectivity(clusterId);
  const patchStore = useConnectivityStore((s) => s.patch);
  const set = (p: Partial<ConnectivityForm>) => patchStore(clusterId, { form: { ...form, ...p } });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    patchStore(clusterId, { checked: form });
  };
  const services = data.services(form.destinationNamespace);
  const service = form.service ? findByName(services, form.service) : undefined;
  const servicePorts = service ? serviceInfo(service).ports : [];
  const sourceTypes: { id: SourceType; label: string }[] = [
    { id: "pod", label: t("netpol:form.type.pod") },
    { id: "labels", label: t("netpol:form.type.labels") },
    { id: "external", label: t("netpol:form.type.external") },
  ];
  const destinationTypes: { id: DestinationType; label: string }[] = [
    { id: "pod", label: t("netpol:form.type.pod") },
    { id: "service", label: t("netpol:form.type.service") },
    { id: "external", label: t("netpol:form.type.external") },
  ];
  return (
    <form className="np-form" onSubmit={submit} noValidate>
      <fieldset className="np-form__group">
        <legend>{t("netpol:form.source")}</legend>
        <TypeChoice name="np-source" legend={t("netpol:form.source")} value={form.sourceType} options={sourceTypes} onChange={(v) => set({ sourceType: v })} />
        <div className="np-form__line">
          {form.sourceType === "external" ? (
            <Field label={t("netpol:form.ip")}>
              <input type="text" value={form.sourceIp} spellCheck={false} placeholder={t("netpol:form.ipPlaceholder")} onChange={(e) => set({ sourceIp: e.target.value })} />
            </Field>
          ) : (
            <>
              <NamespaceField label={t("netpol:form.namespace")} value={form.sourceNamespace} namespaces={data.namespaces} onChange={(ns) => set({ sourceNamespace: ns, sourcePod: "" })} />
              {form.sourceType === "pod" ? (
                <NameSelect label={t("netpol:form.pod")} value={form.sourcePod} names={form.sourceNamespace ? names(data.pods(form.sourceNamespace)) : []} onChange={(v) => set({ sourcePod: v })} />
              ) : (
                <Field label={t("netpol:form.labels")} wide>
                  <input type="text" value={form.sourceLabels} spellCheck={false} placeholder={t("netpol:form.labelsPlaceholder")} onChange={(e) => set({ sourceLabels: e.target.value })} />
                </Field>
              )}
            </>
          )}
        </div>
      </fieldset>
      <fieldset className="np-form__group">
        <legend>{t("netpol:form.destination")}</legend>
        <TypeChoice name="np-destination" legend={t("netpol:form.destination")} value={form.destinationType} options={destinationTypes} onChange={(v) => set({ destinationType: v })} />
        <div className="np-form__line">
          {form.destinationType === "external" ? (
            <Field label={t("netpol:form.ip")}>
              <input type="text" value={form.destinationIp} spellCheck={false} placeholder={t("netpol:form.ipPlaceholder")} onChange={(e) => set({ destinationIp: e.target.value })} />
            </Field>
          ) : (
            <NamespaceField label={t("netpol:form.namespace")} value={form.destinationNamespace} namespaces={data.namespaces} onChange={(ns) => set({ destinationNamespace: ns, destinationPod: "", service: "", servicePort: "" })} />
          )}
          {form.destinationType === "pod" && (
            <NameSelect label={t("netpol:form.pod")} value={form.destinationPod} names={form.destinationNamespace ? names(data.pods(form.destinationNamespace)) : []} onChange={(v) => set({ destinationPod: v })} />
          )}
          {form.destinationType === "service" && (
            <>
              <NameSelect label={t("netpol:form.service")} value={form.service} names={form.destinationNamespace ? names(services) : []} onChange={(v) => set({ service: v, servicePort: "" })} />
              <Field label={t("netpol:form.servicePort")}>
                <select value={form.servicePort} onChange={(e) => set({ servicePort: e.target.value })}>
                  <option value="">{t("netpol:form.choose")}</option>
                  {servicePorts.map((p, i) => (
                    <option key={i} value={String(i)}>
                      {t(p.name ? "netpol:form.servicePortNamed" : "netpol:form.servicePortOption", { name: p.name, port: p.port, protocol: p.protocol, target: String(p.targetPort) })}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {form.destinationType !== "service" && (
            <>
              <Field label={t("netpol:form.port")}>
                <input type="text" className="np-form__port" value={form.port} spellCheck={false} placeholder={t("netpol:form.portPlaceholder")} onChange={(e) => set({ port: e.target.value })} />
              </Field>
              <Field label={t("netpol:form.protocol")}>
                <select value={form.protocol} onChange={(e) => set({ protocol: e.target.value as Protocol })}>
                  {PROTOCOLS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
      </fieldset>
      <div className="np-form__actions">
        <Button type="submit" variant="primary" icon="connectivity">
          {t("netpol:form.check")}
        </Button>
      </div>
    </form>
  );
}

// ---------- The result ----------

const podEndpoint = (pod: PodInfo): Endpoint => ({ type: "pod", pod });

function endpointText(t: T, ep: Endpoint): string {
  if (ep.type === "external") return ep.ip;
  if (ep.pod.name === null) {
    const labels = labelsText(ep.pod.labels);
    return labels ? t("netpol:endpoint.labels", { namespace: ep.pod.namespace, labels }) : t("netpol:endpoint.anyPod", { namespace: ep.pod.namespace });
  }
  return `${ep.pod.namespace}/${ep.pod.name}`;
}

function ConnectionView({ result, source, destination }: { result: ConnectionResult; source: Endpoint; destination: Endpoint }) {
  const { t } = useTranslation();
  const notes = result.notes.filter((n) => n !== "hostNetworkSource" && n !== "hostNetworkDestination" && n !== "externalDestination");
  return (
    <>
      <div className="np-sides">
        <SideView side={result.egress} title={t("netpol:result.egressFrom", { source: endpointText(t, source) })} />
        <SideView side={result.ingress} title={t("netpol:result.ingressTo", { destination: endpointText(t, destination) })} />
      </div>
      {notes.length > 0 && (
        <ul className="np-notes">
          {notes.map((n) => (
            <li key={n}>{t(`netpol:note.${n}`)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function ServiceView({ outcome, service, source }: { outcome: ServiceResult; service: ServiceInfo; source: Endpoint }) {
  const { t } = useTranslation();
  const backends = outcome.backends.slice(0, MAX_BACKENDS);
  const firstOpen = backends.findIndex((b) => b.result && b.result.verdict !== "allowed");
  const [chosen, setChosen] = useState<string | null>(null);
  const shown = backends.find((b) => b.pod.name === chosen) ?? backends[firstOpen >= 0 ? firstOpen : 0];
  const nodePorts = service.type === "NodePort" || service.type === "LoadBalancer";
  return (
    <>
      {outcome.empty && <p className="np-warning">{t(`netpol:service.${outcome.empty}`)}</p>}
      {backends.length > 0 && (
        <div className="dt-table-wrap">
          <ResizableTable tableId="netpol.backends" className="dt-table dt-table--words np-backends" aria-label={t("netpol:service.backends")}>
            <thead>
              <tr>
                <th>{t("netpol:service.pod")}</th>
                <th>{t("netpol:service.port")}</th>
                <th>{t("netpol:service.result")}</th>
              </tr>
            </thead>
            <tbody>
              {backends.map((b) => (
                <tr key={b.pod.name} aria-selected={b === shown}>
                  <td>
                    <button type="button" className="np-linkbutton" onClick={() => setChosen(b.pod.name)}>
                      {b.pod.name}
                    </button>
                  </td>
                  <td className="dt-col--nowrap">{b.port === null ? t("netpol:service.noTargetPort") : String(b.port)}</td>
                  <td>{b.result ? <StatusText value={verdictText(t, b.result.verdict)} tone={VERDICT_TONE[b.result.verdict]} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </ResizableTable>
        </div>
      )}
      {outcome.backends.length > MAX_BACKENDS && <p className="dt-muted">{t("netpol:service.more", { count: outcome.backends.length - MAX_BACKENDS })}</p>}
      {shown?.result && <h3 className="np-subtitle">{t("netpol:service.details", { pod: shown.pod.name ?? "" })}</h3>}
      {shown?.result && <ConnectionView result={shown.result} source={source} destination={podEndpoint(shown.pod)} />}
      <ul className="np-notes">
        <li>{t("netpol:note.service")}</li>
        {nodePorts && <li>{t("netpol:note.serviceNodePort", { type: service.type })}</li>}
      </ul>
    </>
  );
}

function verdictLine(t: T, outcome: CheckOutcome): { text: string; tone: "success" | "danger" | "warning" } {
  if (outcome.service) {
    const v = outcome.service.verdict;
    if (v === "partial") {
      const reachable = outcome.service.backends.filter((b) => b.result);
      const allowed = reachable.filter((b) => b.result!.verdict === "allowed").length;
      return { text: t("netpol:result.partial", { count: reachable.length, allowed }), tone: "warning" };
    }
    if (outcome.service.empty) return { text: t("netpol:result.nothing"), tone: "warning" };
    return { text: t(`netpol:result.service.${v}`), tone: VERDICT_TONE[v] };
  }
  const v = outcome.result!.verdict;
  return { text: t(`netpol:result.${v}`), tone: VERDICT_TONE[v] };
}

function CheckPanel({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { form, checked } = useClusterConnectivity(clusterId);
  const inView = [form, checked].flatMap((f) =>
    f
      ? [f.sourceType !== "external" ? f.sourceNamespace : "", f.destinationType !== "external" ? f.destinationNamespace : ""]
      : [],
  );
  const serviceNs = [form, checked].flatMap((f) => (f?.destinationType === "service" ? [f.destinationNamespace] : []));
  const data = useNetpolData(clusterId, inView, { services: serviceNs, dns: checked !== null && checked.sourceType !== "external" });
  const resolved = useMemo(() => (checked && !data.loading ? resolveForm(checked, data) : null), [checked, data]);
  const outcome = useMemo(() => (resolved ? runCheck(resolved, data) : null), [resolved, data]);
  return (
    <div className="np-check">
      <FormView clusterId={clusterId} data={data} />
      {checked && (
        <section className="np-result" aria-label={t("netpol:result.label")}>
          {data.loading ? (
            <p className="dt-muted" role="status">
              {t("netpol:loading")}
            </p>
          ) : resolved && resolved.errors.length > 0 ? (
            <ul className="np-errors" role="alert">
              {resolved.errors.map((e) => (
                <li key={e.field}>{t(`netpol:errors.${e.key}`, e.params)}</li>
              ))}
            </ul>
          ) : outcome && resolved?.source && resolved.destination ? (
            <>
              <p className="np-result__verdict" role="status">
                <StatusText value={verdictLine(t, outcome).text} tone={verdictLine(t, outcome).tone} />
              </p>
              <DnsWarning dns={outcome.dns} />
              {outcome.service && resolved.destination.type === "service" ? (
                <ServiceView outcome={outcome.service} service={resolved.destination.service} source={resolved.source} />
              ) : outcome.result ? (
                <ConnectionView result={outcome.result} source={resolved.source} destination={resolved.destination as Endpoint} />
              ) : null}
            </>
          ) : null}
        </section>
      )}
    </div>
  );
}

export function ConnectivityPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const { tab } = useClusterConnectivity(clusterId);
  const patch = useConnectivityStore((s) => s.patch);
  const tabs: { id: ConnectivityTab; label: string }[] = [
    { id: "check", label: t("netpol:tabs.check") },
    { id: "map", label: t("netpol:tabs.map") },
    { id: "coverage", label: t("netpol:tabs.coverage") },
  ];
  return (
    <div className="np-page">
      <header className="np-page__header">
        <h2 className="np-page__title">{t("netpol:title")}</h2>
      </header>
      <div className="np-page__body">
        <EnforcementBanner />
        <Tabs label={t("netpol:tabs.label")} tabs={tabs} selected={tab} onSelect={(id) => patch(clusterId, { tab: id })}>
          {tab === "map" ? <PolicyMap clusterId={clusterId} /> : tab === "coverage" ? <CoverageView clusterId={clusterId} /> : <CheckPanel clusterId={clusterId} />}
        </Tabs>
      </div>
    </div>
  );
}

registerPage({
  id: CONNECTIVITY_PAGE,
  section: "network",
  order: 55,
  labelKey: "netpol:sidebar",
  icon: "connectivity",
  Component: ConnectivityPage,
});
