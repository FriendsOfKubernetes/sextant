// `check_connectivity`: the connectivity page's check (`resolveForm`, `runCheck`, ADR-0082) on the data the agent may
// read (`restrictNetpol`), in words.
import { useMemo } from "react";
import { EMPTY_FORM, type ConnectivityForm } from "../netpol/state";
import { resolveForm, runCheck, MAX_BACKENDS } from "../netpol/ConnectivityPage";
import type { ConnectionResult } from "../netpol/engine";
import { DNS_NAMESPACE } from "../netpol/engine";
import { POD, useNetpolData } from "../netpol/hooks";
import { serviceInfo, type Protocol } from "../netpol/model";
import { en } from "./english";
import { restrictNetpol, sideOut } from "./netpol";
import { objectName } from "./scope";
import { useAnswer, type WorkerProps } from "./worker";

interface End {
  type: "pod" | "labels" | "service" | "ip";
  namespace: string | null;
  value: string;
}

interface Args {
  from: End;
  to: End;
  port: string | null;
  protocol: Protocol;
}

/** Notes the page shows under a result (the others are said by the sides themselves). */
const SHOWN_NOTES = new Set(["self", "ipBlockPods", "externalSource", "calicoOrder"]);

function notesOf(result: ConnectionResult): string[] {
  return result.notes.filter((n) => SHOWN_NOTES.has(n)).map((n) => en(`netpol:note.${n}`));
}

/** The form the page would have, for the agent's ends; the Service port by number or name (or its only one). */
function formOf(args: Args, servicePort: string): ConnectivityForm {
  const form: ConnectivityForm = { ...EMPTY_FORM, protocol: args.protocol, port: args.port ?? "" };
  const { from, to } = args;
  if (from.type === "ip") Object.assign(form, { sourceType: "external", sourceIp: from.value });
  else if (from.type === "labels") Object.assign(form, { sourceType: "labels", sourceNamespace: from.namespace ?? "", sourceLabels: from.value });
  else Object.assign(form, { sourceType: "pod", sourceNamespace: from.namespace ?? "", sourcePod: from.value });
  if (to.type === "ip") Object.assign(form, { destinationType: "external", destinationIp: to.value });
  else if (to.type === "service") Object.assign(form, { destinationType: "service", destinationNamespace: to.namespace ?? "", service: to.value, servicePort });
  else Object.assign(form, { destinationType: "pod", destinationNamespace: to.namespace ?? "", destinationPod: to.value });
  return form;
}

export function ConnectivityWorker(props: WorkerProps) {
  const { request } = props;
  const args = request.args as unknown as Args;
  const inView = useMemo(
    () => [args.from, args.to].flatMap((e) => (e.type !== "ip" && e.namespace ? [e.namespace] : [])),
    [args.from, args.to],
  );
  const serviceNs = useMemo(() => (args.to.type === "service" && args.to.namespace ? [args.to.namespace] : []), [args.to]);
  const raw = useNetpolData(request.clusterId, inView, { services: serviceNs, dns: args.from.type !== "ip" });
  const data = useMemo(() => restrictNetpol(raw, [...inView, DNS_NAMESPACE], request.reads), [raw, inView, request.reads]);

  useAnswer(props, !raw.loading, () => {
    let servicePort = "";
    if (args.to.type === "service") {
      const svc = data.services(args.to.namespace ?? "")?.find((o) => o.metadata?.name === args.to.value);
      const ports = svc ? serviceInfo(svc).ports : [];
      const index =
        args.port === null
          ? ports.length === 1
            ? 0
            : -1
          : ports.findIndex((p) => String(p.port) === args.port || p.name === args.port);
      servicePort = index >= 0 ? String(index) : "";
    }
    const resolved = resolveForm(formOf(args, servicePort), data);
    if (resolved.errors.length > 0) {
      return {
        verdict: "unknown",
        summary: en("netpol:result.nothing"),
        errors: resolved.errors.map((e) => en(`netpol:errors.${e.key}`, e.params)),
      };
    }
    const outcome = runCheck(resolved, data);
    if (!outcome) return { verdict: "unknown", summary: en("netpol:result.nothing") };
    const dns = outcome.dns ? { udp: outcome.dns.udp, tcp: outcome.dns.tcp } : undefined;
    if (outcome.service) {
      const s = outcome.service;
      const reachable = s.backends.filter((b) => b.result);
      const allowed = reachable.filter((b) => b.result!.verdict === "allowed").length;
      const summary = s.empty
        ? en("netpol:result.nothing")
        : s.verdict === "partial"
          ? en("netpol:result.partial", { count: reachable.length, allowed })
          : en(`netpol:result.service.${s.verdict}`);
      const backends = s.backends.slice(0, MAX_BACKENDS);
      const shown = backends.find((b) => b.result && b.result.verdict !== "allowed") ?? backends.find((b) => b.result);
      const podName = (b: (typeof backends)[number]) => objectName(POD, b.pod.namespace, b.pod.name ?? "");
      return {
        verdict: s.empty ? "unknown" : s.verdict,
        summary,
        backends: backends.map((b) => ({ pod: podName(b), port: b.port ?? undefined, verdict: b.result?.verdict })),
        shownBackend: shown ? podName(shown) : undefined,
        egress: shown?.result ? sideOut(shown.result.egress) : undefined,
        ingress: shown?.result ? sideOut(shown.result.ingress) : undefined,
        dns,
        notes: [
          ...(s.empty ? [en(`netpol:service.${s.empty}`)] : []),
          ...(shown?.result ? notesOf(shown.result) : []),
          en("netpol:note.service"),
        ],
      };
    }
    const result = outcome.result!;
    return {
      verdict: result.verdict,
      summary: en(`netpol:result.${result.verdict}`),
      egress: sideOut(result.egress),
      ingress: sideOut(result.ingress),
      dns,
      notes: notesOf(result),
    };
  });
  return null;
}
