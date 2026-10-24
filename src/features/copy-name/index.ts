// "Copy namespace/name" (#229) on every kind: the table's row menu, several selected rows (one name per line) and
// Ctrl+C / ⌘C on a focused table row (ResourceTable). The details panel's header has icon-only buttons after the name
// and after the namespace that copy each alone (#274; `HeaderCopy.tsx`). A namespaced object is copied as
// `namespace/name` ("Copy namespace/name"), a cluster-scoped one as `name` ("Copy name"). The text goes to the
// clipboard through `navigator.clipboard`, like every other copy in the window, and a short confirmation is shown at
// the bottom of the window. Agents and extensions get nothing new.
import { registerDetailsHeaderTool } from "../../layout/details/registry";
import { registerSlot } from "../../layout/slots";
import { extendActionsForAll } from "../../resources/registry";
import { registerAction } from "../actions/registry";
import { CopyToast } from "./CopyToast";
import { CopyNameButton, CopyNamespaceButton } from "./HeaderCopy";
import { copyNames } from "./clipboard";
import "./copyName.css";

const named = (obj: { metadata?: { name?: string } }) => Boolean(obj.metadata?.name);

registerAction("copyNamespacedName", {
  placement: "more",
  // The details panel's header has its own copy buttons (#274); the table's row menu keeps this one.
  inDetails: false,
  labelKey: "copyname:action",
  icon: "copy",
  multiple: true,
  appliesTo: (obj) => named(obj) && Boolean(obj.metadata?.namespace),
  run: ({ refs }) => copyNames(refs),
});
registerAction("copyName", {
  placement: "more",
  // The details panel's header has its own copy buttons (#274); the table's row menu keeps this one.
  inDetails: false,
  labelKey: "copyname:actionClusterScoped",
  icon: "copy",
  multiple: true,
  appliesTo: (obj) => named(obj) && !obj.metadata?.namespace,
  run: ({ refs }) => copyNames(refs),
});
extendActionsForAll(["copyNamespacedName", "copyName"]);

registerDetailsHeaderTool({ id: "copyName", place: "name", order: 0, Component: CopyNameButton });
registerDetailsHeaderTool({ id: "copyNamespace", place: "namespace", order: 0, Component: CopyNamespaceButton });

// After the other hosts of the rail footer (views 1001, kubeconfig credentials 1001): draws only the live region.
registerSlot("railFooter", CopyToast, 1002);

export { copyNames, copyText } from "./clipboard";
export { nameOf, namesText } from "./model";
