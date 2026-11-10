// The consent screen's block about problem rules (ADR-0137): which kinds Sextant will judge by the extension's rules,
// which kinds it reads only to tell whether an object a rule names exists (`missing`, ADR-0144), and that only where
// it may read them. Agreeing grants exactly these kinds; an update that judges or looks up another asks again.
// Problem judges (ADR-0168): which kinds the extension's backend gets, with which fields, to decide some problems.
import { useTranslation } from "react-i18next";
import type { ProblemContribution, ProblemJudgeContribution } from "../../api";
import { lookedUp } from "../../extensions/problemsAcross";

/** Each kind the rules judge once (kinds compare ignoring case), as `Kind` or `Kind (group)`. */
export function judgedKinds(rules: readonly ProblemContribution[]): string[] {
  return named(rules.map((r) => r.kind));
}

/** Each kind the rules look up (`missing`) once, as `judgedKinds` writes them. */
export function lookedUpKinds(rules: readonly ProblemContribution[]): string[] {
  return named(rules.flatMap((r) => lookedUp(r.when)));
}

/** Each kind the judges read once, as `judgedKinds` writes them, with the fields of it any judge gets (each once). */
export function judgeReads(judges: readonly ProblemJudgeContribution[]): { kind: string; paths: string[] }[] {
  const out = new Map<string, { kind: string; paths: string[] }>();
  for (const { kind, paths } of judges.flatMap((judge) => judge.reads)) {
    const key = `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;
    const entry = out.get(key) ?? { kind: named([kind])[0]!, paths: [] };
    for (const path of paths) if (!entry.paths.includes(path)) entry.paths.push(path);
    out.set(key, entry);
  }
  return [...out.values()];
}

function named(kinds: readonly { group: string; kind: string }[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const kind of kinds) {
    const key = `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(kind.group ? `${kind.kind} (${kind.group})` : kind.kind);
  }
  return out;
}

export function ProblemsConsent({
  rules,
  judges = [],
}: {
  rules: readonly ProblemContribution[];
  judges?: readonly ProblemJudgeContribution[];
}) {
  const { t } = useTranslation();
  const reads = judgeReads(judges);
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
      {lookedUpKinds(rules).length > 0 && (
        <>
          <p>{t("extensions:problems.lookups")}</p>
          <ul className="ext-backend__list">
            {lookedUpKinds(rules).map((kind) => (
              <li key={kind}>
                <code>{kind}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {reads.length > 0 && (
        <>
          <p>{t("extensions:problems.judges")}</p>
          <ul className="ext-backend__list">
            {reads.map(({ kind, paths }) => (
              <li key={kind}>
                <code>{kind}</code>
                <ul>
                  {paths.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="settings__hint">{t(reads.length > 0 ? "extensions:problems.judgesScope" : "extensions:problems.scope")}</p>
    </>
  );
}
