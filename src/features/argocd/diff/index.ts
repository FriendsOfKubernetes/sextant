// Argo CD diff (task 04): the `argoDiff` action of an Application opens desired ↔ live of its resources, signing in
// to the Argo CD API first when needed. Loaded by src/features/argocd-diff/index.ts (features are picked up only by
// their top-level index.ts, and src/features/argocd/index.ts belongs to the Argo CD resources feature).
import { createElement } from "react";
import { registerAction } from "../../actions/registry";
import { ArgoDiffDialog } from "./ArgoDiffDialog";
import "./diff.css";

registerAction("argoDiff", {
  labelKey: "argocd:diff.action",
  icon: "±",
  appliesTo: (_obj, kind) => kind.group === "argoproj.io" && kind.kind === "Application",
  run: ({ clusterId, refs, openDialog }) => {
    const app = refs[0];
    if (!app) return;
    openDialog((close) => createElement(ArgoDiffDialog, { clusterId, app, close }));
  },
});

export { ArgoDiffDialog, type ArgoDiffDialogProps } from "./ArgoDiffDialog";
export { LoginForm, type LoginFormProps } from "./LoginForm";
export { DiffView } from "./DiffView";
export { canonical, loginErrorKey, sidesOf, stateOf, yamlOf, type DiffSides, type DiffState } from "./model";
