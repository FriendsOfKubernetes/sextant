// "Set image…" (#215): change the images of some containers of a Deployment, StatefulSet, DaemonSet, CronJob or bare
// Pod, as `kubectl set image` does — one strategic-merge patch of the image fields only, built and sent by the core
// (`workload_set_image`), after the server's dry run when the cluster asks for previews (safe apply, #141). A Pod a
// controller owns gets its owner offered instead. Agents already have `patch_resource`; extensions get nothing new.
import { registerSetImage } from "./action";
import "./setImage.css";

registerSetImage("setImage");

export { registerSetImage, setImageAction } from "./action";
export { checkImage, type ImageCheck, type ImageError, type ImageWarning } from "./reference";
export { SetImageDialog, type SetImageDialogProps } from "./SetImageDialog";
