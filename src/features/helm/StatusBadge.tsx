import { Badge, type BadgeTone } from "../../components";

/** Helm release status ("deployed", "failed", "pending-upgrade", …) as a coloured badge; the text is Helm's. */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={toneOf(status)}>{status}</Badge>;
}

export function toneOf(status: string): BadgeTone {
  if (status === "deployed") return "success";
  if (status === "failed") return "danger";
  if (status.startsWith("pending") || status === "uninstalling") return "warning";
  return "neutral";
}
