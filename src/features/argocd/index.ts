// Argo CD (task 03): the sidebar section with Applications, ApplicationSets and AppProjects — columns, details (with
// the resource tree and the sync history of an Application) and the actions Sync, Refresh, Hard refresh, Terminate
// and "Open Argo CD UI". Everything goes through the Kubernetes API; the section shows only where Argo CD is
// installed (its kinds are in discovery). The diff (`argoDiff`) is registered by ./diff.
import "./argocd.css";
import "./kinds";
import "./register";

export { APP_PROJECT, APPLICATION, APPLICATION_SET, isApplication } from "./model";
export {
  ARGOCD_SERVER,
  ARGOCD_SERVER_SELECTOR,
  DEFAULT_ARGOCD_NAMESPACE,
  argocdNamespace,
  findArgocdServer,
  openArgoUi,
} from "./server";
