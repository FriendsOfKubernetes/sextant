// Details of Crossplane objects (#213):
//   XRD                    — the kinds it defines, its versions, Established / Offered in plain words, the default
//                            Composition;
//   Composition            — the composite type, the mode and the pipeline's steps with links to the Functions;
//   Provider / Configuration / Function — the package, the revision, Installed / Healthy in plain words;
//   a claim or a composite — Synced / Ready in plain words, the first failing condition, the Composition, the
//                            connection Secret, and the chain Claim → composite → composed resources, each with its
//                            Synced / Ready and first failing condition (read once per change, `chain.ts`);
//   a managed resource     — the same state, its ProviderConfig, external name, policies and the composite it
//                            belongs to.
// Claims and composites are told by the XRDs (their kinds), managed resources by their shape (`spec.forProvider` or
// `spec.providerConfigRef`). Read-only.
import { useTranslation } from "react-i18next";
import { useWatch, type KindRef, type KubeObject, type ObjectRef } from "../../api";
import { formatList } from "../../i18n/format";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { status, StatusText } from "../../resources";
import { apiVersionOf as refApiVersion } from "../../resources/refs";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { MAX_CHAIN, refKey, useChainObjects, type Fetched } from "./chain";
import { useServed } from "./hooks";
import {
  apiVersionOf,
  claimRefOf,
  COMPOSITION,
  compositionFields,
  compositionOf,
  conditionStatus,
  conditionTone,
  connectionSecretOf,
  crossplaneKind,
  explainPackage,
  explainResource,
  explainXrd,
  firstFailing,
  FUNCTION,
  isPackageKind,
  looksManaged,
  managedFields,
  objectRefOf,
  packageFields,
  packageHealth,
  parseXrd,
  resourceHealth,
  resourceRefOf,
  resourceRefsOf,
  roleOf,
  sameKind,
  XRD,
  type Phrase,
  type Role,
  type XrdInfo,
} from "./model";

const { arr, get, str } = status;
const LABELS = "crossplane:fields";
const PIPELINE_TABLE = "crossplanePipeline";
const PIPELINE_WRAP: ColumnWrap[] = ["nowrap", undefined];
const typeOf = (kind: KindRef) => ({ apiVersion: apiVersionOf(kind), kind: kind.kind });

function objectLink(ref: ObjectRef) {
  return link({ apiVersion: refApiVersion(ref.kind), kind: ref.kind.kind }, ref.name, ref.namespace, `${ref.kind.kind}/${ref.name}`);
}

function Explanation({ phrase, danger }: { phrase: Phrase | undefined; danger: boolean }) {
  const { t } = useTranslation();
  if (!phrase) return null;
  return <p className={danger ? "cm-explain cm-explain--danger" : "cm-explain"}>{t(`crossplane:explain.${phrase.key}`, phrase.params ?? {})}</p>;
}

function Condition({ obj, type }: { obj: KubeObject; type: string }) {
  const value = conditionStatus(obj, type);
  return value ? <StatusText value={value} tone={conditionTone(value)} /> : null;
}

function FailingMessage({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const failing = firstFailing(obj);
  if (!failing) return null;
  const text = failing.message ? t("crossplane:failingWithMessage", { type: failing.type, reason: failing.reason ?? "", message: failing.message }) : t("crossplane:failing", { type: failing.type, reason: failing.reason ?? "" });
  return <p className="cm-message">{text}</p>;
}

// ---------- XRDs, Compositions, packages ----------

function XrdView({ obj, info }: { obj: KubeObject; info: XrdInfo }) {
  const { t } = useTranslation();
  const versions = arr(get(obj, "spec", "versions")).map((v) => {
    const name = str(get(v, "name")) ?? "";
    const flags = [get(v, "served") === true ? t("crossplane:served") : undefined, get(v, "referenceable") === true ? t("crossplane:referenceable") : undefined].filter(
      (f): f is string => Boolean(f),
    );
    return flags.length > 0 ? t("crossplane:versionWithFlags", { name, flags: formatList(flags) }) : name;
  });
  const rows: FieldRow[] = [
    ["group", info.group],
    ["compositeKind", info.composite.kind],
    ["claimKind", info.claim?.kind],
    ["versions", chips(versions)],
    ["defaultComposition", link(typeOf(COMPOSITION), str(get(obj, "spec", "defaultCompositionRef", "name")))],
    ["established", <Condition key="e" obj={obj} type="Established" />],
    ["offered", <Condition key="o" obj={obj} type="Offered" />],
  ];
  return (
    <>
      <Explanation phrase={explainXrd(info)} danger={info.established === "False"} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

function CompositionView({ obj }: { obj: KubeObject }) {
  const { t } = useTranslation();
  const f = compositionFields(obj);
  const pipeline = table(PIPELINE_TABLE, [t("crossplane:pipeline.step"), t("crossplane:pipeline.function")], f.steps.map((s) => [s.step, link(typeOf(FUNCTION), s.fn)]), PIPELINE_WRAP);
  const rows: FieldRow[] = [
    ["compositeType", f.compositeType],
    ["mode", f.mode],
    ["resources", f.resources > 0 ? String(f.resources) : undefined],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {pipeline}
    </>
  );
}

function PackageView({ obj }: { obj: KubeObject }) {
  const f = packageFields(obj);
  const rows: FieldRow[] = [
    ["package", f.package],
    ["revision", f.revision],
    ["identifier", f.identifier],
    ["activation", f.activation],
    ["installed", <Condition key="i" obj={obj} type="Installed" />],
    ["healthy", <Condition key="h" obj={obj} type="Healthy" />],
  ];
  return (
    <>
      <Explanation phrase={explainPackage(obj)} danger={packageHealth(obj) === "failed"} />
      <FailingMessage obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </>
  );
}

export function CrossplaneSection({ objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const def = crossplaneKind(objectRef.kind);
  if (!obj || !def) return null;
  let view = null;
  if (sameKind(def.kind, XRD)) {
    const info = parseXrd(obj);
    view = info ? <XrdView obj={obj} info={info} /> : null;
  } else if (sameKind(def.kind, COMPOSITION)) view = <CompositionView obj={obj} />;
  else if (isPackageKind(def.kind)) view = <PackageView obj={obj} />;
  return <Block title={t("details:sections.fields", { kind: def.kind.kind })}>{view}</Block>;
}

// ---------- Claims, composites, managed resources ----------

/** One object of the chain: link, Synced, Ready, the first failing condition. */
function ChainItem({ objRef, fetched, current }: { objRef: ObjectRef; fetched: Fetched | undefined; current?: boolean }) {
  const { t } = useTranslation();
  const obj = fetched && "obj" in fetched ? fetched.obj : undefined;
  const failing = obj ? firstFailing(obj) : undefined;
  return (
    <span className="cm-chain__row" aria-current={current ? "true" : undefined}>
      <span className="cm-chain__kind">{objRef.kind.kind}</span>
      {current ? <span>{objRef.name}</span> : objectLink(objRef)}
      {obj && (
        <>
          <StatusText value={t("crossplane:syncedIs", { status: conditionStatus(obj, "Synced") ?? "–" })} tone={conditionTone(conditionStatus(obj, "Synced"))} />
          <StatusText value={t("crossplane:readyIs", { status: conditionStatus(obj, "Ready") ?? "–" })} tone={conditionTone(conditionStatus(obj, "Ready"))} />
        </>
      )}
      {fetched && "error" in fetched && (
        <span className="cm-chain__extra">{fetched.error.code === "notFound" ? t("crossplane:chain.missing") : t("crossplane:chain.unreadable")}</span>
      )}
      {failing?.message && <span className="cm-chain__extra">{failing.message}</span>}
    </span>
  );
}

function Resources({ refs, byKey, loading }: { refs: ObjectRef[]; byKey: Map<string, Fetched>; loading: boolean }) {
  const { t } = useTranslation();
  if (refs.length === 0) return <p className="cm-muted">{loading ? t("crossplane:chain.loading") : t("crossplane:chain.noResources")}</p>;
  return (
    <ul>
      {refs.slice(0, MAX_CHAIN).map((r) => (
        <li key={refKey(r)} className="cm-chain__item">
          <ChainItem objRef={r} fetched={byKey.get(refKey(r))} />
        </li>
      ))}
      {refs.length > MAX_CHAIN && <li className="cm-muted">{t("crossplane:chain.more", { count: refs.length - MAX_CHAIN })}</li>}
    </ul>
  );
}

function composedRefs(composite: KubeObject | undefined): ObjectRef[] {
  if (!composite) return [];
  return resourceRefsOf(composite).map((r) => objectRefOf(r, composite.metadata?.namespace ?? null));
}

/** Claim → composite → composed resources, or composite → composed resources. */
function Chain({ clusterId, objectRef, obj, role }: { clusterId: string; objectRef: ObjectRef; obj: KubeObject; role: Role }) {
  const { t } = useTranslation();
  const stamp = str(obj.metadata?.resourceVersion) ?? "";
  const claimTarget = role === "claim" ? resourceRefOf(obj) : undefined;
  const compositeRef = claimTarget ? objectRefOf(claimTarget, obj.metadata?.namespace ?? null) : undefined;
  const upper = useChainObjects(clusterId, compositeRef ? [compositeRef] : [], stamp);
  const fetchedComposite = compositeRef ? upper.byKey.get(refKey(compositeRef)) : undefined;
  const composite = role === "composite" ? obj : fetchedComposite && "obj" in fetchedComposite ? fetchedComposite.obj : undefined;
  const refs = composedRefs(composite);
  const lower = useChainObjects(clusterId, refs, `${stamp}|${str(composite?.metadata?.resourceVersion) ?? ""}`);
  const loading = upper.loading || lower.loading;
  const self = <ChainItem objRef={objectRef} fetched={{ obj }} current />;
  return (
    <Block title={t("crossplane:chain.title")}>
      <ul className="cm-chain">
        <li className="cm-chain__item">
          {self}
          {role === "claim" ? (
            compositeRef ? (
              <ul>
                <li className="cm-chain__item">
                  <ChainItem objRef={compositeRef} fetched={fetchedComposite} />
                  <Resources refs={refs} byKey={lower.byKey} loading={loading} />
                </li>
              </ul>
            ) : (
              <p className="cm-muted">{t("crossplane:chain.noComposite")}</p>
            )
          ) : (
            <Resources refs={refs} byKey={lower.byKey} loading={loading} />
          )}
        </li>
      </ul>
    </Block>
  );
}

function ClaimOrComposite({ clusterId, objectRef, obj, role }: { clusterId: string; objectRef: ObjectRef; obj: KubeObject; role: Role }) {
  const { t } = useTranslation();
  const claim = role === "composite" ? claimRefOf(obj) : undefined;
  const secret = connectionSecretOf(obj);
  const rows: FieldRow[] = [
    ["role", t(`crossplane:role.${role}`)],
    ["synced", <Condition key="s" obj={obj} type="Synced" />],
    ["ready", <Condition key="r" obj={obj} type="Ready" />],
    ["composition", link(typeOf(COMPOSITION), compositionOf(obj))],
    ["claim", claim ? objectLink(objectRefOf(claim, null)) : undefined],
    ["connectionSecret", secret ? link(KINDS.secret, secret.name, secret.namespace) : undefined],
  ];
  return (
    <>
      <Block title={t("details:sections.fields", { kind: objectRef.kind.kind })}>
        <Explanation phrase={explainResource(obj)} danger={resourceHealth(obj) === "failed"} />
        <FailingMessage obj={obj} />
        <Fields rows={rows} labelPrefix={LABELS} />
      </Block>
      <Chain clusterId={clusterId} objectRef={objectRef} obj={obj} role={role} />
    </>
  );
}

function ManagedView({ objectRef, obj }: { objectRef: ObjectRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const f = managedFields(obj);
  const owner = status.controllerOf(obj);
  const composite = owner ? objectLink(objectRefOf({ apiVersion: owner.apiVersion, kind: owner.kind, name: owner.name }, obj.metadata?.namespace ?? null)) : f.composite;
  const rows: FieldRow[] = [
    ["role", t("crossplane:role.managed")],
    ["synced", <Condition key="s" obj={obj} type="Synced" />],
    ["ready", <Condition key="r" obj={obj} type="Ready" />],
    ["providerConfig", f.providerConfig],
    ["externalName", f.externalName],
    ["deletionPolicy", f.deletionPolicy],
    ["managementPolicies", chips(f.managementPolicies)],
    ["composite", composite],
    ["claim", f.claimName ? (f.claimNamespace ? `${f.claimNamespace}/${f.claimName}` : f.claimName) : undefined],
  ];
  return (
    <Block title={t("details:sections.fields", { kind: objectRef.kind.kind })}>
      <Explanation phrase={explainResource(obj)} danger={resourceHealth(obj) === "failed"} />
      <FailingMessage obj={obj} />
      <Fields rows={rows} labelPrefix={LABELS} />
    </Block>
  );
}

/** The XRDs the cluster defines (one shared watch, the store's), `[]` when it serves none. */
function useXrds(clusterId: string): XrdInfo[] {
  const served = useServed(clusterId, XRD);
  const state = useWatch(clusterId, served ? { kind: served, namespaces: null, labelSelector: null, fieldSelector: null } : null);
  return [...state.items.values()].map(parseXrd).filter((x): x is XrdInfo => x !== undefined);
}

export function CrossplaneResourceSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const xrds = useXrds(clusterId);
  if (!obj) return null;
  const role = roleOf(objectRef.kind, xrds);
  if (role) return <ClaimOrComposite clusterId={clusterId} objectRef={objectRef} obj={obj} role={role} />;
  if (looksManaged(obj)) return <ManagedView objectRef={objectRef} obj={obj} />;
  return null;
}

/** Kinds of installed APIs that may be Crossplane's: not built in, not Kubernetes' own groups, not the static kinds. */
export function mayBeCrossplaneResource(kind: KindRef): boolean {
  return kind.group.includes(".") && !kind.group.endsWith(".k8s.io") && !crossplaneKind(kind) && kind.group !== "pkg.crossplane.io";
}
