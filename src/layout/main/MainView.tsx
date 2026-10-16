// The main area of a cluster: the open page (`registerPage`) or the live table of the open kind, with the
// namespace filter and the search box in the table header. With no section chosen yet it opens the first page of
// the "cluster" section (the overview), if one is registered; so does a page of an extension that was disabled or
// removed meanwhile.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, ResourceKind } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { Checkbox, EmptyState, ErrorState } from "../../components";
import { LoadingTable, ResourceTable } from "../../components/Table";
import { NamespaceFilter, useSelectedNamespaces } from "../../features/namespaces";
import {
  findKind,
  findResourceDef,
  parseViewId,
  useClusterKinds,
  useCrdPrinterColumns,
  useResourceDef,
} from "../../resources";
import { getPage, getPages, usePagesVersion } from "../pages";
import { ActionDialogHost } from "./ActionDialogHost";
import "./main.css";

export function MainView({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { view } = useClusterView(clusterId);
  usePagesVersion();
  // Sextant's own first page of the cluster section; never an extension's, whatever its order.
  const overview = getPages("cluster").find((p) => !p.id.startsWith("ext:"))?.id ?? null;
  // An extension's page (`ext:<id>:<page>`) that is gone falls back to the overview.
  const current = view && !(view.startsWith("ext:") && !getPage(view)) ? view : overview;
  const page = current ? getPage(current) : undefined;
  const kind = parseViewId(current);

  let content;
  if (page) content = <page.Component clusterId={clusterId} />;
  else if (kind) content = <KindView key={current} clusterId={clusterId} group={kind.group} kind={kind.kind} />;
  else content = <EmptyState title={t("common:main.selectSection")} />;

  return (
    <>
      {content}
      <ActionDialogHost />
    </>
  );
}

/**
 * Resolves the version of the kind (built-in description, else discovery) and shows its table. The title and a
 * loading indicator show at once, also while a custom kind waits for discovery; the indicator counts from here.
 */
function KindView({ clusterId, group, kind }: { clusterId: ClusterId; group: string; kind: string }) {
  const { t } = useTranslation();
  const [openedAt] = useState(() => Date.now());
  const { kinds, error } = useClusterKinds(clusterId);
  const discovered = findKind(kinds, { group, kind }) ?? null;
  const registered = findResourceDef({ group, kind });

  if (!registered && !discovered) {
    if (error) return <ErrorState error={error} />;
    if (kinds) return <EmptyState title={t("resources:table.unknownKind", { kind })} />;
    return <LoadingTable title={kind} since={openedAt} />;
  }
  // Built-in kinds use their GA version right away; custom resources the version the cluster prefers.
  const version = registered?.kind.version ?? discovered?.kindRef.version ?? "";
  return (
    <KindTable
      // A table of another kind or cluster starts with its own state ("Only problems" off).
      key={`${clusterId}/${group}/${kind}`}
      clusterId={clusterId}
      kind={{ group, version, kind }}
      resourceKind={discovered}
      custom={!registered}
      openedAt={openedAt}
    />
  );
}

function KindTable({
  clusterId,
  kind,
  resourceKind,
  custom,
  openedAt,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  resourceKind: ResourceKind | null;
  /** A custom resource: its printer columns come from its CRD. */
  custom: boolean;
  openedAt: number;
}) {
  const { t } = useTranslation();
  const columns = useCrdPrinterColumns(clusterId, custom ? resourceKind : null);
  const withColumns = useMemo(
    () => (resourceKind && columns ? { ...resourceKind, printerColumns: columns } : resourceKind),
    [resourceKind, columns],
  );
  const def = useResourceDef(kind, withColumns);
  const namespaces = useSelectedNamespaces(clusterId);
  const search = useClusterView(clusterId).search;
  const setSearch = useAppStore((s) => s.setSearch);
  const namespaced = resourceKind?.namespaced ?? def.namespaced ?? true;
  const title = def.sidebar ? t(def.sidebar.labelKey) : (def.title ?? kind.kind);
  // Kinds that say what a problem is offer "Only problems".
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rowFilter = onlyProblems ? def.problem : undefined;

  if (namespaces === undefined) return <LoadingTable title={title} since={openedAt} />;
  return (
    <ResourceTable
      clusterId={clusterId}
      kind={kind}
      resourceKind={withColumns}
      loadingSince={openedAt}
      namespaces={namespaces}
      search={search}
      rowFilter={rowFilter}
      toolbar={
        <>
          {def.problem && (
            <label className="main__filter">
              <Checkbox checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              {t("resources:table.onlyProblems")}
            </label>
          )}
          {namespaced && <NamespaceFilter clusterId={clusterId} />}
          <input
            className="main__search"
            type="search"
            value={search}
            placeholder={t("resources:table.searchPlaceholder")}
            aria-label={t("resources:table.search")}
            onChange={(e) => setSearch(clusterId, e.target.value)}
          />
        </>
      }
    />
  );
}
