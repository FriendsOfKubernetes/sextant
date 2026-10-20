// The layers of the open image, base first: digest, compressed size, entries, the config's `created_by`.
import { useTranslation } from "react-i18next";
import type { ImageLayer } from "../../api";
import { formatBytes } from "../metrics";

export function LayersTable({ layers }: { layers: readonly ImageLayer[] }) {
  const { t } = useTranslation();
  return (
    <table className="imgf-layers" aria-label={t("imagefiles:layers.label")}>
      <thead>
        <tr>
          <th scope="col">{t("imagefiles:layers.index")}</th>
          <th scope="col">{t("imagefiles:layers.digest")}</th>
          <th scope="col">{t("imagefiles:layers.size")}</th>
          <th scope="col">{t("imagefiles:layers.files")}</th>
          <th scope="col">{t("imagefiles:layers.createdBy")}</th>
        </tr>
      </thead>
      <tbody>
        {layers.map((layer, i) => (
          <tr key={`${i}:${layer.digest}`}>
            <td>{i + 1}</td>
            <td className="imgf-mono" title={layer.cached ? t("imagefiles:layers.cached") : undefined}>
              {layer.digest.slice(7, 19)}
            </td>
            <td>{formatBytes(layer.size)}</td>
            <td>{layer.files}</td>
            <td className="imgf-layers__cmd">{layer.createdBy ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
