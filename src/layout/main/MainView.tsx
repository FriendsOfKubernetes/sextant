// Placeholder main view of the skeleton: renders the open registered page. The resource-tables stage replaces
// this file (resource tables, namespace filter, header).
import { useTranslation } from "react-i18next";
import type { ClusterId } from "../../api";
import { useClusterView } from "../../app/store";
import { EmptyState } from "../../components";
import { getPage, getPages } from "../pages";

export function MainView({ clusterId }: { clusterId: ClusterId }) {
  const { t } = useTranslation();
  const { view } = useClusterView(clusterId);
  const page = view ? getPage(view) : undefined;
  if (page) return <page.Component clusterId={clusterId} />;
  return <EmptyState title={t(getPages().length > 0 ? "common:main.selectSection" : "common:main.noSections")} />;
}
