// Loads the Argo CD diff and sign-in (src/features/argocd/diff/): a feature is picked up only through its own
// top-level index.ts (src/app/features.ts), and src/features/argocd/index.ts belongs to the Argo CD resources feature.
import "../argocd/diff";
