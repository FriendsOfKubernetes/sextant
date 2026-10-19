// Verbs × resources of a set of grants (`buildMatrix`): a marked cell is allowed, a half-marked one only for some
// named objects. Hovering a cell names the bindings that allow it; clicking it lists the grants below the table
// (binding, role, where, through which subject entry, the rule and what its wildcards mean).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatList } from "../../i18n/format";
import { buildMatrix, type ClusterScoped, type Grant, type MatrixCell } from "./engine";
import { GrantList, groupText, refText } from "./ui";
import { ResizableTable } from "../../components/Table";

interface Selected {
  row: string;
  verb: string;
}

export function PermissionMatrix({
  grants,
  showSource = true,
  label,
  clusterScoped,
}: {
  grants: readonly Grant[];
  showSource?: boolean;
  label: string;
  /** From discovery: rows of cluster-scoped resources take no grant of a RoleBinding. */
  clusterScoped?: ClusterScoped;
}) {
  const { t } = useTranslation();
  const matrix = useMemo(() => buildMatrix(grants, clusterScoped), [grants, clusterScoped]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Selected | null>(null);
  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? matrix.rows.filter((r) => r.resource.toLowerCase().includes(needle) || r.group.toLowerCase().includes(needle))
    : matrix.rows;
  const urls = needle ? matrix.urls.filter((u) => u.url.toLowerCase().includes(needle)) : matrix.urls;

  if (matrix.rows.length === 0 && matrix.urls.length === 0) {
    return <p className="dt-muted">{t("rbac:matrix.empty")}</p>;
  }

  const verbHeader = (verb: string) => (verb === "*" ? t("rbac:matrix.anyVerb") : verb);
  const resourceText = (resource: string) => (resource === "*" ? t("rbac:matrix.allResources") : resource);
  const groupLabel = (group: string) => (group === "*" ? t("rbac:matrix.allGroups") : groupText(t, group));

  const cellButton = (rowKey: string, rowLabel: string, verb: string, cells: MatrixCell[] | undefined) => {
    if (!cells || cells.length === 0) return <td key={verb} className="rbac-matrix__cell" />;
    const partial = cells.every((c) => c.onlyNames);
    const isSelected = selected?.row === rowKey && selected.verb === verb;
    const bindings = [...new Set(cells.map((c) => (c.grant.binding.name ? refText(t, c.grant.binding) : "")))].filter(Boolean);
    const title = showSource
      ? t("rbac:matrix.cellTitle", { count: cells.length, bindings: formatList(bindings) })
      : t("rbac:matrix.cellTitleReview", { count: cells.length });
    const name = t(partial ? "rbac:matrix.cellPartial" : "rbac:matrix.cellAllowed", { verb, resource: rowLabel });
    return (
      <td key={verb} className="rbac-matrix__cell">
        <button
          type="button"
          className={`rbac-matrix__mark${partial ? " rbac-matrix__mark--partial" : ""}${isSelected ? " rbac-matrix__mark--selected" : ""}`}
          title={title}
          aria-label={name}
          aria-pressed={isSelected}
          onClick={() => setSelected(isSelected ? null : { row: rowKey, verb })}
        />
      </td>
    );
  };

  const selectedCells = (() => {
    if (!selected) return null;
    const row = matrix.rows.find((r) => r.key === selected.row);
    if (row) return { cells: row.cells.get(selected.verb) ?? [], resource: resourceText(row.resource), group: row.group };
    const url = matrix.urls.find((u) => `url:${u.url}` === selected.row);
    return url ? { cells: url.cells.get(selected.verb) ?? [], resource: url.url, group: null } : null;
  })();

  return (
    <div className="rbac-matrix">
      <input
        type="search"
        className="rbac-input rbac-matrix__filter"
        value={filter}
        placeholder={t("rbac:matrix.filter")}
        aria-label={t("rbac:matrix.filter")}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="rbac-matrix__scroll">
        <ResizableTable tableId="rbac.matrix" className="rbac-matrix__table" aria-label={label}>
          <thead>
            <tr>
              <th scope="col" data-col="resource">
                {t("rbac:matrix.resource")}
              </th>
              <th scope="col" data-col="group">
                {t("rbac:matrix.group")}
              </th>
              {matrix.verbs.map((v) => (
                <th key={v} scope="col" className="rbac-matrix__verb" data-col={`verb-${v}`}>
                  {verbHeader(v)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className="rbac-matrix__resource">
                  {resourceText(row.resource)}
                </th>
                <td className="rbac-matrix__group">{groupLabel(row.group)}</td>
                {matrix.verbs.map((verb) => cellButton(row.key, resourceText(row.resource), verb, row.cells.get(verb)))}
              </tr>
            ))}
            {urls.length > 0 && (
              <tr>
                <th scope="colgroup" colSpan={matrix.verbs.length + 2} className="rbac-matrix__section">
                  {t("rbac:matrix.urls")}
                </th>
              </tr>
            )}
            {urls.map((u) => (
              <tr key={`url:${u.url}`}>
                <th scope="row" className="rbac-matrix__resource">
                  {u.url === "*" ? t("rbac:matrix.allUrls") : u.url}
                </th>
                <td />
                {matrix.verbs.map((verb) => cellButton(`url:${u.url}`, u.url, verb, u.cells.get(verb)))}
              </tr>
            ))}
          </tbody>
        </ResizableTable>
      </div>
      {matrix.truncated && <p className="dt-muted">{t("rbac:matrix.truncated", { count: matrix.rows.length })}</p>}
      {selectedCells && selected && (
        <div className="rbac-matrix__detail" role="region" aria-label={t("rbac:matrix.detail", { verb: verbHeader(selected.verb), resource: selectedCells.resource })}>
          <h4 className="rbac-matrix__detail-title">
            {t("rbac:matrix.detail", { verb: verbHeader(selected.verb), resource: selectedCells.resource })}
          </h4>
          <GrantList
            grants={selectedCells.cells.map((c) => c.grant)}
            onlyNames={(g) => selectedCells.cells.find((c) => c.grant === g)?.onlyNames}
            showSource={showSource}
          />
        </div>
      )}
    </div>
  );
}
