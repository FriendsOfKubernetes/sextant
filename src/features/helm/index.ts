// Helm (task 10): the Charts and Releases pages of the sidebar's Helm section. Releases are read natively from
// the cluster; changes and chart installation go through the `helm` binary, and are disabled without it.
import { registerPage } from "../../layout/pages";
import { ChartsPage } from "./ChartsPage";
import { ReleasesPage } from "./ReleasesPage";

export const HELM_CHARTS_PAGE = "helm-charts";
export const HELM_RELEASES_PAGE = "helm-releases";

registerPage({ id: HELM_CHARTS_PAGE, section: "helm", order: 10, labelKey: "helm:sidebar.charts", Component: ChartsPage });
registerPage({
  id: HELM_RELEASES_PAGE,
  section: "helm",
  order: 20,
  labelKey: "helm:sidebar.releases",
  Component: ReleasesPage,
});

export { ChartsPage } from "./ChartsPage";
export { HELM_INSTALL_URL, HelmMissing } from "./HelmMissing";
export { isValidReleaseName } from "./dialogs";
export {
  RELEASE_SECRET_KIND,
  refreshHelmStatus,
  releaseSecretsSpec,
  resetHelmStatus,
  useHelmReleases,
  useHelmStatus,
  type ReleasesState,
} from "./hooks";
export { ReleasesPage } from "./ReleasesPage";
