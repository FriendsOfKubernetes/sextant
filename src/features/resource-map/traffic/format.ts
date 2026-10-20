// How the traffic graph's values read: ends, rates (requests or, for TCP, connections), error shares, latency, the
// source. The numbers keep the "Requests" section's formats (#212).
import type { TFunction } from "i18next";
import type { RequestSourceKind, TrafficEdge, TrafficPeer } from "../../../api";
import { formatList, formatNumber } from "../../../i18n";
import { formatLatency, formatShare, SOURCE_KEY } from "../../request-health/model";

export function peerName(t: TFunction, peer: TrafficPeer): string {
  if (peer.kind === "unknown")
    return peer.namespace ? t("traffic:peer.unknownIn", { namespace: peer.namespace }) : t("traffic:peer.unknown");
  return peer.namespace ? t("traffic:peer.inNamespace", { name: peer.name, namespace: peer.namespace }) : (peer.name ?? "");
}

export function peerKind(t: TFunction, peer: TrafficPeer): string {
  return t(`traffic:peerKind.${peer.kind}`);
}

export function sourceName(t: TFunction, kind: RequestSourceKind): string {
  return t(`requesthealth:source.${SOURCE_KEY[kind]}`);
}

export function sourceNames(t: TFunction, kinds: readonly RequestSourceKind[]): string {
  return formatList(kinds.map((k) => sourceName(t, k)));
}

function digits(value: number): number {
  return value < 10 ? 2 : value < 100 ? 1 : 0;
}

/** Requests per second, or new connections per second for TCP. */
export function rateText(t: TFunction, edge: Pick<TrafficEdge, "rate" | "protocol">): string {
  const value = formatNumber(edge.rate, digits(edge.rate));
  return edge.protocol === "tcp" ? t("traffic:value.connections", { value }) : t("traffic:value.rate", { value });
}

export function errorsText(t: TFunction, edge: TrafficEdge): string {
  return edge.errorRatio === null ? t("traffic:value.noVerdict") : formatShare(t, edge.errorRatio);
}

export function latencyText(t: TFunction, edge: TrafficEdge): string {
  if (edge.p50Ms === null && edge.p95Ms === null) return t("traffic:value.noLatency");
  return t("traffic:value.latency", { p50: formatLatency(t, edge.p50Ms), p95: formatLatency(t, edge.p95Ms) });
}

export function protocolText(t: TFunction, edge: TrafficEdge): string {
  return t(`traffic:protocol.${edge.protocol}`);
}

export function classesText(t: TFunction, edge: TrafficEdge): string {
  if (edge.statusClasses.length === 0) return t("traffic:value.noClasses");
  return formatList(
    edge.statusClasses.map((c) =>
      t("traffic:value.class", { class: c.class, value: formatNumber(c.rate, digits(c.rate)) }),
    ),
  );
}

/** One sentence naming the edge for screen readers and tooltips. */
export function edgeSentence(t: TFunction, edge: TrafficEdge): string {
  return t("traffic:edgeSentence", {
    from: peerName(t, edge.from),
    to: peerName(t, edge.to),
    protocol: protocolText(t, edge),
    rate: rateText(t, edge),
    errors: errorsText(t, edge),
    source: sourceName(t, edge.source),
  });
}
