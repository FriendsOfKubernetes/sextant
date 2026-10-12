// Registrations of the Argo CD section besides the kinds (kinds.tsx): the details sections of an Application and
// the actions.
import { registerDetailsSection } from "../../layout/details/registry";
import { isApplication } from "./model";
import { ResourceTreeSection } from "./ResourceTree";
import { SyncHistorySection } from "./SyncHistory";

// After the generic conditions (30), before port forwarding (40).
registerDetailsSection({ id: "argocdResources", order: 35, appliesTo: isApplication, Component: ResourceTreeSection });
registerDetailsSection({ id: "argocdHistory", order: 36, appliesTo: isApplication, Component: SyncHistorySection });

import "./actions";
