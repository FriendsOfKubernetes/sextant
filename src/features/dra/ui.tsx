// Pieces the DRA views share: the requests of a claim (classes, CEL selectors as text, counts, the choices of
// firstAvailable), the devices of slices with the claims that hold them, and the scheduler's DRA reasons in words.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { chips, KINDS, link, table, type ColumnWrap } from "../details";
import type { Allocation } from "./hooks";
import { deviceKey, productOf, sliceDevicesOf, sliceDriver, slicePool, sliceScope, type DraReason, type Request } from "./model";

/** CEL expressions, each on its own line, as written: Sextant never evaluates them. */
export function Cel({ expressions }: { expressions: readonly string[] }) {
  if (expressions.length === 0) return null;
  return (
    <div className="dra-cel">
      {expressions.map((e, i) => (
        <code key={i} className="dra-cel__expr">
          {e}
        </code>
      ))}
    </div>
  );
}

const REQUEST_WRAP: ColumnWrap[] = ["nowrap", "nowrap", undefined, "nowrap"];

/** The requests of a claim spec; a firstAvailable request lists its choices in order. */
export function RequestsTable({ requests, apiVersion, id }: { requests: readonly Request[]; apiVersion: string; id: string }) {
  const { t } = useTranslation();
  const classType = { apiVersion, kind: "DeviceClass" };
  const rows: ReactNode[][] = requests.flatMap((r) =>
    r.alternatives.map((a, i) => {
      const name = r.firstAvailable ? t("dra:requests.choice", { request: r.name, choice: a.name ?? "", n: i + 1 }) : r.name;
      const amount = a.allocationMode === "All" ? t("dra:requests.all") : t("dra:requests.count", { count: a.count });
      return [
        name,
        link(classType, a.deviceClassName),
        <Cel key="cel" expressions={a.selectors} />,
        a.adminAccess ? t("dra:requests.withAdminAccess", { amount }) : amount,
      ];
    }),
  );
  if (rows.length === 0) return <p className="dra-muted">{t("dra:requests.none")}</p>;
  return <>{table(id, [t("dra:requests.request"), t("dra:requests.class"), t("dra:requests.selectors"), t("dra:requests.amount")], rows, REQUEST_WRAP)}</>;
}

const DEVICE_WRAP: ColumnWrap[] = ["nowrap", undefined, "nowrap", undefined, undefined, undefined];

/**
 * The devices of `slices`, one row each, with the claim(s) that hold them from `allocation` (`undefined`: not known —
 * the claims could not be read in full). `max` rows at most.
 */
export function DevicesTable({
  slices,
  allocation,
  id,
  max,
}: {
  slices: readonly KubeObject[];
  allocation: Map<string, Allocation[]> | undefined;
  id: string;
  max: number;
}) {
  const { t } = useTranslation();
  const rows: ReactNode[][] = [];
  let total = 0;
  const sorted = [...slices].sort((a, b) => {
    const na = sliceScope(a);
    const nb = sliceScope(b);
    const ka = na.type === "node" ? na.node : `~${na.type}`;
    const kb = nb.type === "node" ? nb.node : `~${nb.type}`;
    return ka.localeCompare(kb) || sliceDriver(a).localeCompare(sliceDriver(b)) || (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? "");
  });
  for (const slice of sorted) {
    const scope = sliceScope(slice);
    const driver = sliceDriver(slice);
    const pool = slicePool(slice);
    for (const device of sliceDevicesOf(slice)) {
      total++;
      if (rows.length >= max) continue;
      const node = device.node ?? (scope.type === "node" ? scope.node : undefined);
      const holders = allocation?.get(deviceKey({ driver, pool, device: device.name })) ?? [];
      const held: ReactNode =
        allocation === undefined
          ? t("dra:devices.unknown")
          : holders.length === 0
            ? t("dra:devices.free")
            : holders.map((h) => link({ apiVersion: h.apiVersion, kind: "ResourceClaim" }, h.claim, h.namespace, `${h.namespace}/${h.claim}`));
      rows.push([
        node ? link(KINDS.node, node) : t(`dra:scope.${scope.type}`),
        driver,
        `${pool} / ${device.name}`,
        productOf(device) ?? "",
        chips(device.capacity.map(([k, v]) => `${k}=${v}`)),
        held,
      ]);
    }
  }
  if (total === 0) return <p className="dra-muted">{t("dra:devices.none")}</p>;
  return (
    <>
      {table(
        id,
        [t("dra:devices.node"), t("dra:devices.driver"), t("dra:devices.device"), t("dra:devices.product"), t("dra:devices.capacity"), t("dra:devices.allocatedTo")],
        rows,
        DEVICE_WRAP,
      )}
      {total > rows.length && <p className="dra-muted">{t("dra:devices.cut", { count: rows.length, total })}</p>}
    </>
  );
}

/** The scheduler's DRA reasons in words, one line each. */
export function DraReasons({ reasons }: { reasons: readonly DraReason[] }) {
  const { t } = useTranslation();
  if (reasons.length === 0) return null;
  return (
    <>
      {reasons.map((r) => (
        <p key={r} className="dra-note">
          {t(`dra:reason.${r}`)}
        </p>
      ))}
    </>
  );
}

/** A list joined in the UI language. */
export const joined = (values: readonly string[]): string => formatList(values);
