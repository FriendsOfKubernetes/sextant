// Why a Service, Ingress or route gets no traffic (#208): the path the traffic would take, link by link, read from the
// cluster's objects only — no probe pod is started and no request is sent. Each link is a `Finding` with a status
// (`ok`, `warn`, `broken`, `unknown`) and plain words (a `Phrase`: an i18n key and its values, translated by the
// view). A `Chain` is one path: its findings in order, then the paths it branches into (an Ingress's rules, a route's
// backends). A chain stops at its first broken link: later links of that chain are not checked (`stopped`), while
// sibling chains go on (one broken rule of an Ingress says nothing about the others).
//
// Pure: the engine (`service.ts`, `ingress.ts`, `route.ts`, `policies.ts`) reads a `ClusterView` the hooks build
// from bounded, shared watches (`hooks.ts`).
import type { KindRef, KubeObject, SecretCertificates } from "../../api";
import type { SideResult, World } from "../netpol/engine";
import type { PodInfo } from "../netpol/model";

export type Status = "ok" | "warn" | "broken" | "unknown";

/**
 * A value of a phrase: text from the cluster, a number, a list of names (joined in the UI language) or another phrase
 * (translated in place).
 */
export type Param = string | number | readonly string[] | Phrase;

/** Plain words as an i18n key (with its namespace, e.g. `diagnose:service.noPods`) and its values. */
export interface Phrase {
  key: string;
  params?: Record<string, Param>;
}

/** An object a finding is about; the view links it to its details. */
export interface LinkRef {
  kind: KindRef;
  namespace: string | null;
  name: string;
}

export interface Finding {
  /** Stable within a chain: what was checked (`service.selector`, `ingress.class`, …). */
  id: string;
  status: Status;
  text: Phrase;
  /** More lines: why, what to look at. */
  notes?: Phrase[];
  links?: LinkRef[];
  /** The network policy evaluation behind a policy finding, shown with the connectivity view's words. */
  policies?: SideResult[];
}

export interface Chain {
  /** What the chain follows ("host / path → Service web:80"); none for the root. */
  title?: Phrase;
  /** The object the chain is about. */
  link?: LinkRef;
  findings: Finding[];
  chains: Chain[];
  /** A link broke: the checks after it were not run. */
  stopped: boolean;
}

/** Collects a chain's findings; nothing is added after a broken one. */
export class Walk {
  readonly chain: Chain;

  constructor(title?: Phrase, link?: LinkRef) {
    this.chain = { title, link, findings: [], chains: [], stopped: false };
  }

  /** Whether the chain still goes on (no link broke). */
  get going(): boolean {
    return !this.chain.stopped;
  }

  add(finding: Finding): boolean {
    if (this.chain.stopped) return false;
    this.chain.findings.push(finding);
    if (finding.status === "broken") this.chain.stopped = true;
    return !this.chain.stopped;
  }

  branch(chain: Chain): void {
    if (!this.chain.stopped) this.chain.chains.push(chain);
  }
}

const RANK: Record<Status, number> = { ok: 0, unknown: 1, warn: 2, broken: 3 };

export function worst(statuses: readonly Status[]): Status {
  return statuses.reduce<Status>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");
}

/** The status of a whole chain: its worst link, its branches included. */
export function chainStatus(chain: Chain): Status {
  return worst([...chain.findings.map((f) => f.status), ...chain.chains.map(chainStatus)]);
}

/** The first broken finding of a chain, depth first (what the summary names). */
export function firstBroken(chain: Chain): Finding | undefined {
  return chain.findings.find((f) => f.status === "broken") ?? chain.chains.map(firstBroken).find(Boolean);
}

export const phrase = (key: string, params?: Record<string, Param>): Phrase => ({ key: `diagnose:${key}`, params });

// ---------- What the engine reads ----------

/** A TLS Secret's certificates as `tls_certificate_info` returned them (values never leave the core). */
export type CertificateState =
  | { state: "ready"; info: SecretCertificates }
  /** The Secret does not exist, or it has no `tls.crt`. */
  | { state: "notFound" }
  | { state: "error"; code: string };

/** The pods of an Ingress controller, found by the labels its usual installation sets. */
export interface ControllerPods {
  /** The label selector looked for (`app.kubernetes.io/name=ingress-nginx`). */
  selector: string;
  pods: KubeObject[];
}

/**
 * The cluster as the engine sees it. A list is `undefined` when it is not known (loading, no permission, not
 * listed); `null` where the cluster does not serve the kind.
 */
export interface ClusterView {
  /** Now (ms), for how long something has been pending. */
  now: number;
  services(namespace: string): readonly KubeObject[] | undefined;
  /** Pods that have not finished (Succeeded and Failed pods take no traffic). */
  pods(namespace: string): readonly KubeObject[] | undefined;
  endpointSlices(namespace: string): readonly KubeObject[] | undefined;
  /** The policies the connectivity engine reasons over; `undefined` while unknown. */
  world: World | undefined;
  ingressClasses: readonly KubeObject[] | null | undefined;
  /** `null`: Sextant does not know how to find the pods of this controller. */
  controllerPods(controller: string): ControllerPods | null | undefined;
  certificates(namespace: string, secret: string): CertificateState | undefined;
  gateways(namespace: string): readonly KubeObject[] | null | undefined;
  grants(namespace: string): readonly KubeObject[] | undefined;
}

/** Where traffic to the backend pods comes from, for the network policy check. */
export type TrafficSource =
  | { type: "controller"; controller: string; pods: PodInfo[] }
  /** Not known: some client outside the backend's namespace. */
  | { type: "outside" };
