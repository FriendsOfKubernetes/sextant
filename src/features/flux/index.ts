// Flux (task 02): the sidebar section "Flux" — sources, Kustomizations, HelmReleases, image automation and
// notifications, read from the cluster's Flux CRDs; the section shows only the kinds the cluster serves.
import "./actions";
import "./register";

export { fluxColumns } from "./columns";
export { FLUX_KINDS, fluxKind, inventoryOf, revisionOf, sourceRefOf, type FluxKind, type FluxRef } from "./model";
