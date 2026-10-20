// Pieces shared by the "Best practices" page and the details section: severity badges and counts, and findings with
// their field, why they matter and a fix to copy (the Security page's layout and its YAML writer).
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, type BadgeTone } from "../../components";
import { toYaml } from "../security/snippet";
import { areaOf, SEVERITIES, type PracticeFinding, type Severity } from "./model";

export const SEVERITY_TONE: Record<Severity, BadgeTone> = { high: "danger", medium: "warning", low: "neutral" };
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Worst first, then by field. */
export function sortFindings(findings: readonly PracticeFinding[]): PracticeFinding[] {
  return [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.check.localeCompare(b.check) || a.path.localeCompare(b.path));
}

/** "2 high-severity findings", … for the severities with any. */
export function SeverityCounts({ findings }: { findings: readonly PracticeFinding[] }) {
  const { t } = useTranslation();
  return (
    <>
      {SEVERITIES.map((s) => ({ s, count: findings.filter((f) => f.severity === s).length }))
        .filter(({ count }) => count > 0)
        .map(({ s, count }) => (
          <Badge key={s} tone={SEVERITY_TONE[s]}>
            {t(`practices:counts.${s}`, { count })}
          </Badge>
        ))}
    </>
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
      <Button size="compact" icon="copy" iconOnly label={t("practices:finding.copy")} onClick={() => void copy()} />
      {state !== "idle" && (
        <span className="sec-copy__state" role="status">
          {state === "copied" ? t("practices:finding.copied") : t("practices:finding.copyFailed")}
        </span>
      )}
    </span>
  );
}

/** The key of a finding's explanation. */
export function whyKey(f: PracticeFinding): string {
  return f.check === "singleReplica" && f.on ? "practices:checks.singleReplica.whyHpa" : `practices:checks.${f.check}.why`;
}

function FindingItem({ finding }: { finding: PracticeFinding }) {
  const { t } = useTranslation();
  const yaml = toYaml(finding.fix);
  return (
    <li className="sec-finding" data-check={finding.check} data-severity={finding.severity}>
      <div className="sec-finding__head">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{t(`practices:severity.${finding.severity}`)}</Badge>
        <span className="sec-finding__title">{t(`practices:checks.${finding.check}.title`)}</span>
        <span className="sec-muted">{t(`practices:areas.${areaOf(finding.check)}`)}</span>
        {finding.container && <span className="sec-finding__container">{t("practices:finding.container", { name: finding.container })}</span>}
        {finding.on && <span className="sec-finding__container">{t("practices:finding.on", { kind: finding.on.kind, name: finding.on.name })}</span>}
      </div>
      <div className="sec-finding__field">
        <code className="sec-code">{finding.path}</code>
        <span className="sec-finding__value">
          {finding.value === undefined ? t("practices:finding.unset") : t("practices:finding.value", { value: finding.value })}
        </span>
      </div>
      <p className="sec-note">{t(whyKey(finding), finding.params ?? {})}</p>
      <details className="sec-fix">
        <summary>{finding.fixType === "create" ? t("practices:finding.create") : t("practices:finding.fix")}</summary>
        <div className="sec-fix__body">
          <pre className="sec-fix__yaml">{yaml}</pre>
          <CopyButton text={yaml} />
        </div>
      </details>
    </li>
  );
}

/** Findings worst first, each with its field, why it matters and a fix to copy. */
export function FindingList({ findings }: { findings: readonly PracticeFinding[] }) {
  return (
    <ul className="sec-findings">
      {sortFindings(findings).map((f, i) => (
        <FindingItem key={`${f.check}|${f.path}|${f.on?.name ?? ""}|${i}`} finding={f} />
      ))}
    </ul>
  );
}
