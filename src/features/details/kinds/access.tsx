// ServiceAccount (secrets, image pull secrets), Role/ClusterRole (rules) and RoleBinding/ClusterRoleBinding (role,
// subjects — service accounts are links).
import { useTranslation } from "react-i18next";
import type { KubeObject } from "../../../api";
import { status } from "../../../resources";
import { Block, Fields, inline, KINDS, labelSelector, link, nsOf, strings, table, type FieldRow } from "../ui";

const { arr, get, str } = status;

const RBAC = "rbac.authorization.k8s.io/v1";

export function ServiceAccountDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = nsOf(obj);
  const secrets = (list: unknown) => inline(arr(list).map((s) => link(KINDS.secret, str(get(s, "name")), ns)));
  const automount = get(obj, "automountServiceAccountToken");
  const rows: FieldRow[] = [
    ["secrets", secrets(get(obj, "secrets"))],
    ["imagePullSecrets", secrets(get(obj, "imagePullSecrets"))],
    ["automountToken", typeof automount === "boolean" ? t(automount ? "details:yes" : "details:no") : undefined],
  ];
  return <Fields rows={rows} />;
}

export function RoleDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const rules = table(
    "role.rules",
    [
      t("details:columns.resources"),
      t("details:columns.verbs"),
      t("details:columns.apiGroups"),
      t("details:columns.resourceNames"),
    ],
    arr(get(obj, "rules")).map((rule) => [
      [...strings(get(rule, "resources")), ...strings(get(rule, "nonResourceURLs"))].join(", "),
      strings(get(rule, "verbs")).join(", "),
      strings(get(rule, "apiGroups"))
        .map((g) => g || "core")
        .join(", "),
      strings(get(rule, "resourceNames")).join(", "),
    ]),
  );
  const rows: FieldRow[] = [
    ["aggregation", inline(arr(get(obj, "aggregationRule", "clusterRoleSelectors")).map((s) => labelSelector(s)))],
  ];
  return (
    <>
      <Fields rows={rows} />
      {rules && <Block title={t("details:rbac.rules")}>{rules}</Block>}
    </>
  );
}

export function RoleBindingDetails({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const ns = nsOf(obj);
  const roleKind = str(get(obj, "roleRef", "kind")) ?? "";
  const roleName = str(get(obj, "roleRef", "name"));
  const role = roleKind
    ? link({ apiVersion: RBAC, kind: roleKind }, roleName, roleKind === "Role" ? ns : null, `${roleKind} ${roleName ?? ""}`)
    : null;
  const subjects = table(
    "binding.subjects",
    [t("details:columns.kind"), t("details:columns.name"), t("details:columns.namespace")],
    arr(get(obj, "subjects")).map((s) => {
      const kind = str(get(s, "kind")) ?? "";
      const name = str(get(s, "name"));
      const namespace = str(get(s, "namespace")) ?? null;
      return [kind, kind === "ServiceAccount" ? link(KINDS.serviceAccount, name, namespace ?? ns) : name, namespace];
    }),
  );
  const rows: FieldRow[] = [["roleRef", role]];
  return (
    <>
      <Fields rows={rows} />
      {subjects && <Block title={t("details:rbac.subjects")}>{subjects}</Block>}
    </>
  );
}
