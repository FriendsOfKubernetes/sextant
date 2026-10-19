// Shared pieces of the RBAC views: links to roles and bindings, subject labels, the plain-language notes of a rule,
// the list of grants behind a matrix cell, the warnings and the state of the watched lists. Texts are built outside
// JSX from `rbac.json`; names, verbs and resources are shown as the API spells them.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../components";
import { formatList } from "../../i18n/format";
import { ObjectLink } from "../../resources";
import type { BindingSubject, Explanation, Grant, PolicyRule, RbacRef, RbacWarning, SourcedRule, Subject } from "./engine";
import { explainRule, identityOf, RBAC_GROUP } from "./engine";
import type { RbacList, RbacState } from "./hooks";
import { RBAC_LISTS } from "./hooks";
import { ResizableTable } from "../../components/Table";

const RBAC_API = `${RBAC_GROUP}/v1`;

/** `ns/name`, or the name of a cluster-scoped object. */
export const refName = (ref: Pick<RbacRef, "name" | "namespace">) => (ref.namespace ? `${ref.namespace}/${ref.name}` : ref.name);

type Translate = (key: string, o?: Record<string, unknown>) => string;

/** "RoleBinding prod/web" (`rbac:objectLabel`: the kind as the API names it, then `ns/name`). */
export function refText(t: Translate, ref: RbacRef): string {
  return t("rbac:objectLabel", { kind: ref.kind, name: refName(ref) });
}

/** A link opening the details of a role or binding (`Kind ns/name`). */
export function RefLink({ refTo, showKind = true }: { refTo: RbacRef; showKind?: boolean }) {
  const { t } = useTranslation();
  if (!refTo.name) return null;
  const label = showKind ? refText(t, refTo) : refName(refTo);
  return (
    <ObjectLink target={{ apiVersion: RBAC_API, kind: refTo.kind, name: refTo.name }} namespace={refTo.namespace}>
      {label}
    </ObjectLink>
  );
}

/** "Service account prod/web", "User alice", "Group ops". */
export function subjectText(t: Translate, s: Pick<Subject, "kind" | "name" | "namespace">): string {
  const name = s.kind === "ServiceAccount" && s.namespace ? `${s.namespace}/${s.name}` : s.name;
  return t("rbac:subject.label", { kind: t(`rbac:subject.kinds.${s.kind}`), name });
}

/** A binding's subject entry as written (a ServiceAccount without a namespace gets the binding's). */
export function entryText(t: Translate, entry: BindingSubject, bindingNamespace: string | null): string {
  if (entry.kind === "User" || entry.kind === "Group" || entry.kind === "ServiceAccount") {
    return subjectText(t, { kind: entry.kind, name: entry.name, namespace: entry.namespace || bindingNamespace || undefined });
  }
  return t("rbac:objectLabel", { kind: entry.kind, name: entry.name });
}

/** A service account links to its details; users and groups are not objects. */
export function SubjectLabel({ subject }: { subject: Subject }) {
  const { t } = useTranslation();
  const text = subjectText(t, subject);
  if (subject.kind !== "ServiceAccount" || !subject.namespace) return <span>{text}</span>;
  return (
    <ObjectLink target={{ apiVersion: "v1", kind: "ServiceAccount", name: subject.name }} namespace={subject.namespace}>
      {text}
    </ObjectLink>
  );
}

/** One translated note about a rule. */
export function explanationText(t: (key: string, o?: Record<string, unknown>) => string, e: Explanation): string {
  return t(`rbac:explain.${e.key}`, { ...e.values, ...(e.list ? { list: formatList(e.list) } : {}) });
}

export function Explanations({ rule }: { rule: SourcedRule }) {
  const { t } = useTranslation();
  const notes = explainRule(rule);
  if (notes.length === 0) return null;
  return (
    <ul className="rbac-notes">
      {notes.map((e, i) => (
        <li key={`${e.key}-${i}`} className={e.key === "escalating" || e.key === "pending" ? "rbac-notes__warn" : undefined}>
          {explanationText(t, e)}
        </li>
      ))}
    </ul>
  );
}

/** `core` for the core group, `*` as is. */
export function groupText(t: (key: string) => string, group: string): string {
  return group === "" ? t("rbac:matrix.core") : group;
}

/** A rule's parts, each joined in the UI language; empty parts are `""`. */
export function ruleParts(t: (key: string) => string, rule: PolicyRule) {
  return {
    verbs: formatList(rule.verbs),
    resources: formatList(rule.resources.length > 0 ? rule.resources : rule.nonResourceURLs),
    groups: rule.resources.length > 0 ? formatList(rule.apiGroups.map((g) => groupText(t, g))) : "",
    names: formatList(rule.resourceNames),
  };
}

/** Rules of a role as a table, each with its notes and, when aggregated, its source ClusterRole. */
export function RulesTable({ rules }: { rules: readonly SourcedRule[] }) {
  const { t } = useTranslation();
  if (rules.length === 0) return <p className="dt-muted">{t("rbac:rules.none")}</p>;
  return (
    <div className="dt-table-wrap">
      <ResizableTable tableId="rbac.rules" className="dt-table rbac-rules">
        <thead>
          <tr>
            <th>{t("rbac:rules.verbs")}</th>
            <th>{t("rbac:rules.resources")}</th>
            <th>{t("rbac:rules.groups")}</th>
            <th>{t("rbac:rules.names")}</th>
            <th>{t("rbac:rules.notes")}</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => {
            const parts = ruleParts(t, r.rule);
            return (
              <tr key={i} className={r.pending ? "rbac-rules__pending" : undefined}>
                <td>{parts.verbs}</td>
                <td>{parts.resources}</td>
                <td>{parts.groups}</td>
                <td>{parts.names}</td>
                <td>
                  {r.via && !r.pending && <div className="dt-muted">{t("rbac:rules.via", { source: r.via })}</div>}
                  <Explanations rule={r} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </ResizableTable>
    </div>
  );
}

/** Where a grant applies: everywhere, or one namespace. */
export function scopeText(t: (key: string, o?: Record<string, unknown>) => string, scope: string | null): string {
  return scope === null ? t("rbac:scope.cluster") : t("rbac:scope.only", { namespace: scope });
}

/** The grants behind a cell (or a subject's whole list): binding, role, scope, the entry that matched, the rule. */
export function GrantList({ grants, onlyNames, showSource = true }: { grants: readonly Grant[]; onlyNames?: (g: Grant) => string[] | undefined; showSource?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="dt-table-wrap">
      <ResizableTable tableId={showSource ? "rbac.grants.source" : "rbac.grants"} className="dt-table rbac-grants">
        <thead>
          <tr>
            {showSource && <th data-col="binding">{t("rbac:grants.binding")}</th>}
            {showSource && <th data-col="role">{t("rbac:grants.role")}</th>}
            <th data-col="scope">{t("rbac:grants.scope")}</th>
            {showSource && <th data-col="matchedBy">{t("rbac:grants.matchedBy")}</th>}
            <th data-col="rule">{t("rbac:grants.rule")}</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((g, i) => {
            const parts = ruleParts(t, g.rule);
            const names = onlyNames?.(g);
            return (
              <tr key={i}>
                {showSource && (
                  <td>
                    <RefLink refTo={g.binding} />
                  </td>
                )}
                {showSource && (
                  <td>
                    <RefLink refTo={g.role} />
                    {g.via && <div className="dt-muted">{t("rbac:rules.via", { source: g.via })}</div>}
                  </td>
                )}
                <td>{scopeText(t, g.scope)}</td>
                {showSource && <td>{entryText(t, g.matchedBy, g.scope)}</td>}
                <td>
                  <div>{t("rbac:grants.ruleText", { verbs: parts.verbs, resources: parts.resources })}</div>
                  {names && <div className="rbac-notes__warn">{t("rbac:explain.onlyNames", { list: formatList(names) })}</div>}
                  <Explanations rule={g} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </ResizableTable>
    </div>
  );
}

export function Warnings({ warnings }: { warnings: readonly RbacWarning[] }) {
  const { t } = useTranslation();
  if (warnings.length === 0) return null;
  return (
    <ul className="rbac-warnings" role="list">
      {warnings.map((w, i) => (
        <li key={i} className="rbac-warning">
          <Icon name="warning" />
          <span>
            {t("rbac:warnings.missingRole", { binding: refText(t, w.binding), role: refText(t, w.role) })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Why the computed answer may be incomplete: lists that cannot be read, namespaces left out, loading. */
export function ListProblems({ state, lists = RBAC_LISTS }: { state: RbacState; lists?: readonly RbacList[] }) {
  const { t } = useTranslation();
  const lines: ReactNode[] = [];
  for (const list of lists) {
    const s = state.status[list];
    if (s === "forbidden") lines.push(<li key={list}>{t(`rbac:lists.forbidden.${list}`)}</li>);
    else if (s === "error") lines.push(<li key={list}>{t(`rbac:lists.failed.${list}`)}</li>);
  }
  if (state.partialNamespaces.length > 0) {
    lines.push(
      <li key="partial">
        {t("rbac:lists.partial", { count: state.partialNamespaces.length, namespaces: formatList(state.partialNamespaces) })}
      </li>,
    );
  }
  return (
    <>
      {state.loading && (
        <p className="dt-muted" role="status">
          {t("rbac:lists.loading")}
        </p>
      )}
      {lines.length > 0 && <ul className="rbac-warnings rbac-warnings--lists">{lines}</ul>}
    </>
  );
}

/** The groups a subject counts as a member of without being listed. */
export function ImplicitGroups({ subject }: { subject: Subject }) {
  const { t } = useTranslation();
  const groups = identityOf(subject).groups.filter((g) => !(subject.groups ?? []).includes(g) && g !== subject.name);
  if (subject.kind === "Group" || groups.length === 0) return null;
  return <p className="dt-muted">{t("rbac:subject.implicit", { groups: formatList(groups) })}</p>;
}

/** The note every computed view carries: other authorizers and system:masters are not seen here. */
export function ComputedNote() {
  const { t } = useTranslation();
  return <p className="rbac-note">{t("rbac:notes.computed")}</p>;
}
