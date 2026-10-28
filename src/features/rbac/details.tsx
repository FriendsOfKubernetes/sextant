// Details sections of the RBAC kinds (#140): a Role or ClusterRole shows its rules explained (wildcards,
// subresources, named objects, aggregation resolved) and who it is bound to; a binding shows the rules of the role it
// grants (or that the role is missing) and opens each subject's permissions; a ServiceAccount shows what it can do.
// Each section watches only the lists it needs, while it is shown.
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../api";
import { Button } from "../../components";
import { useClusterKinds } from "../../resources";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { useDetailsDisclosure } from "../../layout/details/disclosure";
import { Block } from "../details";
import {
  bindingsOfRole,
  buildIndex,
  permissionsOf,
  refOf,
  roleRefOf,
  rulesOf,
  subjectOfEntry,
  subjectsOf,
  type RbacRef,
  type RbacWarning,
  type Subject,
} from "./engine";
import { useRbacData, ALL_LISTS, type RbacList } from "./hooks";
import { PermissionMatrix } from "./Matrix";
import { clusterScopedOf } from "./query";
import { openRbacPage } from "./state";
import { ComputedNote, entryText, ImplicitGroups, ListProblems, RefLink, RulesTable, scopeText, Warnings, refName, refText } from "./ui";
import { ResizableTable } from "../../components/Table";

const clusterRoleRef = (name: string): RbacRef => ({ kind: "ClusterRole", name, namespace: null });

const hasAggregation = (obj: KubeObject) => {
  const rule = obj.aggregationRule as { clusterRoleSelectors?: unknown[] } | undefined;
  return Array.isArray(rule?.clusterRoleSelectors) && rule.clusterRoleSelectors.length > 0;
};

function SubjectButton({ clusterId, subject, label, namespace }: { clusterId: string; subject: Subject; label: string; namespace: string | null }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="rt-link" title={t("rbac:details.showPermissions")} onClick={() => openRbacPage(clusterId, subject, namespace)}>
      {label}
    </button>
  );
}

// ---------- Role / ClusterRole ----------

export function RoleAccessSection({ clusterId, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const rulesOpen = useDetailsDisclosure("rbac:details.rulesExplained")?.open ?? true;
  const bindingsOpen = useDetailsDisclosure("rbac:details.boundTo")?.open ?? true;
  const isCluster = obj?.kind === "ClusterRole";
  const aggregated = !!obj && isCluster && hasAggregation(obj);
  const ns = obj?.metadata?.namespace ?? null;
  const rbac = useRbacData(
    clusterId,
    obj
      ? {
          clusterRoles: aggregated && rulesOpen,
          roleBindings: bindingsOpen,
          clusterRoleBindings: isCluster && bindingsOpen,
          namespaces: isCluster || !ns ? null : [ns],
        }
      : {},
  );
  const ref: RbacRef | null = obj ? refOf(obj) : null;
  const rules = useMemo(() => {
    if (!rulesOpen || !obj || !ref) return [];
    if (!aggregated) return rulesOf(obj).map((rule) => ({ rule }));
    // Resolve against the watched ClusterRoles, this one included as the watch has it.
    const index = buildIndex({ clusterRoles: [...(rbac.data.clusterRoles ?? []).filter((r) => r.metadata?.name !== obj.metadata?.name), obj] });
    return index.rulesOfRole(ref) ?? [];
  }, [obj, aggregated, rulesOpen, rbac.data.clusterRoles]);
  const sources = useMemo(
    () => (rulesOpen && aggregated && obj ? buildIndex({ clusterRoles: [...(rbac.data.clusterRoles ?? []), obj] }).aggregatedFrom(obj.metadata?.name ?? "") : []),
    [obj, aggregated, rulesOpen, rbac.data.clusterRoles],
  );
  if (!obj || !ref) return null;
  const bindings = bindingsOpen ? bindingsOfRole(rbac.data, ref) : [];
  const lists: RbacList[] = [...(aggregated ? (["clusterRoles"] as const) : []), "roleBindings", ...(isCluster ? (["clusterRoleBindings"] as const) : [])];
  return (
    <>
      <Block id="rbac:details.rulesExplained" title={t("rbac:details.rulesExplained")}>
        {aggregated && (
          <p className="dt-muted">
            {sources.length === 0 ? t("rbac:details.aggregatedFromNone") : t("rbac:details.aggregatedFrom")}
            {sources.map((name) => (
              <span key={name} className="rbac-inline">
                <RefLink refTo={clusterRoleRef(name)} showKind={false} />
              </span>
            ))}
          </p>
        )}
        <RulesTable rules={rules} />
      </Block>
      <Block id="rbac:details.boundTo" title={t("rbac:details.boundTo")}>
        <ListProblems state={rbac} lists={lists} />
        {!rbac.loading && bindings.length === 0 && <p className="dt-muted">{t("rbac:details.noBindings")}</p>}
        {bindings.length > 0 && (
          <div className="dt-table-wrap">
            <ResizableTable tableId="rbac.subjectGrants" className="dt-table rbac-grants">
              <thead>
                <tr>
                  <th>{t("rbac:grants.binding")}</th>
                  <th>{t("rbac:grants.scope")}</th>
                  <th>{t("rbac:details.subjects")}</th>
                </tr>
              </thead>
              <tbody>
                {bindings.map((b) => {
                  const scope = b.kind === "RoleBinding" ? (b.metadata?.namespace ?? null) : null;
                  return (
                    <tr key={b.metadata?.uid ?? `${b.kind}/${refName(refOf(b))}`}>
                      <td>
                        <RefLink refTo={refOf(b)} />
                      </td>
                      <td>{scopeText(t, scope)}</td>
                      <td>
                        {subjectsOf(b).map((entry, i) => (
                          <div key={i}>
                            <SubjectButton clusterId={clusterId} subject={subjectOfEntry(entry, scope)} label={entryText(t, entry, scope)} namespace={scope} />
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </ResizableTable>
          </div>
        )}
      </Block>
    </>
  );
}

// ---------- RoleBinding / ClusterRoleBinding ----------

export function BindingAccessSection({ clusterId, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const open = useDetailsDisclosure("rbac:details.grants")?.open ?? true;
  const role = obj ? roleRefOf(obj) : undefined;
  const scope = obj?.kind === "RoleBinding" ? (obj.metadata?.namespace ?? null) : null;
  const toCluster = role?.kind === "ClusterRole";
  const rbac = useRbacData(
    clusterId,
    open && role ? { roles: !toCluster, clusterRoles: toCluster, namespaces: role.namespace ? [role.namespace] : null } : {},
  );
  const index = useMemo(() => open ? buildIndex(rbac.data) : null, [open, rbac.data]);
  if (!obj || !role) return null;
  const rules = index?.rulesOfRole(role);
  const missing = index?.isMissing(role);
  const roleLists: RbacList[] = [toCluster ? "clusterRoles" : "roles"];
  const missingWarning: RbacWarning[] = [{ type: "missingRole", binding: refOf(obj), role }];
  return (
    <>
      <Block id="rbac:details.grants" title={t("rbac:details.grants", { role: refText(t, role) })}>
        <p className="dt-muted">{scope === null ? t("rbac:details.grantsEverywhere") : t("rbac:details.grantsIn", { namespace: scope })}</p>
        <ListProblems state={rbac} lists={roleLists} />
        {missing && <Warnings warnings={missingWarning} />}
        {rules && <RulesTable rules={scope === null ? rules : rules.filter((r) => r.rule.resources.length > 0)} />}
        {rules && scope !== null && rules.some((r) => r.rule.resources.length === 0) && (
          <p className="dt-muted">{t("rbac:details.urlsIgnored")}</p>
        )}
      </Block>
      <Block id="rbac:details.subjectsPermissions" title={t("rbac:details.subjectsPermissions")}>
        <ul className="rbac-list">
          {subjectsOf(obj).map((entry, i) => (
            <li key={i}>
              <SubjectButton clusterId={clusterId} subject={subjectOfEntry(entry, scope)} label={entryText(t, entry, scope)} namespace={scope} />
            </li>
          ))}
        </ul>
      </Block>
    </>
  );
}

// ---------- ServiceAccount ----------

function ServiceAccountAccessContent({ clusterId, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const subject: Subject | null = obj?.metadata?.name
    ? { kind: "ServiceAccount", name: obj.metadata.name, namespace: obj.metadata.namespace ?? "" }
    : null;
  const rbac = useRbacData(clusterId, subject ? ALL_LISTS : {});
  const kinds = useClusterKinds(clusterId);
  const scoped = useMemo(() => clusterScopedOf(kinds.kinds), [kinds.kinds]);
  const index = useMemo(() => buildIndex(rbac.data), [rbac.data]);
  const perms = useMemo(
    () => (subject ? permissionsOf(index, subject, null, scoped) : null),
    [index, subject?.name, subject?.namespace, scoped],
  );
  if (!subject || !perms) return null;
  return (
    <>
      <ImplicitGroups subject={subject} />
      <ComputedNote />
      <ListProblems state={rbac} />
      <Warnings warnings={perms.warnings} />
      {!rbac.loading && <PermissionMatrix grants={perms.grants} clusterScoped={scoped} label={t("rbac:matrix.label", { subject: `${subject.namespace}/${subject.name}` })} />}
    </>
  );
}

export function ServiceAccountAccessSection(props: DetailsSectionProps) {
  const { t } = useTranslation();
  const { clusterId, obj } = props;
  if (!obj?.metadata?.name) return null;
  const subject: Subject = { kind: "ServiceAccount", name: obj.metadata.name, namespace: obj.metadata.namespace ?? "" };
  return <Block id="rbac:details.canDo" title={t("rbac:details.canDo")} actions={<Button size="compact" onClick={() => openRbacPage(clusterId, subject, null)}>{t("rbac:details.openPage")}</Button>}><ServiceAccountAccessContent {...props} /></Block>;
}
