// The "Reflection" section of a Secret's or ConfigMap's details (#241), drawn only for objects that carry Reflector's
// annotations. On a mirror: its source (a link), whether it is automatic, and its state — in sync (its
// `reflected-version` is the source's resourceVersion), stale, source missing, not allowed by the source any more, or
// "cannot tell" — with the reason in words. On a source: the namespaces it may be mirrored to and where Reflector keeps
// automatic mirrors (evaluated over the cluster's Namespaces), the mirrors that name it in the namespaces read (≤ 40,
// store.ts) with each one's state, the automatic targets where no mirror is, and what was not checked. Values are never
// read or compared. Read-only.
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { StatusText } from "../../resources";
import { formatDateTime, formatList } from "../../i18n";
import { Block, chips, Fields, KINDS, link, table, type ColumnWrap, type FieldRow } from "../details";
import { judgeMirror, MIRROR_TONE, type MirrorJudgement } from "./judge";
import { hasReflectorAnnotations, reflectedKind, reflectionOf, resourceVersionOf, type ReflectedKind, type Reflection } from "./model";
import { parseSelector, patternIssues } from "./patterns";
import { MAX_LISTED_NAMESPACES, namespacesToRead, sourceView } from "./source";
import { useReflector } from "./store";

const LABELS = "reflector:fields";
const MIRRORS_TABLE = "reflectorMirrors";
const MIRRORS_WRAP: ColumnWrap[] = ["nowrap", "nowrap", "nowrap"];

const typeOf = (kind: ReflectedKind) => (kind === "Secret" ? KINDS.secret : KINDS.configMap);

export function ReflectionSection({ clusterId, obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  const kind = reflectedKind(objectRef.kind);
  if (!obj || !kind || !hasReflectorAnnotations(obj)) return null;
  const reflection = reflectionOf(obj);
  const mirror = reflection.reflects !== undefined || reflection.reflectsInvalid;
  return (
    <Block title={t("reflector:title")}>
      <div className="reflector">
        {mirror && <MirrorView clusterId={clusterId} kind={kind} obj={obj} reflection={reflection} />}
        {(reflection.allowed || reflection.autoEnabled || !mirror) && <SourceDetails clusterId={clusterId} kind={kind} obj={obj} reflection={reflection} />}
        <p className="reflector__note">{t("reflector:explain.valuesNotCompared")}</p>
      </div>
    </Block>
  );
}

interface ViewProps {
  clusterId: ClusterId;
  kind: ReflectedKind;
  obj: KubeObject;
  reflection: Reflection;
}

export function stateWord(t: TFunction, j: MirrorJudgement | undefined, loading: boolean): ReactNode {
  if (!j) return null;
  if (j.state === "unknown" && loading) return <StatusText value={t("reflector:state.loading")} tone="muted" />;
  return <StatusText value={t(`reflector:state.${j.state}`)} tone={MIRROR_TONE[j.state]} />;
}

function MirrorView({ clusterId, kind, obj, reflection }: ViewProps) {
  const { t } = useTranslation();
  const ref = reflection.reflects;
  const state = useReflector(clusterId, ref && ref.namespace ? { kind, namespaces: [ref.namespace] } : null);
  if (!ref) return <p className="reflector__explain">{t("reflector:explain.invalidReflects")}</p>;
  const source = ref.namespace ? state.lookup.get(kind, ref.namespace, ref.name) : null;
  const j = judgeMirror(obj, source, state.lookup.labels)!;
  const namespace = obj.metadata?.namespace ?? "";
  const sourceText = `${ref.namespace}/${ref.name}`;
  const explain: string[] = [];
  if (j.state === "inSync") explain.push(t("reflector:explain.inSync", { kind }));
  if (j.state === "stale")
    explain.push(
      reflection.reflectedVersion
        ? t("reflector:explain.stale", { reflected: reflection.reflectedVersion, current: resourceVersionOf(j.sourceObj) ?? "" })
        : t("reflector:explain.staleNever", { kind }),
    );
  if (j.state === "sourceMissing") explain.push(t("reflector:explain.sourceMissing", { source: sourceText }));
  if (j.state === "notAllowed")
    explain.push(t(reflection.autoReflects ? "reflector:explain.notAllowedAuto" : "reflector:explain.notAllowed", { namespace }));
  if (j.state === "unknown" && !state.loading) explain.push(t("reflector:explain.unknown"));
  if (j.state !== "notAllowed" && j.sourceObj && j.permitted === undefined) explain.push(t("reflector:explain.permittedUnknown", { namespace }));
  const rows: FieldRow[] = [
    ["role", t(reflection.autoReflects ? "reflector:role.autoMirror" : "reflector:role.mirror")],
    ["source", ref.namespace ? link(typeOf(kind), ref.name, ref.namespace, sourceText) : sourceText],
    ["state", stateWord(t, j, state.loading)],
    ["reflectedVersion", reflection.reflectedVersion || null],
    ["sourceVersion", resourceVersionOf(j.sourceObj) ?? null],
    ["reflectedAt", reflection.reflectedAt && !Number.isNaN(Date.parse(reflection.reflectedAt)) ? formatDateTime(reflection.reflectedAt) : null],
  ];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {explain.map((text) => (
        <p key={text} className="reflector__explain">
          {text}
        </p>
      ))}
    </>
  );
}

/** At most `MAX_LISTED_NAMESPACES` names as chips, then how many more. */
function someNamespaces(t: TFunction, names: readonly string[]): ReactNode {
  if (names.length === 0) return t("reflector:values.none");
  const shown = chips(names.slice(0, MAX_LISTED_NAMESPACES));
  const rest = names.length - MAX_LISTED_NAMESPACES;
  if (rest <= 0) return shown;
  return (
    <>
      {shown}
      <span className="reflector__more">{t("reflector:values.more", { count: rest })}</span>
    </>
  );
}

function SourceDetails({ clusterId, kind, obj, reflection }: ViewProps) {
  const { t } = useTranslation();
  const namespace = obj.metadata?.namespace ?? "";
  const name = obj.metadata?.name ?? "";
  // First the own namespace (which also holds the Namespaces list), then every namespace the source may reach.
  const base = useReflector(clusterId, { kind, namespaces: [namespace] });
  const wanted = namespacesToRead(reflection, namespace, base.lookup.namespaceNames(), base.lookup.labels);
  const state = useReflector(clusterId, { kind, namespaces: wanted });
  const view = sourceView(kind, obj, state.lookup);
  const yesNo = (v: boolean) => t(v ? "reflector:values.yes" : "reflector:values.no");
  const patterns = (list: string) => (list ? chips(list.split(",").map((s) => s.trim()).filter(Boolean)) : t("reflector:values.everyNamespace"));
  const rows: FieldRow[] = [
    ["allowed", yesNo(reflection.allowed)],
    ["allowedNamespaces", reflection.allowed ? patterns(reflection.allowedNamespaces) : null],
    ["allowedSelector", reflection.allowedSelector ? <code>{reflection.allowedSelector}</code> : null],
    ["autoEnabled", yesNo(reflection.autoEnabled)],
    ["autoNamespaces", reflection.allowed && reflection.autoEnabled ? patterns(reflection.autoNamespaces) : null],
    ["autoSelector", reflection.autoSelector ? <code>{reflection.autoSelector}</code> : null],
    ["autoTargets", reflection.allowed && reflection.autoEnabled && view.targets ? someNamespaces(t, view.targets.auto.yes) : null],
  ];
  const notes: string[] = [];
  if (reflection.autoEnabled && !reflection.allowed) notes.push(t("reflector:explain.autoNeedsAllowed"));
  for (const list of [reflection.allowedNamespaces, reflection.autoNamespaces])
    for (const issue of patternIssues(list)) notes.push(t(`reflector:patternIssue.${issue.issue}`, { pattern: issue.pattern }));
  for (const selector of [reflection.allowedSelector, reflection.autoSelector])
    if (selector && !parseSelector(selector)) notes.push(t("reflector:explain.selectorInvalid", { selector }));
  const unknown = view.targets ? [...new Set([...view.targets.allowed.unknown, ...view.targets.auto.unknown])] : [];
  if (unknown.length > 0) notes.push(t("reflector:explain.targetsUnknown", { count: unknown.length, namespaces: formatList(unknown.slice(0, MAX_LISTED_NAMESPACES)) }));
  const ref = (o: KubeObject) => link(typeOf(kind), o.metadata?.name, o.metadata?.namespace ?? null, `${o.metadata?.namespace ?? ""}/${o.metadata?.name ?? ""}`);
  const tableRows: ReactNode[][] = [
    ...view.mirrors.map((m) => [
      ref(m.obj),
      t(m.judgement.reflection.autoReflects ? "reflector:values.automatic" : "reflector:values.direct"),
      stateWord(t, m.judgement, state.loading),
    ]),
    ...view.expected.map((e) => [
      `${e.namespace}/${name}`,
      t("reflector:values.automatic"),
      <StatusText key="s" value={t(`reflector:expected.${e.state}`)} tone="warning" />,
    ]),
  ];
  const headers = [t("reflector:headers.mirror"), t("reflector:headers.mode"), t("reflector:headers.state")];
  return (
    <>
      <Fields rows={rows} labelPrefix={LABELS} />
      {notes.map((text) => (
        <p key={text} className="reflector__explain">
          {text}
        </p>
      ))}
      {reflection.allowed && (
        <>
          <h4 className="reflector__heading">{t("reflector:mirrorsTitle")}</h4>
          {tableRows.length > 0
            ? table(MIRRORS_TABLE, headers, tableRows, MIRRORS_WRAP)
            : !state.loading && <p className="reflector__explain">{t("reflector:explain.noMirrors")}</p>}
          {view.expected.some((e) => e.state === "conflict") && <p className="reflector__explain">{t("reflector:explain.conflict")}</p>}
          {view.notChecked.length > 0 && (
            <p className="reflector__explain">
              {t("reflector:explain.notChecked", { count: view.notChecked.length, namespaces: formatList(view.notChecked.slice(0, MAX_LISTED_NAMESPACES)) })}
            </p>
          )}
        </>
      )}
    </>
  );
}
