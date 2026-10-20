// The traffic graph as a table: every call (per source and protocol) with both ends, rate, error rate and latency,
// busiest first — the way to the same facts for the keyboard and screen readers. A row's button opens the call.
import { useTranslation } from "react-i18next";
import type { TrafficEdge } from "../../../api";
import { edgeSentence, errorsText, latencyText, peerName, protocolText, rateText, sourceName } from "./format";
import { edgeId, errorLevel } from "./model";

export function TrafficList({
  edges,
  selectedEdge,
  onEdge,
}: {
  edges: readonly TrafficEdge[];
  selectedEdge: string | null;
  onEdge: (edge: TrafficEdge) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="traffic-table-wrap">
      <table className="traffic-table">
        <caption className="traffic-table__caption">{t("traffic:list.caption", { count: edges.length })}</caption>
        <thead>
          <tr>
            <th scope="col">{t("traffic:fields.from")}</th>
            <th scope="col">{t("traffic:fields.to")}</th>
            <th scope="col">{t("traffic:fields.protocol")}</th>
            <th scope="col">{t("traffic:fields.rate")}</th>
            <th scope="col">{t("traffic:fields.errors")}</th>
            <th scope="col">{t("traffic:fields.latency")}</th>
            <th scope="col">{t("traffic:fields.source")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("traffic:list.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => {
            const id = edgeId(edge);
            return (
              <tr key={id} className={id === selectedEdge ? "traffic-table__row--selected" : undefined}>
                <td>{peerName(t, edge.from)}</td>
                <td>{peerName(t, edge.to)}</td>
                <td>{protocolText(t, edge)}</td>
                <td className="traffic-table__num">{rateText(t, edge)}</td>
                <td className={`traffic-table__num traffic-level--${errorLevel(edge.errorRatio)}`}>{errorsText(t, edge)}</td>
                <td className="traffic-table__num">{latencyText(t, edge)}</td>
                <td>{sourceName(t, edge.source)}</td>
                <td>
                  <button
                    type="button"
                    className="traffic-linkbtn"
                    aria-label={t("traffic:list.show", { edge: edgeSentence(t, edge) })}
                    onClick={() => onEdge(edge)}
                  >
                    {t("traffic:list.details")}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
