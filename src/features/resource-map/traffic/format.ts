// How the traffic graph's values read: ends, rates (requests or, for TCP, connections), error shares, latency, the
// source. The numbers keep the "Requests" section's formats (#212).
import type { TFunction } from "i18next";
import type { RequestSourceKind, TrafficDetail, TrafficEdge, TrafficPeer } from "../../../api";
import { formatList, formatNumber } from "../../../i18n";
import { formatBytes } from "../../metrics/format";
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

/** Requests per second, new connections per second for TCP, or bytes per second for TCP seen as bytes (Caretta). */
export function rateText(t: TFunction, edge: Pick<TrafficEdge, "rate" | "protocol">): string {
  if (edge.protocol === "tcpBytes") return t("traffic:value.bytes", { value: formatBytes(edge.rate) });
  const value = formatNumber(edge.rate, digits(edge.rate));
  return edge.protocol === "tcp" ? t("traffic:value.connections", { value }) : t("traffic:value.rate", { value });
}

/** A line's rate: its requests per second, its new TCP connections per second and its TCP bytes per second when it
 * has any (each another unit, never added up). */
export function linkRateText(t: TFunction, link: { rate: number; tcpRate: number; bytesRate: number }): string {
  const parts: string[] = [];
  if (link.rate > 0 || (link.tcpRate === 0 && link.bytesRate === 0))
    parts.push(rateText(t, { rate: link.rate, protocol: "http" }));
  if (link.tcpRate > 0) parts.push(rateText(t, { rate: link.tcpRate, protocol: "tcp" }));
  if (link.bytesRate > 0) parts.push(rateText(t, { rate: link.bytesRate, protocol: "tcpBytes" }));
  return formatList(parts);
}

/** Whether the query of `detail` failed for this edge (its value is unknown, not absent). */
function unread(edge: TrafficEdge, detail: TrafficDetail): boolean {
  return edge.missing.includes(detail);
}

export function errorsText(t: TFunction, edge: TrafficEdge): string {
  if (edge.errorRatio !== null) return formatShare(t, edge.errorRatio);
  if (unread(edge, "errors")) return t("traffic:value.notRead");
  const tcp = edge.protocol === "tcp" || edge.protocol === "tcpBytes";
  return tcp ? t("traffic:value.noVerdict") : t("traffic:level.unknown");
}

export function latencyText(t: TFunction, edge: TrafficEdge): string {
  if (unread(edge, "latency") && edge.p50Ms === null && edge.p95Ms === null) return t("traffic:value.notRead");
  if (edge.p50Ms === null && edge.p95Ms === null) return t("traffic:value.noLatency");
  return t("traffic:value.latency", { p50: formatLatency(t, edge.p50Ms), p95: formatLatency(t, edge.p95Ms) });
}

/**
 * The protocol of an edge. Caretta's bytes to a Service are only what the client sent to the Service's ClusterIP (the
 * answers are on the edge to the workload behind it, ADR-0096): said so.
 */
export function protocolText(t: TFunction, edge: Pick<TrafficEdge, "protocol" | "to">): string {
  if (edge.protocol === "tcpBytes" && edge.to.kind === "service") return t("traffic:protocol.tcpBytesToService");
  return t(`traffic:protocol.${edge.protocol}`);
}

export function classesText(t: TFunction, edge: TrafficEdge): string {
  if (unread(edge, "classes")) return t("traffic:value.notRead");
  if (edge.statusClasses.length === 0) return t("traffic:value.noClasses");
  return formatList(
    edge.statusClasses.map((c) =>
      t("traffic:value.class", { class: c.class, value: formatNumber(c.rate, digits(c.rate)) }),
    ),
  );
}

/** The details some edges of these sources lack because their queries failed, as one list. */
export function missingDetails(t: TFunction, edges: readonly TrafficEdge[]): { sources: string; details: string } | null {
  const sources = new Set<RequestSourceKind>();
  const details = new Set<TrafficDetail>();
  for (const edge of edges) {
    if (edge.missing.length === 0) continue;
    sources.add(edge.source);
    for (const d of edge.missing) details.add(d);
  }
  if (sources.size === 0) return null;
  const order: TrafficDetail[] = ["errors", "classes", "latency"];
  return {
    sources: sourceNames(t, [...sources]),
    details: formatList(order.filter((d) => details.has(d)).map((d) => t(`traffic:detail.${d}`))),
  };
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
