// "No access" said once where the access check (#285, `accessStore.ts`) knows the user may not list a kind: the main
// table shows it instead of starting a watch the API server would refuse, and the sidebar entry carries a mark. Only
// for a user who may not list Namespaces, only from the API server's own answers ("noAccess" never rounds up from
// "unknown"), and never hidden: the user can check again or list anyway.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, ResourceKind } from "../../api";
import { Button, Icon } from "../../components";
import { formatDateTime, formatList } from "../../i18n/format";
import { findKind, knownClusterKinds } from "../../resources/useKinds";
import { kindAccessIn, kindKeyOf } from "./access";
import { refreshAccess, useAccess, type AccessState } from "./accessStore";
import { NamespaceFilter } from "./NamespaceFilter";

/** Tables the user chose to list anyway, for the window's lifetime. */
const listedAnyway = new Set<string>();

/** "pending": the kinds' answers of a user who may not list Namespaces have not come yet (at most `KINDS_WAIT_MS`). */
export type NoAccessReason = "noAccess" | "noScope" | "pending";

function reasonOf(
  access: AccessState,
  kind: Pick<KindRef, "group" | "kind">,
  resourceKind: ResourceKind | null | undefined,
  namespaced: boolean,
  namespaces: readonly string[] | null,
): NoAccessReason | null {
  if (access.listNamespaces !== false) return null;
  if (!access.kindsSettled) return "pending";
  // "All namespaces" with no namespace known: nothing could be listed.
  if (namespaced && namespaces === null) return "noScope";
  if (!resourceKind) return null;
  return kindAccessIn(access, { kind, plural: resourceKind.plural, namespaced }, namespaces) === "noAccess"
    ? "noAccess"
    : null;
}

/**
 * Why the table of `kind` should say "No access" instead of listing (`null`: list it). `namespaces` is what the table
 * would watch (`useSelectedNamespaces`).
 */
export function useNoAccess(
  clusterId: ClusterId,
  kind: Pick<KindRef, "group" | "kind">,
  resourceKind: ResourceKind | null | undefined,
  namespaced: boolean,
  namespaces: readonly string[] | null | undefined,
): { reason: NoAccessReason | null; listAnyway: () => void } {
  const access = useAccess(clusterId);
  const key = `${clusterId}|${kindKeyOf(kind)}`;
  const [, setTick] = useState(0);
  const reason =
    namespaces === undefined || listedAnyway.has(key)
      ? null
      : reasonOf(access, kind, resourceKind ?? findKind(knownClusterKinds(clusterId), kind), namespaced, namespaces);
  return {
    reason,
    listAnyway: () => {
      listedAnyway.add(key);
      setTick((n) => n + 1);
    },
  };
}

/** The table's place when the user may not list the kind there. */
export function NoAccessTable({
  clusterId,
  title,
  namespaced,
  namespaces,
  reason,
  onListAnyway,
}: {
  clusterId: ClusterId;
  title: string;
  namespaced: boolean;
  namespaces: readonly string[] | null;
  reason: Exclude<NoAccessReason, "pending">;
  onListAnyway: () => void;
}) {
  const { t } = useTranslation();
  const access = useAccess(clusterId);
  const text =
    reason === "noScope"
      ? t("namespaces:noAccess.noScope")
      : namespaced && namespaces
        ? t("namespaces:noAccess.namespaced", { kind: title, namespaces: formatList(namespaces) })
        : t("namespaces:noAccess.cluster", { kind: title });
  return (
    <section className="rt" aria-label={title}>
      <header className="rt__header">
        <h2 className="rt__title">{title}</h2>
        {namespaced && (
          <div className="rt__toolbar">
            <NamespaceFilter clusterId={clusterId} />
          </div>
        )}
      </header>
      <div className="ns-no-access" role="status">
        <p className="ns-no-access__title">
          {reason === "noScope" ? t("namespaces:noAccess.noScopeTitle") : t("namespaces:noAccess.title", { kind: title })}
        </p>
        <p>{text}</p>
        {access.checkedAt !== null && (
          <p>{t("namespaces:check.checkedAt", { time: formatDateTime(access.checkedAt) })}</p>
        )}
        <div className="ns-no-access__actions">
          <Button icon="refresh" disabled={access.status === "checking"} onClick={() => void refreshAccess(clusterId)}>
            {access.status === "checking" ? t("namespaces:check.checking") : t("namespaces:check.again")}
          </Button>
          <Button onClick={onListAnyway}>{t("namespaces:noAccess.listAnyway")}</Button>
        </div>
      </div>
    </section>
  );
}

/** A sidebar entry's mark when the check says the user may not list its kind in the selected namespaces. */
export function KindAccessMark({
  clusterId,
  entry,
  namespaces,
}: {
  clusterId: ClusterId;
  entry: { kind: KindRef; namespaced: boolean } | null;
  namespaces: readonly string[] | null;
}) {
  const { t } = useTranslation();
  const access = useAccess(clusterId);
  if (!entry || access.listNamespaces !== false) return null;
  const resourceKind = findKind(knownClusterKinds(clusterId), entry.kind);
  if (!resourceKind) return null;
  const mark = kindAccessIn(access, { kind: entry.kind, plural: resourceKind.plural, namespaced: entry.namespaced }, namespaces);
  if (mark !== "noAccess") return null;
  return (
    <span className="ns-access-mark" title={t("namespaces:noAccess.mark")}>
      <Icon name="eyeOff" size={12} />
      <span className="visually-hidden">{t("namespaces:noAccess.mark")}</span>
    </span>
  );
}
