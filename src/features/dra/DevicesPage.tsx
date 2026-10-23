// "Devices" (Dynamic Resource Allocation section, #244): every device the cluster's ResourceSlices publish (at most
// `MAX_SLICES` slices), by node, with the claim that holds each one, and the totals. Read-only.
import { useTranslation } from "react-i18next";
import { LoadingIndicator } from "../../components";
import type { PageProps } from "../../layout/pages";
import { allocationIndex, MAX_SLICES, useAllClaims, useSlices } from "./hooks";
import { deviceKey, sliceDevicesOf, sliceDriver, slicePool } from "./model";
import { DevicesTable } from "./ui";

/** Device rows drawn at most. */
export const MAX_SHOWN = 1000;
const PAGE_TABLE = "draDevicesPage";

export function DevicesPage({ clusterId }: PageProps) {
  const { t } = useTranslation();
  const slices = useSlices(clusterId, null);
  const claims = useAllClaims(clusterId, true);
  const allocation = claims.loading || claims.unavailable || claims.truncated ? undefined : allocationIndex(claims.items);
  let devices = 0;
  let allocated = 0;
  for (const slice of slices.items) {
    for (const d of sliceDevicesOf(slice)) {
      devices++;
      if (allocation?.has(deviceKey({ driver: sliceDriver(slice), pool: slicePool(slice), device: d.name }))) allocated++;
    }
  }
  return (
    <div className="dra-page">
      <h2 className="dra-page__title">{t("dra:page.title")}</h2>
      <p className="dra-muted">{t("dra:page.hint")}</p>
      {slices.loading && <LoadingIndicator text={t("dra:loading")} />}
      {!slices.loading && (
        <p className="dra-muted" role="status">
          {allocation ? t("dra:page.totals", { count: devices, allocated }) : t("dra:page.total", { count: devices })}
        </p>
      )}
      {slices.truncated && <p className="dra-muted">{t("dra:page.slicesTruncated", { count: MAX_SLICES })}</p>}
      {!slices.loading && allocation === undefined && !claims.loading && <p className="dra-muted">{t("dra:page.claimsUnknown")}</p>}
      {!slices.loading && <DevicesTable slices={slices.items} allocation={allocation} id={PAGE_TABLE} max={MAX_SHOWN} />}
    </div>
  );
}
