// What an extension may do and what it adds, in plain words: the same text in the consent window and in Permissions.
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AccessRule, Contributions, ExtensionPermissions } from "../../api";
import { Badge, Icon } from "../../components";
import { formatList } from "../../i18n";

/** The rule asks before running only for the actions that change something. */
const CHANGING = new Set(["modify", "delete"]);

/** Whether any rule lets the extension read Secret values (the part that deserves a warning). */
export function readsSecretValues(permissions: ExtensionPermissions): boolean {
  return permissions.rules.some((rule) => rule.actions.includes("secretValues"));
}

/**
 * What one rule allows as one sentence: the actions (a list of labels), then the kinds and the namespaces. Each
 * combination of "all" and "only" has its own text, so a translation puts the words in its own order and case.
 */
function ruleText(rule: AccessRule, actions: string, t: TFunction): string {
  const all = rule.kinds.type === "all";
  const kinds =
    rule.kinds.type === "all" ? undefined : formatList(rule.kinds.kinds.map((k) => (k.group ? `${k.kind} (${k.group})` : k.kind)));
  if (rule.namespaces.type === "all") {
    return all
      ? t("extensions:permissions.rule.allKinds", { actions })
      : t("extensions:permissions.rule.kinds", { actions, kinds });
  }
  const names = rule.namespaces.namespaces;
  const scope = { actions, kinds, count: names.length, names: formatList(names) };
  return all ? t("extensions:permissions.rule.allKindsIn", scope) : t("extensions:permissions.rule.kindsIn", scope);
}

/** "Can read the values of Secrets in …" for a rule that grants them. */
function secretValuesText(rule: AccessRule, t: TFunction): string {
  if (rule.namespaces.type === "all") return t("extensions:permissions.secretValues.all");
  const names = rule.namespaces.namespaces;
  return t("extensions:permissions.secretValues.in", { count: names.length, names: formatList(names) });
}

export function PermissionsView({ permissions }: { permissions: ExtensionPermissions }) {
  const { t } = useTranslation();
  const { clusters, rules } = permissions;
  return (
    <div className="ext-perms">
      <h4 className="ext-perms__heading">{t("extensions:permissions.clusters")}</h4>
      {clusters.type === "all" ? (
        <p className="ext-perms__line">{t("extensions:permissions.clustersAll")}</p>
      ) : (
        <>
          <p className="ext-perms__line">
            {t("extensions:permissions.clustersOnly", { count: clusters.names.length, names: formatList(clusters.names) })}
          </p>
          <p className="settings__hint">{t("extensions:permissions.clustersNote")}</p>
        </>
      )}
      <h4 className="ext-perms__heading">{t("extensions:permissions.access")}</h4>
      {rules.length === 0 ? (
        <p className="ext-perms__line">{t("extensions:permissions.none")}</p>
      ) : (
        <ul className="ext-perms__rules">
          {rules.map((rule, index) => {
            const secret = rule.actions.includes("secretValues");
            const changes = rule.actions.some((a) => CHANGING.has(a));
            const actions = formatList(
              rule.actions.filter((a) => a !== "secretValues").map((a) => t(`extensions:permissions.actionNames.${a}`)),
            );
            return (
              <li key={index} className="ext-perms__rule" data-secret={secret || undefined}>
                {actions && (
                  <span className="ext-perms__text">
                    {ruleText(rule, actions, t)}
                  </span>
                )}
                {secret && (
                  <span className="ext-perms__secret">
                    <Icon name="warning" />
                    {secretValuesText(rule, t)}
                  </span>
                )}
                {changes && (
                  <Badge tone={rule.confirm ? "info" : "warning"}>
                    {rule.confirm ? t("extensions:permissions.asks") : t("extensions:permissions.noAsk")}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rules.length > 0 && <p className="settings__hint">{t("extensions:permissions.clusterWide")}</p>}
    </div>
  );
}

const CONTRIBUTION_KINDS = ["pages", "detailsSections", "actions", "columns", "dockActions"] as const;

/** Titles of what the extension adds, by kind of contribution. */
export function contributionLines(contributes: Contributions): { kind: string; titles: string[] }[] {
  const lines: { kind: string; titles: string[] }[] = CONTRIBUTION_KINDS.map((kind) => ({
    kind,
    titles: contributes[kind].map((item) => item.title),
  }));
  if (contributes.settings) lines.push({ kind: "settings", titles: [contributes.settings.title] });
  return lines.filter((line) => line.titles.length > 0);
}

export function ContributionsView({ contributes }: { contributes: Contributions }) {
  const { t } = useTranslation();
  const lines = contributionLines(contributes);
  if (lines.length === 0) return <p className="ext-perms__line">{t("extensions:consent.noContributions")}</p>;
  return (
    <ul className="ext-contributes">
      {lines.map((line) => (
        <li key={line.kind}>
          <span className="ext-contributes__kind">{t(`extensions:contributes.${line.kind}`)}</span>
          <span>{formatList(line.titles)}</span>
        </li>
      ))}
    </ul>
  );
}
