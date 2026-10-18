// Upgrade readiness (#142): the page "Upgrade readiness" of the sidebar section "Cluster" — which API versions in use
// are deprecated or removed in a chosen target Kubernetes version, where each use comes from (live objects, Helm
// releases, Argo CD, Flux), the deprecated API versions the cluster still serves, and version skew. Read-only: the
// backend scan (`api.upgrade.scan`, a window command only) lists and reads, never writes; the built-in table of
// deprecations is `deprecations.json` (see `table.ts`). Neither agents (MCP) nor extensions get a new call from it.
import { registerPage } from "../../layout/pages";
import { UPGRADE_PAGE } from "./state";
import { UpgradePage } from "./UpgradePage";

registerPage({
  id: UPGRADE_PAGE,
  section: "cluster",
  order: 30,
  labelKey: "upgrade:sidebar",
  icon: "upgradeReadiness",
  Component: UpgradePage,
});

export { UPGRADE_PAGE } from "./state";
export { UpgradePage } from "./UpgradePage";
