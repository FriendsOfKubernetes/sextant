// Pieces the connectivity page, the policy map and the details sections share: a link to a policy, one side of a
// result (egress or ingress) with the policies and rules that decided it, a policy's rules in plain words, and the DNS
// warning.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatList } from "../../i18n";
import { ObjectLink, StatusText } from "../../resources";
import type { DnsCheck, Match, SideResult } from "./engine";
import type { Direction, Policy, PolicyRef, Rule } from "./model";
import {
  flavorText,
  matchText,
  phrase,
  policyName,
  ruleText,
  ruleWhy,
  triMark,
  unknownText,
  VERDICT_TONE,
  verdictText,
  type T,
} from "./text";
import { ResizableTable } from "../../components/Table";

const NO = "no" as const;

export function PolicyLink({ policy, label }: { policy: PolicyRef; label?: string }) {
  return (
    <ObjectLink target={{ apiVersion: policy.apiVersion, kind: policy.kind, name: policy.name }} namespace={policy.namespace}>
      {label ?? policyName(policy)}
    </ObjectLink>
  );
}

function MatchList({ matches }: { matches: Match[] }) {
  const { t } = useTranslation();
  return (
    <ul className="np-list">
      {matches.map((m, i) => (
        <li key={i}>
          <PolicyLink policy={m.policy} /> <span className="dt-muted">{flavorText(t, m.policy)}</span>
          <div>{matchText(t, m.rule, m.peer, m.port)}</div>
        </li>
      ))}
    </ul>
  );
}

function whyText(t: T, side: SideResult): string {
  if (side.why === "notIsolated" || side.why === "hostNetwork" || side.why === "external") {
    return t(`netpol:why.${side.why}.${side.direction}`);
  }
  return t(`netpol:why.${side.why}`);
}

/** One side of a connection: its verdict, why, and the rules of every policy that selects the pod. */
export function SideView({ side, title }: { side: SideResult; title: string }) {
  const { t } = useTranslation();
  const tone = side.verdict === "allowed" ? "ok" : side.verdict === "denied" ? "problem" : "warning";
  return (
    <section className={`np-side np-side--${tone}`} data-side={side.direction} aria-label={title}>
      <div className="np-side__head">
        <h3 className="np-side__title">{title}</h3>
        <StatusText value={verdictText(t, side.verdict)} tone={VERDICT_TONE[side.verdict]} />
      </div>
      <p className="np-side__why">{whyText(t, side)}</p>
      {side.allowedBy.length > 0 && <MatchList matches={side.allowedBy} />}
      {side.deniedBy.length > 0 && <MatchList matches={side.deniedBy} />}
      {side.unknown.length > 0 && (
        <ul className="np-list np-list--unknown">
          {side.unknown.map((u, i) => (
            <li key={i}>{unknownText(t, u)}</li>
          ))}
        </ul>
      )}
      {side.policies.length > 0 && <PolicyChecks side={side} />}
    </section>
  );
}

function PolicyChecks({ side }: { side: SideResult }) {
  const { t } = useTranslation();
  const rows: ReactNode[] = [];
  for (const p of side.policies) {
    const policyCell = (
      <>
        <PolicyLink policy={p.policy.ref} />
        <div className="dt-muted">{flavorText(t, p.policy.ref)}</div>
      </>
    );
    if (p.rules.length === 0) {
      rows.push(
        <tr key={`${policyName(p.policy.ref)}-none`}>
          <td>{policyCell}</td>
          <td>{t("netpol:checks.noRules")}</td>
          <td>{triMark(t, NO)}</td>
          <td>{t(`netpol:checks.noRulesWhy.${side.direction}`)}</td>
        </tr>,
      );
      continue;
    }
    p.rules.forEach((r, i) => {
      rows.push(
        <tr key={`${policyName(p.policy.ref)}-${r.rule.list}-${r.rule.index}`} data-result={r.result}>
          <td>{i === 0 ? policyCell : null}</td>
          <td className="dt-col--nowrap">{ruleText(t, r.rule)}</td>
          <td className="dt-col--nowrap">{triMark(t, r.result)}</td>
          <td>
            {ruleWhy(t, r).map((line, j) => (
              <div key={j}>{line}</div>
            ))}
          </td>
        </tr>,
      );
    });
  }
  return (
    <details className="np-checks" open={side.verdict !== "allowed"}>
      <summary>{t(`netpol:checks.title.${side.direction}`, { count: side.policies.length })}</summary>
      <div className="dt-table-wrap">
        <ResizableTable tableId="netpol.policies" className="dt-table dt-table--words">
          <thead>
            <tr>
              <th>{t("netpol:checks.policy")}</th>
              <th>{t("netpol:checks.rule")}</th>
              <th>{t("netpol:checks.matches")}</th>
              <th>{t("netpol:checks.why")}</th>
            </tr>
          </thead>
          <tbody>{rows}</tbody>
        </ResizableTable>
      </div>
    </details>
  );
}

/** The rules of one direction of a policy in plain words: peers and ports of each rule. */
export function RulesView({ policy, direction }: { policy: Policy; direction: Direction }) {
  const { t } = useTranslation();
  if (!policy.isolates[direction] && !policy.applies[direction]) {
    return <p className="dt-muted">{t(`netpol:rules.notRestricted.${direction}`)}</p>;
  }
  const rules = policy.rules[direction];
  if (rules.length === 0) return <p>{t(`netpol:rules.denyAll.${direction}`)}</p>;
  return (
    <div className="dt-table-wrap">
      <ResizableTable tableId="netpol.rules" className="dt-table dt-table--words np-rules">
        <thead>
          <tr>
            <th>{t("netpol:rules.rule")}</th>
            <th>{t(`netpol:rules.peers.${direction}`)}</th>
            <th>{t("netpol:rules.ports")}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <RuleRow key={`${rule.list}-${rule.index}`} rule={rule} direction={direction} />
          ))}
        </tbody>
      </ResizableTable>
    </div>
  );
}

function RuleRow({ rule, direction }: { rule: Rule; direction: Direction }) {
  const { t } = useTranslation();
  const label = rule.action === "allow" ? ruleText(t, rule) : `${ruleText(t, rule)} (${t(`netpol:action.${rule.action}`)})`;
  const peers = rule.empty
    ? [t("netpol:rules.empty")]
    : rule.peers === null
      ? [t(`netpol:rules.anyPeer.${direction}`)]
      : rule.peers.map((p) => phrase(t, p.text));
  if (rule.local) peers.push(t("netpol:rules.local", { match: phrase(t, rule.local.text) }));
  const ports = rule.ports === null ? [t("netpol:rules.anyPort")] : rule.ports.map((p) => phrase(t, p.text));
  return (
    <tr>
      <td className="dt-col--nowrap">{label}</td>
      <td>
        {peers.map((p, i) => (
          <div key={i}>{p}</div>
        ))}
        {rule.unmodelled.length > 0 && <div className="dt-muted">{t("netpol:reason.unmodelled", { feature: formatList(rule.unmodelled) })}</div>}
      </td>
      <td>
        {ports.map((p, i) => (
          <div key={i}>{p}</div>
        ))}
      </td>
    </tr>
  );
}

/** The DNS warning of an egress-isolated source; nothing when DNS is allowed or the source is not isolated. */
export function DnsWarning({ dns }: { dns: DnsCheck | null }) {
  const { t } = useTranslation();
  if (!dns) return null;
  let key: string | null = null;
  if (dns.udp === "denied") key = "netpol:dns.denied";
  else if (dns.udp === "unknown") key = "netpol:dns.unknown";
  else if (dns.tcp === "denied") key = "netpol:dns.tcpDenied";
  if (!key) return null;
  return (
    <p className="np-warning" role="note" data-dns={dns.udp}>
      {t(key)}
    </p>
  );
}

/** The banner every connectivity view shows: the CNI enforces, Sextant reasons from objects. */
export function EnforcementBanner() {
  const { t } = useTranslation();
  return (
    <p className="np-banner" role="note">
      {t("netpol:banner")}
    </p>
  );
}
