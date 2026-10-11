// The main area of a cluster: the open page (`registerPage`) or the live table of the open kind, with the
// namespace filter and the search box in the table header. With no section chosen yet it opens the first page of
// the "cluster" section (the overview), if one is registered.
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef } from "../../api";
import { useAppStore, useClusterView } from "../../app/store";
import { EmptyState, ErrorState } from "../../components";
import { ResourceTable } from "../../components/Table";
import { NamespaceFilter, useSelectedNamespaces } from "../../features/namespaces";
import { findKind, findResourceDef, parseViewId, useClusterKinds, useResourceDef } from "../../resources";
import { getPage, getPages } from "../pages";
import { ActionDialogHost } from "./ActionDialogHost";
import "./main.css";

export function MainView({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { view } = useClusterView(clusterId);
  const current = view ?? getPages("cluster")[0]?.id ?? null;
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

/** Resolves the version of the kind (built-in description, else discovery) and shows its table. */
function KindView({ clusterId, group, kind }: { clusterId: ClusterId; group: string; kind: string }) {
  const { t } = useTranslation();
  const { kinds, error } = useClusterKinds(clusterId);
  const discovered = findKind(kinds, { group, kind }) ?? null;
  const registered = findResourceDef({ group, kind });

  if (!registered && !discovered) {
    if (error) return <ErrorState error={error} />;
    if (kinds) return <EmptyState title={t("resources:table.unknownKind", { kind })} />;
    return (
      <div className="rt__loading" role="status">
        {t("resources:table.loading")}
      </div>
    );
  }
  // Built-in kinds use their GA version right away; custom resources the version the cluster prefers.
  const version = registered?.kind.version ?? discovered?.kindRef.version ?? "";
  return <KindTable clusterId={clusterId} kind={{ group, version, kind }} resourceKind={discovered} />;
}

function KindTable({
  clusterId,
  kind,
  resourceKind,
}: {
  clusterId: ClusterId;
  kind: KindRef;
  resourceKind: ReturnType<typeof findKind> | null;
}) {
  const { t } = useTranslation();
  const def = useResourceDef(kind, resourceKind);
  const namespaces = useSelectedNamespaces(clusterId);
  const search = useClusterView(clusterId).search;
  const setSearch = useAppStore((s) => s.setSearch);
  const namespaced = resourceKind?.namespaced ?? def.namespaced ?? true;

  if (namespaces === undefined) {
    return (
      <div className="rt__loading" role="status">
        {t("resources:table.loading")}
      </div>
    );
  }
  return (
    <ResourceTable
      clusterId={clusterId}
      kind={kind}
      resourceKind={resourceKind}
      namespaces={namespaces}
      search={search}
      toolbar={
        <>
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
