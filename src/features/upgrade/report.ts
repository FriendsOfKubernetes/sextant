// Texts of upgrade-readiness findings and the report the page copies (#142): Markdown for a ticket or a chat, CSV for
// a spreadsheet. Built outside JSX from the translated texts of `upgrade.json`.
import type { TFunction } from "i18next";
import type { UsageOrigin } from "../../api";
import { formatList } from "../../i18n/format";
import type { Finding, FindingStatus, ServedFinding } from "./evaluate";
import type { SkewIssue } from "./skew";
import { minorText, type Minor } from "./table";

export function originText(t: TFunction, origin: UsageOrigin): string {
  switch (origin.type) {
    case "lastApplied":
      return t("upgrade:origin.lastApplied");
    case "managedFields":
      return t("upgrade:origin.managedFields", { manager: origin.manager || "?" });
    case "helm":
      return t("upgrade:origin.helm", { release: origin.release, namespace: origin.namespace, revision: origin.revision });
    case "argoCd":
      return t("upgrade:origin.argoCd", { application: origin.application, namespace: origin.namespace });
    case "flux":
      return t("upgrade:origin.flux", { kustomization: origin.kustomization, namespace: origin.namespace });
  }
}

export function statusText(t: TFunction, status: FindingStatus): string {
  return t(`upgrade:status.${status}`);
}

/** What to move to: the replacement, the advice when nothing replaces it. */
export function replacementText(t: TFunction, f: { replacement: string | null; note?: string }): string {
  if (f.replacement) return f.replacement;
  return f.note ? t(`upgrade:notes.${f.note}`) : t("upgrade:noReplacement");
}

export function skewText(t: TFunction, issue: SkewIssue): string {
  switch (issue.type) {
    case "stepwise":
      return t("upgrade:skew.stepwise", {
        from: minorText(issue.from),
        to: minorText(issue.to),
        steps: formatList(issue.steps.map(minorText)),
      });
    case "kubeletNewer":
    case "kubeProxyNewer":
      return t(`upgrade:skew.${issue.type}`, { count: issue.nodes.length, nodes: formatList(issue.nodes), version: minorText(issue.apiserver) });
    case "kubeletTooOld":
    case "kubeProxyTooOld":
      return t(`upgrade:skew.${issue.type}`, { count: issue.nodes.length, nodes: formatList(issue.nodes), version: minorText(issue.oldest) });
    case "kubeletTooOldForTarget":
    case "kubeProxyTooOldForTarget":
      return t(`upgrade:skew.${issue.type}`, {
        count: issue.nodes.length,
        nodes: formatList(issue.nodes),
        version: minorText(issue.oldest),
        target: minorText(issue.target),
      });
    case "kubeProxyKubeletSkew":
      return t("upgrade:skew.kubeProxyKubeletSkew", { count: issue.nodes.length, nodes: formatList(issue.nodes) });
    case "apiserverSkew":
      return t("upgrade:skew.apiserverSkew", { versions: formatList(issue.versions) });
    case "componentSkew":
      return t("upgrade:skew.componentSkew", {
        component: issue.component,
        pod: issue.pod,
        version: issue.version,
        apiserver: minorText(issue.apiserver),
      });
  }
}

export interface ReportInput {
  clusterVersion: string | null;
  target: Minor;
  findings: readonly Finding[];
  served: readonly ServedFinding[];
  skew: readonly SkewIssue[];
}

function findingCells(t: TFunction, f: Finding): string[] {
  return [
    statusText(t, f.status),
    f.kind,
    f.namespace ?? "",
    f.name,
    f.apiVersion,
    minorText(f.deprecation.deprecatedIn),
    minorText(f.deprecation.removedIn),
    replacementText(t, f),
    formatList(f.origins.map((o) => originText(t, o))),
  ];
}

function headers(t: TFunction): string[] {
  return [
    t("upgrade:columns.status"),
    t("upgrade:columns.kind"),
    t("upgrade:columns.namespace"),
    t("upgrade:columns.name"),
    t("upgrade:columns.apiVersion"),
    t("upgrade:columns.deprecatedIn"),
    t("upgrade:columns.removedIn"),
    t("upgrade:columns.replacement"),
    t("upgrade:columns.source"),
  ];
}

function mdCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function markdownReport(t: TFunction, input: ReportInput): string {
  const lines: string[] = [];
  const target = minorText(input.target);
  lines.push(
    `# ${
      input.clusterVersion
        ? t("upgrade:report.title", { from: input.clusterVersion, to: target })
        : t("upgrade:report.titleUnknown", { to: target })
    }`,
    "",
  );
  lines.push(`## ${t("upgrade:usages.title")}`, "");
  if (input.findings.length === 0) {
    lines.push(t("upgrade:usages.none"), "");
  } else {
    const head = headers(t);
    lines.push(`| ${head.map(mdCell).join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`);
    for (const f of input.findings) lines.push(`| ${findingCells(t, f).map(mdCell).join(" | ")} |`);
    lines.push("");
  }
  lines.push(`## ${t("upgrade:served.title")}`, "");
  if (input.served.length === 0) lines.push(t("upgrade:served.none"), "");
  else {
    for (const s of input.served) {
      lines.push(`- ${mdCell(`${s.apiVersion} ${s.api.kind}`)}: ${mdCell(servedText(t, s))}`);
    }
    lines.push("");
  }
  lines.push(`## ${t("upgrade:skew.title")}`, "");
  if (input.skew.length === 0) lines.push(t("upgrade:skew.none"));
  else for (const issue of input.skew) lines.push(`- ${mdCell(skewText(t, issue))}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

export function servedText(t: TFunction, s: ServedFinding): string {
  const params = { version: minorText(s.status === "removed" ? s.deprecation.removedIn : s.deprecation.deprecatedIn), replacement: replacementText(t, s) };
  return s.status === "removed" ? t("upgrade:served.removed", params) : t("upgrade:served.deprecated", params);
}

function csvCell(text: string): string {
  // A leading =, +, -, @, tab or carriage return would be read as a formula by a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The findings as CSV (one row per object and API version), with a header row. */
export function csvReport(t: TFunction, findings: readonly Finding[]): string {
  const rows = [headers(t), ...findings.map((f) => findingCells(t, f))];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
