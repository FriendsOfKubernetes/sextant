// The traffic graph drawn: ends as buttons in the map's columns (callers left), calls as lines as thick as their
// request rate (a pair seen only as TCP connections is drawn thinnest) and coloured by their error rate. A node is a button (Tab reaches it, Enter shows its calls); a line is clicked with
// the mouse — the list view offers every call to the keyboard and screen readers, so the drawing itself is hidden
// from them.
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { edgePath, NODE_H, NODE_W } from "../layout";
import { linkRateText, peerKind, peerName } from "./format";
import { strokeWidth, type TrafficLayout, type TrafficLink, type TrafficNode } from "./model";

function linkClass(link: TrafficLink, selected: boolean, dimmed: boolean): string {
  const classes = ["traffic-link", `traffic-link--${link.level}`];
  if (selected) classes.push("traffic-link--selected");
  if (dimmed) classes.push("traffic-link--dimmed");
  return classes.join(" ");
}

function nodeClass(node: TrafficNode, selected: boolean, dimmed: boolean): string {
  const classes = ["rmap-node", "traffic-node", `traffic-node--${node.peer.kind}`];
  if (selected) classes.push("rmap-node--selected");
  if (dimmed) classes.push("rmap-node--dimmed");
  return classes.join(" ");
}

export function TrafficGraphView({
  layout,
  selectedId,
  onLink,
  onNode,
}: {
  layout: TrafficLayout;
  selectedId: string | null;
  onLink: (link: TrafficLink) => void;
  onNode: (node: TrafficNode) => void;
}) {
  const { t } = useTranslation();
  const [focus, setFocus] = useState<string | null>(null);
  const at = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const lit = useMemo(() => {
    const active = focus ?? selectedId;
    if (active === null) return null;
    const ids = new Set([active]);
    for (const l of layout.links) {
      if (l.id === active) {
        ids.add(l.from);
        ids.add(l.to);
      }
      if (l.from === active) ids.add(l.to);
      if (l.to === active) ids.add(l.from);
    }
    return ids;
  }, [focus, selectedId, layout]);
  return (
    <div className="rmap-scroll">
      <div className="rmap-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="traffic-links-svg" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            <marker id="traffic-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M 0 0 L 8 4 L 0 8 z" className="traffic-arrow" />
            </marker>
          </defs>
          {layout.links.map((link) => {
            const a = at.get(link.from);
            const b = at.get(link.to);
            // A workload calling itself is in the list; a loop on its own box would hide its name.
            if (!a || !b || a === b) return null;
            const active = lit !== null && (lit.has(link.id) || (lit.has(link.from) && lit.has(link.to)));
            const classes = linkClass(link, link.id === selectedId, lit !== null && !active);
            const style: CSSProperties = { strokeWidth: strokeWidth(link.rate, layout.maxRate) };
            return (
              <path
                key={link.id}
                className={classes}
                style={style}
                d={edgePath(a, b)}
                markerEnd="url(#traffic-arrow)"
                data-link={link.id}
                onClick={() => onLink(link)}
                onMouseEnter={() => setFocus(link.id)}
                onMouseLeave={() => setFocus(null)}
              >
                <title>
                  {t("traffic:linkTitle", {
                    from: peerName(t, link.edges[0]!.from),
                    to: peerName(t, link.edges[0]!.to),
                    rate: linkRateText(t, link),
                  })}
                </title>
              </path>
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          const style: CSSProperties = { left: node.x, top: node.y, width: NODE_W, height: NODE_H };
          const classes = nodeClass(node, node.id === selectedId, lit !== null && !lit.has(node.id));
          return (
            <button
              key={node.id}
              type="button"
              className={classes}
              style={style}
              data-node={node.id}
              aria-label={t("traffic:nodeLabel", { kind: peerKind(t, node.peer), name: peerName(t, node.peer) })}
              onMouseEnter={() => setFocus(node.id)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(node.id)}
              onBlur={() => setFocus(null)}
              onClick={() => onNode(node)}
            >
              <span className="rmap-node__head">
                <span className="rmap-node__kind">{peerKind(t, node.peer)}</span>
              </span>
              <span className="rmap-node__name">{peerName(t, node.peer)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
