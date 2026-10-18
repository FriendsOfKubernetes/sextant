// Safe apply (#141): before a change is sent, the API server's dry run of it (`dryRun=All`, Sextant's field manager)
// is shown next to the live object — the editor's Save and Apply YAML (`resource_dry_run`), a Helm upgrade or install
// (`helm_*_preview`, the release's manifest against the rendered one). Per cluster, "Preview changes before applying"
// makes the preview a step of every such change (on by default for production-looking names); off, it stays one
// button away. Nothing here changes a cluster: the change itself is still the editor's or the dialog's own call.
import { registerClusterSettingsSection } from "../clusters/settingsRegistry";
import { PreviewSection } from "./PreviewSection";
import "./safeApply.css";

registerClusterSettingsSection({
  id: "safeApply",
  order: 35,
  titleKey: "safeapply:section.title",
  Component: PreviewSection,
});

export { ChangePreview, describeObject } from "./ChangePreview";
export { HelmPreview, useHelmPreview, type HelmPreviewState } from "./HelmPreview";
export { previewByDefault, previewsChanges, useAlwaysPreview } from "./policy";
export { refusalsOf, type Refusals } from "./refusals";
