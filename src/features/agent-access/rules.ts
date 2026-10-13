// Pure helpers of the access rule editor. The core reads `agentAccess` strictly: any field a variant does not have
// (`namespaces` on `{"type":"all"}`, a stray key on a rule or a kind) makes the whole cluster's access read as Off.
// So every value written goes through the builders here, which name each field of the variant they build and never
// copy an old object.
import type {
  AccessAction,
  AccessPreset,
  AccessRule,
  ClusterAccess,
  KindPattern,
  KindScope,
  NamespaceScope,
} from "../../api";

/** Actions in the order they are shown and saved. */
export const ACTIONS: readonly AccessAction[] = ["read", "modify", "delete", "logs", "exec", "portForward", "secretValues"];

/** Presets in the order they are shown. */
export const PRESETS: readonly AccessPreset[] = ["off", "readOnly", "readWrite", "full", "custom"];

/** The pseudo kind of Helm releases in rules (`HELM_RELEASE_*` in the core). */
export const HELM_RELEASE: KindPattern = { group: "helm.sh", kind: "Release" };

export function allNamespaces(): NamespaceScope {
  return { type: "all" };
}

export function onlyNamespaces(names: readonly string[]): NamespaceScope {
  return { type: "only", namespaces: [...names] };
}

export function allKinds(): KindScope {
  return { type: "all" };
}

export function onlyKinds(kinds: readonly KindPattern[]): KindScope {
  return { type: "only", kinds: kinds.map(kindPattern) };
}

export function kindPattern(kind: KindPattern): KindPattern {
  return { group: kind.group, kind: kind.kind };
}

export function makeRule(
  namespaces: NamespaceScope,
  kinds: KindScope,
  actions: readonly AccessAction[],
  confirm: boolean,
): AccessRule {
  return {
    namespaces: namespaces.type === "all" ? allNamespaces() : onlyNamespaces(namespaces.namespaces),
    kinds: kinds.type === "all" ? allKinds() : onlyKinds(kinds.kinds),
    actions: ACTIONS.filter((a) => actions.includes(a)),
    confirm,
  };
}

/** A new rule: everything, read only, asking before it runs anything that changes (the safest start). */
export function newRule(): AccessRule {
  return makeRule(allNamespaces(), allKinds(), ["read"], true);
}

/** The rule with only the fields of its variants (drops anything else a stored value may carry). */
export function cleanRule(rule: AccessRule): AccessRule {
  return makeRule(rule.namespaces, rule.kinds, rule.actions, rule.confirm);
}

/** What is saved for `preset` with `rules`: exactly `{preset, rules}`. */
export function makeAccess(preset: AccessPreset, rules: readonly AccessRule[]): ClusterAccess {
  return { preset, rules: rules.map(cleanRule) };
}

export function withNamespaces(rule: AccessRule, namespaces: NamespaceScope): AccessRule {
  return makeRule(namespaces, rule.kinds, rule.actions, rule.confirm);
}

export function withKinds(rule: AccessRule, kinds: KindScope): AccessRule {
  return makeRule(rule.namespaces, kinds, rule.actions, rule.confirm);
}

export function withActions(rule: AccessRule, actions: readonly AccessAction[]): AccessRule {
  return makeRule(rule.namespaces, rule.kinds, actions, rule.confirm);
}

export function withConfirm(rule: AccessRule, confirm: boolean): AccessRule {
  return makeRule(rule.namespaces, rule.kinds, rule.actions, confirm);
}

export function toggleAction(rule: AccessRule, action: AccessAction, on: boolean): AccessRule {
  const rest = rule.actions.filter((a) => a !== action);
  return withActions(rule, on ? [...rest, action] : rest);
}

/** The same kind: group exactly, kind ignoring ASCII case (as the core compares them). */
export function sameKind(a: KindPattern, b: KindPattern): boolean {
  return a.group.toLowerCase() === b.group.toLowerCase() && a.kind.toLowerCase() === b.kind.toLowerCase();
}

export function kindKey(kind: KindPattern): string {
  return `${kind.group.toLowerCase()}/${kind.kind.toLowerCase()}`;
}

/** `Pod`, `apps/Deployment`, `helm.sh/Release` → a kind; `null` when it is not of that form. */
export function parseKindInput(text: string): KindPattern | null {
  const match = /^\s*(?:([A-Za-z0-9][A-Za-z0-9.-]*)\/)?([A-Za-z][A-Za-z0-9]*)\s*$/.exec(text);
  return match ? { group: match[1] ?? "", kind: match[2]! } : null;
}

const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** A namespace name typed by hand; `null` when Kubernetes would not accept it. */
export function parseNamespaceInput(text: string): string | null {
  const name = text.trim();
  return name.length <= 63 && NAMESPACE_NAME.test(name) ? name : null;
}
