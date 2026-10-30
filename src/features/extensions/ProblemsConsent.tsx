// The consent screen's block about problem rules (ADR-0137): which kinds Sextant will judge by the extension's rules
// and that only where it may read them. Agreeing grants exactly these kinds; an update that judges another asks again.
import { useTranslation } from "react-i18next";
import type { ProblemContribution } from "../../api";

/** Each kind once (kinds compare ignoring case), as `Kind` or `Kind (group)`. */
export function judgedKinds(rules: readonly ProblemContribution[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { kind } of rules) {
    const key = `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kind.group ? `${kind.kind} (${kind.group})` : kind.kind);
  }
  return out;
}

export function ProblemsConsent({ rules }: { rules: readonly ProblemContribution[] }) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="ext-consent__heading">{t("extensions:problems.heading")}</h3>
      <p>{t("extensions:problems.kinds")}</p>
      <ul className="ext-backend__list">
        {judgedKinds(rules).map((kind) => (
          <li key={kind}>
            <code>{kind}</code>
          </li>
        ))}
      </ul>
      <p className="settings__hint">{t("extensions:problems.scope")}</p>
    </>
  );
}
