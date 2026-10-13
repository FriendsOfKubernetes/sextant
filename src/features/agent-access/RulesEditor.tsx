// The rules of the "Custom" set: a list of rules, each with namespaces, kinds, actions and "Ask before running".
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type AccessAction, type AccessRule, type ClusterId, type KindPattern, type WatchSpec } from "../../api";
import { Button, Checkbox, Icon, Radio } from "../../components";
import { useClusterKinds } from "../../resources";
import { useClustersStore } from "../clusters/clustersStore";
import { Picker, type PickerItem } from "./Picker";
import {
  ACTIONS,
  allKinds,
  allNamespaces,
  HELM_RELEASE,
  kindKey,
  kindPattern,
  newRule,
  onlyKinds,
  onlyNamespaces,
  parseKindInput,
  parseNamespaceInput,
  sameKind,
  toggleAction,
  withConfirm,
  withKinds,
  withNamespaces,
} from "./rules";

const NAMESPACES: WatchSpec = {
  kind: { group: "", version: "v1", kind: "Namespace" },
  namespaces: null,
  labelSelector: null,
  fieldSelector: null,
  metadataOnly: true,
};

type Unavailable = "notConnected" | "loading" | "failed" | null;

/** A picker row that stands for a kind. */
type KindItem = PickerItem & { pattern: KindPattern };

export interface RulesEditorProps {
  clusterId: ClusterId;
  rules: readonly AccessRule[];
  /** Changes the latest saved rules (several quick edits never overwrite one another). */
  edit: (change: (rules: AccessRule[]) => AccessRule[]) => void;
}

export function RulesEditor({ clusterId, rules, edit }: RulesEditorProps) {
  const { t } = useTranslation();
  const connected = useClustersStore((s) => s.states[clusterId]?.state === "connected");
  const live = connected ? clusterId : null;
  const watch = useWatch(live, NAMESPACES);
  const discovery = useClusterKinds(live);

  const namespaceNames = useMemo(() => {
    const names: string[] = [];
    for (const ns of watch.items.values()) if (ns.metadata?.name) names.push(ns.metadata.name);
    return names.sort();
  }, [watch.items]);
  const namespaceState: Unavailable = !connected
    ? "notConnected"
    : watch.status === "error"
      ? "failed"
      : watch.status === "loading"
        ? "loading"
        : null;

  const kindItems = useMemo<KindItem[]>(() => {
    const byKey = new Map<string, KindItem>();
    byKey.set(kindKey(HELM_RELEASE), helmItem(t));
    for (const k of discovery.kinds ?? []) {
      const pattern = { group: k.kindRef.group, kind: k.kindRef.kind };
      byKey.set(kindKey(pattern), kindItem(pattern, t));
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label) || (a.hint ?? "").localeCompare(b.hint ?? ""));
  }, [discovery.kinds, t]);
  const kindState: Unavailable = !connected ? "notConnected" : discovery.error ? "failed" : discovery.kinds ? null : "loading";

  const update = (index: number, change: (rule: AccessRule) => AccessRule) =>
    edit((current) => current.map((rule, i) => (i === index ? change(rule) : rule)));

  return (
    <div className="aa-rules">
      <h4 className="aa-subtitle">{t("access:rules.title")}</h4>
      {rules.length === 0 && <div className="aa-note">{t("access:rules.none")}</div>}
      {rules.map((rule, index) => (
        <RuleCard
          // The list has no ids; rules are only added at the end and removed, and every field is controlled.
          key={index}
          number={index + 1}
          rule={rule}
          namespaceNames={namespaceNames}
          namespaceState={namespaceState}
          kindItems={kindItems}
          kindState={kindState}
          onChange={(change) => update(index, change)}
          onRemove={() => edit((current) => current.filter((_, i) => i !== index))}
        />
      ))}
      <Button icon="add" onClick={() => edit((current) => [...current, newRule()])}>
        {t("access:rules.add")}
      </Button>
    </div>
  );
}

function kindItem(kind: KindPattern, t: (key: string) => string): KindItem {
  if (sameKind(kind, HELM_RELEASE)) return helmItem(t);
  return { key: kindKey(kind), label: kind.kind, hint: kind.group || t("access:kinds.coreGroup"), pattern: kindPattern(kind) };
}

function helmItem(t: (key: string) => string): KindItem {
  return {
    key: kindKey(HELM_RELEASE),
    label: t("access:kinds.helm"),
    hint: `${HELM_RELEASE.group}/${HELM_RELEASE.kind}`,
    pattern: kindPattern(HELM_RELEASE),
  };
}

interface RuleCardProps {
  number: number;
  rule: AccessRule;
  namespaceNames: readonly string[];
  namespaceState: Unavailable;
  kindItems: readonly KindItem[];
  kindState: Unavailable;
  onChange: (change: (rule: AccessRule) => AccessRule) => void;
  onRemove: () => void;
}

function RuleCard({ number, rule, namespaceNames, namespaceState, kindItems, kindState, onChange, onRemove }: RuleCardProps) {
  const { t } = useTranslation();
  const name = `rule-${number}`;
  const chosenNamespaces = rule.namespaces.type === "only" ? rule.namespaces.namespaces : [];
  const chosenKinds = rule.kinds.type === "only" ? rule.kinds.kinds : [];

  const namespaceItems = useMemo<PickerItem[]>(() => namespaceNames.map((n) => ({ key: n, label: n })), [namespaceNames]);

  /** Applies to the latest rule: a namespace toggled twice quickly stays consistent. */
  const changeNamespaces = (change: (names: string[]) => string[]) =>
    onChange((r) => withNamespaces(r, onlyNamespaces(change(r.namespaces.type === "only" ? r.namespaces.namespaces : []))));
  const changeKinds = (change: (kinds: KindPattern[]) => KindPattern[]) =>
    onChange((r) => withKinds(r, onlyKinds(change(r.kinds.type === "only" ? r.kinds.kinds : []))));

  return (
    <section className="aa-rule" role="group" aria-label={t("access:rules.rule", { number })}>
      <header className="aa-rule__header">
        <h5>{t("access:rules.rule", { number })}</h5>
        <Button
          iconOnly
          icon="delete"
          size="compact"
          label={t("access:rules.remove", { number })}
          onClick={onRemove}
        />
      </header>

      <fieldset className="aa-group">
        <legend>{t("access:namespaces.legend")}</legend>
        <label className="aa-choice">
          <Radio
            name={`${name}-namespaces`}
            checked={rule.namespaces.type === "all"}
            onChange={() => onChange((r) => withNamespaces(r, allNamespaces()))}
          />
          {t("access:namespaces.all")}
        </label>
        <label className="aa-choice">
          <Radio
            name={`${name}-namespaces`}
            checked={rule.namespaces.type === "only"}
            onChange={() => onChange((r) => withNamespaces(r, onlyNamespaces([])))}
          />
          {t("access:namespaces.only")}
        </label>
        {rule.namespaces.type === "only" && (
          <>
            {chosenNamespaces.length === 0 && <div className="aa-note">{t("access:namespaces.empty")}</div>}
            <Picker
              filterLabel={t("access:namespaces.filter")}
              addLabel={t("access:namespaces.add")}
              addPlaceholder={t("access:namespaces.addPlaceholder")}
              addButtonLabel={t("access:namespaces.addButton")}
              invalidText={t("access:namespaces.invalid")}
              items={namespaceItems}
              chosen={chosenNamespaces.map((n) => ({ key: n, label: n }))}
              unavailable={namespaceState}
              onToggle={(key, on) =>
                changeNamespaces((names) => (on ? (names.includes(key) ? names : [...names, key]) : names.filter((n) => n !== key)))
              }
              onAdd={(text) => {
                const parsed = parseNamespaceInput(text);
                if (parsed === null) return false;
                changeNamespaces((names) => (names.includes(parsed) ? names : [...names, parsed]));
                return true;
              }}
            />
          </>
        )}
        {rule.namespaces.type === "only" && <div className="aa-note">{t("access:namespaces.clusterOnly")}</div>}
      </fieldset>

      <fieldset className="aa-group">
        <legend>{t("access:kinds.legend")}</legend>
        <label className="aa-choice">
          <Radio
            name={`${name}-kinds`}
            checked={rule.kinds.type === "all"}
            onChange={() => onChange((r) => withKinds(r, allKinds()))}
          />
          {t("access:kinds.all")}
        </label>
        <label className="aa-choice">
          <Radio
            name={`${name}-kinds`}
            checked={rule.kinds.type === "only"}
            onChange={() => onChange((r) => withKinds(r, onlyKinds([])))}
          />
          {t("access:kinds.only")}
        </label>
        {rule.kinds.type === "only" && (
          <>
            {chosenKinds.length === 0 && <div className="aa-note">{t("access:kinds.empty")}</div>}
            <Picker
              filterLabel={t("access:kinds.filter")}
              addLabel={t("access:kinds.add")}
              addPlaceholder={t("access:kinds.addPlaceholder")}
              addButtonLabel={t("access:kinds.addButton")}
              invalidText={t("access:kinds.invalid")}
              items={kindItems}
              chosen={chosenKinds.map((k) => kindItem(k, t))}
              unavailable={kindState}
              limit={150}
              moreText={(count) => t("access:kinds.more", { count })}
              onToggle={(key, on) => {
                const known = kindItems.find((i) => i.key === key);
                changeKinds((kinds) => {
                  if (!on) return kinds.filter((k) => kindKey(k) !== key);
                  if (kinds.some((k) => kindKey(k) === key) || !known) return kinds;
                  return [...kinds, known.pattern];
                });
              }}
              onAdd={(text) => {
                const parsed = parseKindInput(text);
                if (parsed === null) return false;
                changeKinds((kinds) => (kinds.some((k) => sameKind(k, parsed)) ? kinds : [...kinds, parsed]));
                return true;
              }}
            />
          </>
        )}
      </fieldset>

      <fieldset className="aa-group">
        <legend>{t("access:actions.legend")}</legend>
        <div className="aa-actions">
          {ACTIONS.map((action) => (
            <ActionBox key={action} action={action} rule={rule} onChange={onChange} />
          ))}
        </div>
        {rule.actions.includes("secretValues") && (
          <div className="aa-warning" role="note">
            <Icon name="warning" />
            <span>{t("access:secretWarning")}</span>
          </div>
        )}
      </fieldset>

      <div className="aa-confirm">
        <label className="aa-choice">
          <Checkbox
            checked={rule.confirm}
            onChange={(e) => {
              // Read now: the updater runs later, when a controlled checkbox has already gone back to its value.
              const on = e.target.checked;
              onChange((r) => withConfirm(r, on));
            }}
          />
          {t("access:confirm.label")}
        </label>
        <div className="aa-note">{t("access:confirm.hint")}</div>
      </div>
    </section>
  );
}

function ActionBox({
  action,
  rule,
  onChange,
}: {
  action: AccessAction;
  rule: AccessRule;
  onChange: (change: (rule: AccessRule) => AccessRule) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="aa-choice">
      <Checkbox
        checked={rule.actions.includes(action)}
        onChange={(e) => {
          const on = e.target.checked;
          onChange((r) => toggleAction(r, action, on));
        }}
      />
      {t(`access:actions.${action}`)}
    </label>
  );
}
