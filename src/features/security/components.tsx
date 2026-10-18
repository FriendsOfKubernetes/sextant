// Pieces shared by the Security page, the "Security" details section and the Trivy report details: findings with
// their field and fix, the posture and count badges, the namespace's Pod Security labels compared with its
// workloads, and the tables of a Trivy report (at most `TOP_LIMIT` rows).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, type BadgeTone } from "../../components";
import { compareModes, PSA_PREFIX, type Judged, type ModeLabel } from "./namespaces";
import { postureOf, type Finding, type FindingLevel, type Posture } from "./pss";
import { toYaml } from "./snippet";
import {
  SEVERITIES,
  type Check,
  type ComplianceControl,
  type Counts,
  type ExposedSecret,
  type Top,
  type Vulnerability,
} from "./trivy";

export const LEVEL_TONE: Record<FindingLevel, BadgeTone> = { baseline: "danger", restricted: "warning", hint: "neutral" };
export const POSTURE_TONE: Record<Posture, BadgeTone> = { restricted: "success", baseline: "warning", privileged: "danger" };

const LEVEL_ORDER: Record<FindingLevel, number> = { baseline: 0, restricted: 1, hint: 2 };

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.path.localeCompare(b.path));
}

export function PostureBadge({ findings }: { findings: readonly Finding[] }) {
  const { t } = useTranslation();
  const posture = postureOf(findings);
  return <Badge tone={POSTURE_TONE[posture]}>{t(`security:posture.${posture}`)}</Badge>;
}

/** "2 Baseline violations", "5 Restricted violations", "3 hints" (the levels with any). */
export function LevelCounts({ findings, levels }: { findings: readonly Finding[]; levels?: readonly FindingLevel[] }) {
  const { t } = useTranslation();
  const shown = (levels ?? (["baseline", "restricted", "hint"] as const)).map((level) => ({
    level,
    count: findings.filter((f) => f.level === level).length,
  }));
  return (
    <>
      {shown
        .filter((s) => s.count > 0)
        .map((s) => (
          <Badge key={s.level} tone={LEVEL_TONE[s.level]}>
            {t(`security:counts.${s.level}`, { count: s.count })}
          </Badge>
        ))}
    </>
  );
}

const SEVERITY_TONE: Record<string, BadgeTone> = { CRITICAL: "danger", HIGH: "danger", MEDIUM: "warning", LOW: "info", UNKNOWN: "neutral" };

export function SeverityBadge({ severity }: { severity: string }) {
  const { t } = useTranslation();
  const known = (SEVERITIES as readonly string[]).includes(severity) ? severity : "UNKNOWN";
  return <Badge tone={SEVERITY_TONE[known]}>{t(`security:severity.${known}`)}</Badge>;
}

/** "Critical: 2", "High: 7", … for the severities with any (all four when `all`). */
export function SeverityCounts({ counts, all = false }: { counts: Counts; all?: boolean }) {
  const { t } = useTranslation();
  const values: [string, number][] = [
    ["CRITICAL", counts.critical],
    ["HIGH", counts.high],
    ["MEDIUM", counts.medium],
    ["LOW", counts.low],
  ];
  const shown = values.filter(([, n]) => all || n > 0);
  return (
    <span className="sec-counts">
      {shown.map(([severity, n]) => (
        <Badge key={severity} tone={n > 0 ? SEVERITY_TONE[severity] : "neutral"}>
          {t("security:trivy.severityCount", { severity: t(`security:severity.${severity}`), count: n })}
        </Badge>
      ))}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  return (
    <span className="sec-copy">
      <Button size="compact" icon="copy" iconOnly label={t("security:finding.copy")} onClick={() => void copy()} />
      {state !== "idle" && (
        <span className="sec-copy__state" role="status">
          {state === "copied" ? t("security:finding.copied") : t("security:finding.copyFailed")}
        </span>
      )}
    </span>
  );
}

function FindingItem({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  const yaml = finding.admittedIn ? "" : toYaml(finding.fix);
  return (
    <li className="sec-finding" data-check={finding.check} data-level={finding.level}>
      <div className="sec-finding__head">
        <Badge tone={LEVEL_TONE[finding.level]}>{t(`security:levels.${finding.level}`)}</Badge>
        <span className="sec-finding__title">{t(`security:checks.${finding.check}`)}</span>
        {finding.container && (
          <span className="sec-finding__container">{t("security:finding.container", { name: finding.container })}</span>
        )}
      </div>
      <div className="sec-finding__field">
        <code className="sec-code">{finding.path}</code>
        <span className="sec-finding__value">
          {finding.value === undefined
            ? t("security:finding.unset")
            : t("security:finding.value", { value: finding.value })}
        </span>
      </div>
      {finding.admittedIn ? (
        <p className="sec-note">{t("security:finding.admitted", { pod: finding.admittedIn })}</p>
      ) : (
        <details className="sec-fix">
          <summary>{t("security:finding.fix")}</summary>
          <div className="sec-fix__body">
            <pre className="sec-fix__yaml">{yaml}</pre>
            <CopyButton text={yaml} />
          </div>
        </details>
      )}
    </li>
  );
}

/** Findings by level (Baseline first), each with its field, the value found and a fix to copy. */
export function FindingList({ findings }: { findings: readonly Finding[] }) {
  return (
    <ul className="sec-findings">
      {sortFindings(findings).map((f, i) => (
        <FindingItem key={`${f.check}|${f.path}|${i}`} finding={f} />
      ))}
    </ul>
  );
}

/** `pod-security.kubernetes.io/enforce=restricted` (with the pinned version, when there is one). */
export function labelText(label: ModeLabel): string {
  const base = `${PSA_PREFIX}${label.mode}=${label.raw}`;
  return label.version === "latest" ? base : `${base}, ${PSA_PREFIX}${label.mode}-version=${label.version}`;
}

/** The namespace's Pod Security labels and, for each, the objects its level would reject, record or warn about. */
export function ModeComparisons({
  labels,
  judged,
}: {
  /** `undefined`: not known (the Namespace is loading, or could not be read). */
  labels: readonly ModeLabel[] | undefined;
  judged: readonly Judged[];
}) {
  const { t } = useTranslation();
  if (!labels) {
    return (
      <ul className="sec-modes">
        <li>{t("security:compare.unknownLabels")}</li>
      </ul>
    );
  }
  if (labels.length === 0) {
    const strictest = judged.length > 0 ? weakest(judged) : undefined;
    return (
      <ul className="sec-modes">
        <li>{t("security:compare.noLabels")}</li>
        {strictest && <li>{t(`security:compare.strictest.${strictest}`)}</li>}
      </ul>
    );
  }
  return (
    <ul className="sec-modes">
      {compareModes(labels, judged).map(({ label, failing }) => {
        const text = labelText(label);
        return (
          <li key={label.mode} className={modeClass(label, failing.length)} data-mode={label.mode}>
            {!label.level
              ? t("security:compare.unknownLevel", { label: text })
              : failing.length === 0
                ? t(`security:compare.${label.mode}None`, { label: text })
                : t(`security:compare.${label.mode}`, { label: text, count: failing.length })}
          </li>
        );
      })}
    </ul>
  );
}

function modeClass(label: ModeLabel, failing: number): string {
  if (failing === 0) return "sec-modes__ok";
  return label.mode === "enforce" ? "sec-modes__bad" : "sec-modes__warn";
}

/** The strictest standard all of `judged` meet. */
export function weakest(judged: readonly Judged[]): Posture {
  const order: Posture[] = ["privileged", "baseline", "restricted"];
  let worst = 2;
  for (const j of judged) worst = Math.min(worst, order.indexOf(postureOf(j.findings)));
  return order[worst]!;
}

function MoreNote({ top }: { top: Top<unknown> }) {
  const { t } = useTranslation();
  if (top.total <= top.rows.length) return null;
  return <p className="sec-note">{t("security:trivy.topShown", { shown: top.rows.length, total: top.total })}</p>;
}

export function VulnerabilityTable({ top }: { top: Top<Vulnerability> }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="sec-table-wrap">
        <table className="sec-table">
          <thead>
            <tr>
              <th>{t("security:trivy.table.severity")}</th>
              <th>{t("security:trivy.table.id")}</th>
              <th>{t("security:trivy.table.package")}</th>
              <th>{t("security:trivy.table.installed")}</th>
              <th>{t("security:trivy.table.fixed")}</th>
            </tr>
          </thead>
          <tbody>
            {top.rows.map((v, i) => (
              <tr key={`${v.id}|${v.resource}|${i}`}>
                <td>
                  <SeverityBadge severity={v.severity} />
                </td>
                <td title={v.title}>{v.id}</td>
                <td>{v.resource}</td>
                <td>{v.installed}</td>
                <td>{v.fixed ?? <span className="sec-muted">{t("security:trivy.noFix")}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreNote top={top} />
    </>
  );
}

export function CheckTable({ top }: { top: Top<Check> }) {
  return (
    <>
      <ul className="sec-checks">
        {top.rows.map((c, i) => (
          <li key={`${c.id}|${i}`} className="sec-check">
            <div className="sec-finding__head">
              <SeverityBadge severity={c.severity} />
              <span className="sec-finding__title">{c.id}</span>
              {c.title && <span>{c.title}</span>}
            </div>
            {c.messages.length > 0 && <p className="sec-note">{c.messages.join("\n")}</p>}
            {c.remediation && <p className="sec-remediation">{c.remediation}</p>}
          </li>
        ))}
      </ul>
      <MoreNote top={top} />
    </>
  );
}

export function SecretTable({ top }: { top: Top<ExposedSecret> }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="sec-table-wrap">
        <table className="sec-table">
          <thead>
            <tr>
              <th>{t("security:trivy.table.severity")}</th>
              <th>{t("security:trivy.table.rule")}</th>
              <th>{t("security:trivy.table.title")}</th>
              <th>{t("security:trivy.table.target")}</th>
            </tr>
          </thead>
          <tbody>
            {top.rows.map((s, i) => (
              <tr key={`${s.rule}|${s.target}|${i}`}>
                <td>
                  <SeverityBadge severity={s.severity} />
                </td>
                <td>{s.rule}</td>
                <td>{s.title}</td>
                <td>{s.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreNote top={top} />
    </>
  );
}

export function ControlTable({ top }: { top: Top<ComplianceControl> }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="sec-table-wrap">
        <table className="sec-table">
          <thead>
            <tr>
              <th>{t("security:trivy.table.severity")}</th>
              <th>{t("security:trivy.table.control")}</th>
              <th>{t("security:trivy.table.title")}</th>
              <th>{t("security:trivy.table.failed")}</th>
            </tr>
          </thead>
          <tbody>
            {top.rows.map((c, i) => (
              <tr key={`${c.id}|${i}`}>
                <td>
                  <SeverityBadge severity={c.severity} />
                </td>
                <td>{c.id}</td>
                <td>{c.name}</td>
                <td>{c.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreNote top={top} />
    </>
  );
}
