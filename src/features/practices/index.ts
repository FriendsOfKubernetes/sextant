// Best-practice checks (#207), read-only and frontend only: the everyday mistakes that make workloads fragile
// (no probes, mutable images, one replica, no or a blocking PodDisruptionBudget, every replica on one node) or wasteful
// (no requests, no memory limit, limits far above the right-sizing recommendation, an HPA that cannot scale), checked
// locally on the pod templates of workloads and on what surrounds them (checks.ts), each finding with why it matters,
// its exact field and a fix to copy:
// - the "Best practices" page of the Cluster section, right after Security: like the security posture it is a view
//   across workloads and namespaces, bounded by the namespace filter (PracticesPage.tsx);
// - the "Best practices" section of workload details (PracticesSection.tsx);
// - the opt-in problems category `practices` (off by default, like `security`), fed by taps on the problems store's
//   shared watches (provider.ts);
// - per-check toggles and excluded namespaces in `AppSettings.practices` (config.ts, SettingsDialog.tsx).
import { registerDetailsSection } from "../../layout/details/registry";
import { registerPage } from "../../layout/pages";
import { PracticesPage, PRACTICES_PAGE_ID } from "./PracticesPage";
import { practicesApplies, PracticesSection } from "./PracticesSection";
import "./provider";

// After Security (30): both judge the pod templates of workloads across namespaces.
registerPage({
  id: PRACTICES_PAGE_ID,
  section: "cluster",
  order: 32,
  labelKey: "practices:sidebar",
  icon: "bestPractices",
  Component: PracticesPage,
});

// After Security (57).
registerDetailsSection({ id: "practices", order: 58, appliesTo: practicesApplies, Component: PracticesSection });

export { evaluate, evaluateAll } from "./checks";
export { PRACTICES_PAGE_ID } from "./PracticesPage";
