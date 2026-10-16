// The "Hostnames" tab of the request check: every hostname served through the Gateways' HTTP/HTTPS listeners →
// Gateway/listener (port, protocol) → route (accepted there or not) → backends (`hostnameMap`), routes that claim the
// same hostname with an identical match highlighted with the one that gets the traffic. A namespace filter keeps the
// routes of one namespace; clicking a row checks a request to its hostname on the "Request" tab.
import { useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { StatusText } from "../../resources";
import type { CheckData } from "./checkData";
import { breakable, gatewayRef, LoadingLine, refLink } from "./details";
import { hostnameMap, type HostnameConflict, type HostnameRow, type NamespacedName, type RouteId } from "./matching";
import { backendText, GATEWAY_GROUP } from "./model";

const fullName = (n: NamespacedName) => (n.namespace ? `${n.namespace}/${n.name}` : n.name);

const routeLink = (r: RouteId) => refLink({ group: GATEWAY_GROUP, kind: r.kind, name: r.name, namespace: r.namespace }, fullName(r));

const rowKey = (r: HostnameRow) =>
  `${r.hostname ?? "*"}|${fullName(r.gateway)}|${r.listener}|${r.route.kind}|${fullName(r.route)}`;

/** A conflict highlighted, a route the listener refused marked broken. */
function rowClassName(row: HostnameRow): string {
  const classes = ["gw-hosts__row"];
  if (row.conflicts.length > 0) classes.push("gw-row--conflict");
  if (!row.accepted) classes.push("gw-row--broken");
  return classes.join(" ");
}

function ConflictLine({ conflict }: { conflict: HostnameConflict }) {
  const { t } = useTranslation();
  const params = { route: fullName(conflict.with), rule: t("gateway:check.candidateRule", { n: conflict.withRule + 1 }) };
  return (
    <li className={conflict.wins ? "gw-hosts__conflict gw-hosts__conflict--wins" : "gw-hosts__conflict"}>
      <StatusText
        value={t(conflict.wins ? "gateway:hostnames.conflictWins" : "gateway:hostnames.conflictLoses", params)}
        tone={conflict.wins ? "success" : "warning"}
      />
    </li>
  );
}

export function HostnameMap({ data, onCheck }: { data: CheckData; onCheck: (row: HostnameRow) => void }) {
  const { t } = useTranslation();
  const { snapshot, loading } = data;
  const rows = useMemo(() => hostnameMap(snapshot.gateways, snapshot), [snapshot]);
  const [namespace, setNamespace] = useState("");
  const namespaces = [...new Set(rows.map((r) => r.route.namespace ?? ""))].sort();
  const shown = namespace ? rows.filter((r) => (r.route.namespace ?? "") === namespace) : rows;
  const conflicted = shown.filter((r) => r.conflicts.length > 0).length;
  const anyHost = t("gateway:hostnames.anyHost");

  const onRowClick = (row: HostnameRow) => (e: MouseEvent) => {
    // Links open details; the hostname button checks by itself.
    if ((e.target as HTMLElement).closest("button, a, select, input")) return;
    onCheck(row);
  };

  return (
    <div className="gw-hosts">
      <div className="gw-hosts__toolbar">
        <label className="gw-check__field">
          <span className="gw-check__label">{t("gateway:hostnames.namespace")}</span>
          <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
            <option value="">{t("gateway:hostnames.allNamespaces")}</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </label>
        {conflicted > 0 && <StatusText value={t("gateway:hostnames.conflictCount", { count: conflicted })} tone="warning" />}
      </div>
      {shown.length > 0 && (
        <table className="dt-table gw-table gw-hosts__table" aria-label={t("gateway:hostnames.label")}>
          <thead>
            <tr>
              <th>{t("gateway:hostnames.hostname")}</th>
              <th>{t("gateway:hostnames.gateway")}</th>
              <th>{t("gateway:hostnames.route")}</th>
              <th>{t("gateway:hostnames.backends")}</th>
              <th>{t("gateway:hostnames.conflicts")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const host = row.hostname ?? anyHost;
              const className = rowClassName(row);
              return (
                <tr key={rowKey(row)} className={className} data-conflict={row.conflicts.length > 0 || undefined} onClick={onRowClick(row)}>
                  <td>
                    <button
                      type="button"
                      className="rt-link gw-hosts__host"
                      title={t("gateway:hostnames.check", { host })}
                      onClick={() => onCheck(row)}
                    >
                      {breakable(host)}
                    </button>
                  </td>
                  <td>
                    {refLink(gatewayRef(row.gateway.name, row.gateway.namespace), fullName(row.gateway))}
                    <span className="dt-muted">{` / ${row.listener} (${row.port ?? ""}/${row.protocol})`}</span>
                  </td>
                  <td>
                    <span className="dt-muted">{`${row.route.kind} `}</span>
                    {routeLink(row.route)}{" "}
                    <StatusText
                      value={
                        row.accepted
                          ? t("gateway:hostnames.accepted")
                          : [t("gateway:hostnames.notAccepted"), row.condition].filter(Boolean).join(": ")
                      }
                      tone={row.accepted ? "success" : "danger"}
                    />
                  </td>
                  <td>
                    <span className="dt-links">
                      {row.backends.map((b) =>
                        b.group === "" && b.kind === "Service" ? refLink(b, backendText(b, row.route.namespace)) : backendText(b, row.route.namespace),
                      )}
                    </span>
                  </td>
                  <td>
                    {row.conflicts.length > 0 && (
                      <ul className="gw-hosts__conflicts">
                        {row.conflicts.map((c, i) => (
                          <ConflictLine key={i} conflict={c} />
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {loading ? (
        <LoadingLine text={t("gateway:hostnames.loading")} />
      ) : (
        shown.length === 0 && <p className="dt-muted">{t("gateway:hostnames.none")}</p>
      )}
    </div>
  );
}
