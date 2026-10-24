// What a click on the traffic graph shows: the calls between two ends (one per source and protocol) with both ends
// openable — the object's details, or straight its "Requests" section (#212) — or, for a node, the calls into and out
// of it. Read-only.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toApiError, type ClusterId, type TrafficEdge, type TrafficPeer } from "../../../api";
import { useAppStore } from "../../../app/store";
import { Button } from "../../../components";
import { EdgeLinks } from "../../observability-links/LinkButtons";
import {
  classesText,
  errorsText,
  latencyText,
  linkRateText,
  peerKind,
  peerName,
  protocolText,
  rateText,
  sourceName,
} from "./format";
import { peerId, type TrafficLink, type TrafficNode } from "./model";
import { openRequestsOf, resolvePeer } from "./resolve";

const DIRECTIONS = ["in", "out"] as const;

export type Selection = { type: "link"; link: TrafficLink } | { type: "node"; node: TrafficNode; links: TrafficLink[] };

function PeerActions({ clusterId, peer }: { clusterId: ClusterId; peer: TrafficPeer }) {
  const { t } = useTranslation();
  const openDetails = useAppStore((s) => s.openDetails);
  const [note, setNote] = useState<string | null>(null);
  if (peer.kind === "unknown" || !peer.name) return <p className="traffic-note">{t("traffic:peer.cannotOpen")}</p>;
  const name = peer.name;
  // Istio names a host outside the mesh with no namespace: nothing to look it up in.
  if (!peer.namespace) return <p className="traffic-note">{t("traffic:peer.noNamespace", { name })}</p>;
  const namespace = peer.namespace;
  const go = async (requests: boolean) => {
    setNote(null);
    try {
      const ref = await resolvePeer(clusterId, peer);
      if (!ref) {
        setNote(
          peer.kind === "service"
            ? t("traffic:notFound.service", { name, namespace })
            : t("traffic:notFound.workload", { name, namespace }),
        );
        return;
      }
      const isWorkload = ref.kind.group === "apps";
      if (requests && isWorkload) openRequestsOf(ref);
      else openDetails(ref);
    } catch (err) {
      setNote(toApiError(err).message);
    }
  };
  return (
    <div className="traffic-peer__actions">
      <Button size="compact" onClick={() => void go(false)}>
        {t("traffic:open", { name })}
      </Button>
      {peer.kind === "workload" && (
        <Button size="compact" onClick={() => void go(true)}>
          {t("traffic:openRequests", { name })}
        </Button>
      )}
      {note && (
        <p className="traffic-note" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function Peer({ clusterId, peer, label }: { clusterId: ClusterId; peer: TrafficPeer; label: string }) {
  const { t } = useTranslation();
  return (
    <div className="traffic-peer">
      <h4 className="traffic-peer__title">{label}</h4>
      <p className="traffic-peer__name">
        <span className="traffic-peer__kind">{peerKind(t, peer)}</span> {peerName(t, peer)}
      </p>
      <PeerActions clusterId={clusterId} peer={peer} />
    </div>
  );
}

function EdgeFacts({ edge }: { edge: TrafficEdge }) {
  const { t } = useTranslation();
  return (
    <div className="traffic-edge">
      <h4 className="traffic-edge__title">
        {t("traffic:fromSource", { source: sourceName(t, edge.source), protocol: protocolText(t, edge) })}
      </h4>
      {edge.via === "linkerdViz" && <p className="traffic-note">{t("requesthealth:viaLinkerdViz")}</p>}
      <dl className="traffic-facts">
        <dt>{t("traffic:fields.rate")}</dt>
        <dd>{rateText(t, edge)}</dd>
        <dt>{t("traffic:fields.errors")}</dt>
        <dd>{errorsText(t, edge)}</dd>
        <dt>{t("traffic:fields.latency")}</dt>
        <dd>{latencyText(t, edge)}</dd>
        <dt>{t("traffic:fields.classes")}</dt>
        <dd>{classesText(t, edge)}</dd>
      </dl>
    </div>
  );
}

export function SelectionPanel({
  clusterId,
  selection,
  onSelect,
  onClose,
}: {
  clusterId: ClusterId;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  let title: string;
  let body;
  if (selection.type === "link") {
    const first = selection.link.edges[0]!;
    title = t("traffic:selection.link", { from: peerName(t, first.from), to: peerName(t, first.to) });
    body = (
      <>
        <div className="traffic-peers">
          <Peer key={peerId(first.from)} clusterId={clusterId} peer={first.from} label={t("traffic:fields.from")} />
          <Peer key={peerId(first.to)} clusterId={clusterId} peer={first.to} label={t("traffic:fields.to")} />
        </div>
        <EdgeLinks clusterId={clusterId} from={first.from} to={first.to} />
        {selection.link.edges.map((edge) => (
          <EdgeFacts key={`${edge.source}|${edge.protocol}`} edge={edge} />
        ))}
      </>
    );
  } else {
    const { node, links } = selection;
    title = peerName(t, node.peer);
    const list = (direction: "in" | "out") => {
      const mine = links.filter((l) => (direction === "in" ? l.to === node.id : l.from === node.id));
      return (
        <>
          <h4 className="traffic-peer__title">{t(`traffic:selection.${direction}`, { count: mine.length })}</h4>
          {mine.length > 0 && (
            <ul className="traffic-links">
              {mine.map((link) => {
                const edge = link.edges[0]!;
                const other = direction === "in" ? edge.from : edge.to;
                return (
                  <li key={link.id}>
                    <button type="button" className="traffic-linkbtn" onClick={() => onSelect({ type: "link", link })}>
                      {t("traffic:selection.linkItem", {
                        peer: peerName(t, other),
                        rate: linkRateText(t, link),
                      })}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      );
    };
    body = (
      <>
        <Peer key={node.id} clusterId={clusterId} peer={node.peer} label={peerKind(t, node.peer)} />
        {DIRECTIONS.map((direction) => (
          <div key={direction}>{list(direction)}</div>
        ))}
      </>
    );
  }
  return (
    <aside className="traffic-panel" aria-label={title}>
      <div className="traffic-panel__head">
        <h3 className="traffic-panel__title" tabIndex={-1}>
          {title}
        </h3>
        <Button size="compact" iconOnly icon="close" label={t("traffic:selection.close")} onClick={onClose} />
      </div>
      {body}
    </aside>
  );
}
