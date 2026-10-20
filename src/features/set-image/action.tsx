// The "Set image…" action: the image dialog for a workload or a bare Pod; for a Pod a controller owns (or a static
// Pod's mirror), the dialog that points to where its image is set.
import type { ActionDef, ActionId } from "../actions/registry";
import { registerAction } from "../actions/registry";
import { extendActions } from "../../resources/registry";
import { isMirrorPod, podController, SET_IMAGE_KINDS, setImageKind } from "./model";
import { OwnedPodDialog } from "./OwnedPodDialog";
import { SetImageDialog } from "./SetImageDialog";

export const setImageAction: ActionDef = {
  labelKey: "setimage:action",
  icon: "image",
  appliesTo: (_obj, kind) => setImageKind(kind) !== null,
  run: ({ clusterId, kind, objects, refs, openDialog }) => {
    const obj = objects[0];
    const objectRef = refs[0];
    const setKind = setImageKind(kind);
    if (!obj || !objectRef || !setKind) return;
    const owner = setKind === "Pod" ? podController(obj) : null;
    if (setKind === "Pod" && (owner !== null || isMirrorPod(obj))) {
      openDialog((close) => (
        <OwnedPodDialog
          clusterId={clusterId}
          name={objectRef.name}
          namespace={objectRef.namespace}
          owner={isMirrorPod(obj) ? null : owner}
          close={close}
        />
      ));
      return;
    }
    openDialog((close) => (
      <SetImageDialog clusterId={clusterId} objectRef={objectRef} obj={obj} kind={setKind} close={close} />
    ));
  },
};

/** Registers the action under `id` and offers it on the kinds it changes. Returns a function that removes it again. */
export function registerSetImage(id: ActionId): () => void {
  const removers = [registerAction(id, setImageAction), ...SET_IMAGE_KINDS.map((kind) => extendActions(kind, [id]))];
  return () => removers.forEach((remove) => remove());
}
