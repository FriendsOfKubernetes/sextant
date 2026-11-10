// What the details sections draw, as the built-in view drew it (pure: objects in, nodes out; details.ts reads them):
//   XRD                    — the kinds it defines, its versions, Established / Offered in plain words, the default
//                            Composition;
//   Composition            — the composite type, the mode and the pipeline's steps with links to the Functions;
//   Provider / Configuration / Function — the package, the revision, Installed / Healthy in plain words;
//   a claim or a composite — Synced / Ready in plain words, the first failing condition, the Composition, the
//                            connection Secret, and the chain Claim → composite → composed resources, each with its
//                            Synced / Ready and first failing condition;
//   a managed resource     — the same state, its ProviderConfig, external name, policies and the composite it
//                            belongs to.
import { ui, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { block, conditionText, element, explain, fieldsOf, formatList, link, message, objectLink, remark, type BlockMemory } from "./dom";
import { t } from "./i18n";
import {
  arr,
  claimRefOf,
  COMPOSITION,
  compositionFields,
  compositionOf,
  conditionStatus,
  conditionTone,
  connectionSecretOf,
  controllerOf,
  explainPackage,
  explainResource,
  explainXrd,
  firstFailing,
  FUNCTION,
  get,
  isPackageKind,
  managedFields,
  objectRefOf,
  packageFields,
  packageHealth,
  parseXrd,
  resourceHealth,
  SECRET,
  sameKind,
  str,
  XRD,
  type Phrase,
  type Role,
  type XrdInfo,
} from "./model";

/** Composed resources read and listed at most. */
export const MAX_CHAIN = 30;

/** The block ids (the built-in `details:sections.fields` and `crossplane:chain.title`; ids are `[A-Za-z0-9._-]`). */
export const FIELDS_BLOCK = "fields";
export const CHAIN_BLOCK = "chain";

/** An object of the chain as it was read: the object, or why it could not be. */
export type Fetched = { obj: KubeObject } | { error: { code: string; message: string } };

export const refKey = (ref: ObjectRef) => `${ref.kind.group}/${ref.kind.kind}/${ref.namespace ?? ""}/${ref.name}`;

const present = (nodes: (Node | null | false | undefined)[]): Node[] => nodes.filter((n): n is Node => Boolean(n));

function explanation(phrase: Phrase | undefined, danger: boolean): HTMLElement | null {
  return phrase ? explain(t(`explain.${phrase.key}`, phrase.params ?? {}), danger) : null;
}

function failingMessage(obj: KubeObject): HTMLElement | null {
  const failing = firstFailing(obj);
  if (!failing) return null;
  return message(
    failing.message
      ? t("failingWithMessage", { type: failing.type, reason: failing.reason ?? "", message: failing.message })
      : t("failing", { type: failing.type, reason: failing.reason ?? "" }),
  );
}

const condition = (obj: KubeObject, type: string) => conditionText(conditionStatus(obj, type));

// ---------- XRDs, Compositions, packages ----------

function xrdView(sextant: Sextant, obj: KubeObject, info: XrdInfo): Node[] {
  const versions = arr(get(obj, "spec", "versions")).map((v) => {
    const name = str(get(v, "name")) ?? "";
    const flags = [get(v, "served") === true ? t("served") : undefined, get(v, "referenceable") === true ? t("referenceable") : undefined].filter((f): f is string => Boolean(f));
    return flags.length > 0 ? t("versionWithFlags", { name, flags: formatList(flags) }) : name;
  });
  return present([
    explanation(explainXrd(info), info.established === "False"),
    fieldsOf([
      ["group", info.group],
      ["compositeKind", info.composite.kind],
      ["claimKind", info.claim?.kind],
      ["versions", ui.chips(versions)],
      ["defaultComposition", link(sextant, COMPOSITION, str(get(obj, "spec", "defaultCompositionRef", "name")))],
      ["established", condition(obj, "Established")],
      ["offered", condition(obj, "Offered")],
    ]),
  ]);
}

function compositionView(sextant: Sextant, obj: KubeObject): Node[] {
  const f = compositionFields(obj);
  const pipeline =
    f.steps.length > 0
      ? ui.table(
          [t("pipeline.step"), t("pipeline.function")],
          f.steps.map((s) => [s.step, link(sextant, FUNCTION, s.fn)]),
        )
      : null;
  return present([
    fieldsOf([
      ["compositeType", f.compositeType],
      ["mode", f.mode],
      ["resources", f.resources > 0 ? String(f.resources) : undefined],
    ]),
    pipeline,
  ]);
}

function packageView(obj: KubeObject): Node[] {
  const f = packageFields(obj);
  return present([
    explanation(explainPackage(obj), packageHealth(obj) === "failed"),
    failingMessage(obj),
    fieldsOf([
      ["package", f.package],
      ["revision", f.revision],
      ["identifier", f.identifier],
      ["activation", f.activation],
      ["installed", condition(obj, "Installed")],
      ["healthy", condition(obj, "Healthy")],
    ]),
  ]);
}

/** The details of an XRD, a Composition or a package: one block titled with the kind, as the built-in section. */
export function kindSection(sextant: Sextant, kind: { group: string; kind: string }, obj: KubeObject, memory: BlockMemory): Node[] {
  return [
    block(memory, FIELDS_BLOCK, kind.kind, () => {
      if (sameKind(kind, XRD)) {
        const info = parseXrd(obj);
        return info ? xrdView(sextant, obj, info) : null;
      }
      if (sameKind(kind, COMPOSITION)) return compositionView(sextant, obj);
      if (isPackageKind(kind)) return packageView(obj);
      return null;
    }),
  ];
}

// ---------- Claims, composites, managed resources ----------

/** One object of the chain: link, Synced, Ready, the first failing condition. */
function chainItem(sextant: Sextant, ref: ObjectRef, fetched: Fetched | undefined, current = false): HTMLElement {
  const obj = fetched && "obj" in fetched ? fetched.obj : undefined;
  const failing = obj ? firstFailing(obj) : undefined;
  const row = element("span", { className: "xp-chain__row" }, element("span", { className: "xp-chain__kind", textContent: ref.kind.kind }), current ? element("span", { textContent: ref.name }) : objectLink(sextant, ref));
  if (current) row.setAttribute("aria-current", "true");
  if (obj) {
    const synced = conditionStatus(obj, "Synced");
    const ready = conditionStatus(obj, "Ready");
    row.append(ui.status(t("syncedIs", { status: synced ?? "–" }), conditionTone(synced)), ui.status(t("readyIs", { status: ready ?? "–" }), conditionTone(ready)));
  }
  if (fetched && "error" in fetched) row.append(element("span", { className: "xp-chain__extra", textContent: fetched.error.code === "notFound" ? t("chain.missing") : t("chain.unreadable") }));
  if (failing?.message) row.append(element("span", { className: "xp-chain__extra", textContent: failing.message }));
  return row;
}

/** What the chain block shows: the objects named and what was read of them. */
export interface Chain {
  /** A claim's composite, when it names one. */
  compositeRef?: ObjectRef;
  /** The composite's composed resources (the shown composite's, or the claim's composite's once read). */
  refs: ObjectRef[];
  byKey: ReadonlyMap<string, Fetched>;
  loading: boolean;
}

function resources(sextant: Sextant, chain: Chain): HTMLElement {
  if (chain.refs.length === 0) return remark(chain.loading ? t("chain.loading") : t("chain.noResources"));
  return element(
    "ul",
    {},
    ...chain.refs.slice(0, MAX_CHAIN).map((r) => element("li", { className: "xp-chain__item" }, chainItem(sextant, r, chain.byKey.get(refKey(r))))),
    chain.refs.length > MAX_CHAIN && element("li", { className: "xp-muted", textContent: t("chain.more", { count: chain.refs.length - MAX_CHAIN }) }),
  );
}

/** Claim → composite → composed resources, or composite → composed resources. */
function chainBlock(sextant: Sextant, ref: ObjectRef, obj: KubeObject, role: Role, chain: Chain, memory: BlockMemory): HTMLElement {
  return block(memory, CHAIN_BLOCK, t("chain.title"), () => {
    const self = element("li", { className: "xp-chain__item" }, chainItem(sextant, ref, { obj }, true));
    if (role === "claim") {
      self.append(
        chain.compositeRef
          ? element(
              "ul",
              {},
              element("li", { className: "xp-chain__item" }, chainItem(sextant, chain.compositeRef, chain.byKey.get(refKey(chain.compositeRef))), resources(sextant, chain)),
            )
          : remark(t("chain.noComposite")),
      );
    } else self.append(resources(sextant, chain));
    return element("ul", { className: "xp-chain" }, self);
  });
}

/** A claim's or composite's details: its state and fields, then the chain. */
export function claimOrCompositeView(sextant: Sextant, ref: ObjectRef, obj: KubeObject, role: Role, chain: Chain, memory: BlockMemory): Node[] {
  const claim = role === "composite" ? claimRefOf(obj) : undefined;
  const secret = connectionSecretOf(obj);
  return [
    block(memory, FIELDS_BLOCK, ref.kind.kind, () =>
      present([
        explanation(explainResource(obj), resourceHealth(obj) === "failed"),
        failingMessage(obj),
        fieldsOf([
          ["role", t(`role.${role}`)],
          ["synced", condition(obj, "Synced")],
          ["ready", condition(obj, "Ready")],
          ["composition", link(sextant, COMPOSITION, compositionOf(obj))],
          ["claim", claim ? objectLink(sextant, objectRefOf(claim, null)) : undefined],
          ["connectionSecret", secret ? link(sextant, SECRET, secret.name, secret.namespace) : undefined],
        ]),
      ]),
    ),
    chainBlock(sextant, ref, obj, role, chain, memory),
  ];
}

/** A managed resource's details. */
export function managedView(sextant: Sextant, ref: ObjectRef, obj: KubeObject, memory: BlockMemory): Node[] {
  const f = managedFields(obj);
  const owner = controllerOf(obj);
  const composite = owner ? objectLink(sextant, objectRefOf({ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.name }, obj.metadata?.namespace ?? null)) : f.composite;
  return [
    block(memory, FIELDS_BLOCK, ref.kind.kind, () =>
      present([
        explanation(explainResource(obj), resourceHealth(obj) === "failed"),
        failingMessage(obj),
        fieldsOf([
          ["role", t("role.managed")],
          ["synced", condition(obj, "Synced")],
          ["ready", condition(obj, "Ready")],
          ["providerConfig", f.providerConfig],
          ["externalName", f.externalName],
          ["deletionPolicy", f.deletionPolicy],
          ["managementPolicies", ui.chips(f.managementPolicies)],
          ["composite", composite],
          ["claim", f.claimName ? (f.claimNamespace ? `${f.claimNamespace}/${f.claimName}` : f.claimName) : undefined],
        ]),
      ]),
    ),
  ];
}

/** A block titled with the kind that says the section cannot tell (the XRDs cannot be read). */
export function unknownView(kind: string, error: string, memory: BlockMemory): Node[] {
  return [block(memory, FIELDS_BLOCK, kind, () => ui.errorState(error))];
}
