// The sections this feature adds to the details panel: summary (actions, "deleted" notice), metadata, the
// kind-specific fields and conditions (YAML is in YamlSection.tsx). Each one is registered in index.ts.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ObjectRef } from "../../api";
import { Age } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { findResourceDef, status } from "../../resources";
import { ActionBar } from "./ActionBar";
import { kindView } from "./kinds";
import { useDetailsLife } from "./liveObject";
import { maskedAnnotation } from "./secrets";
import { Block, chips, Fields, inline, KINDS, link, mapChips, muted, strings, table, type FieldRow } from "./ui";

const { arr, get, record, str } = status;

/** Actions of the object; a notice when it was deleted or does not exist. */
export function SummarySection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const life = useDetailsLife(clusterId, objectRef);
  if (life === "deleted" || life === "notFound") {
    const message = t(life === "deleted" ? "details:deleted" : "details:notFound", { kind: objectRef.kind.kind });
    return (
      <div className="dt-notice" role="status" data-life={life}>
        {message}
      </div>
    );
  }
  if (!obj) return null;
  return <ActionBar clusterId={clusterId} kind={objectRef.kind} obj={obj} />;
}

function created(timestamp: string | undefined): ReactNode {
  if (!timestamp) return null;
  return (
    <>
      <Age timestamp={timestamp} /> {muted(timestamp)}
    </>
  );
}

export function MetadataSection({ obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const meta = obj.metadata ?? {};
  const ns = meta.namespace ?? null;
  const hidden = t("details:secret.annotationHidden");
  const annotations = Object.entries(record(meta.annotations)).map(([key, value]) => (
    <li key={key}>
      <span className="dt-annotations__key">{key}</span>
      {maskedAnnotation(objectRef.kind.kind, key) ? (
        muted(hidden)
      ) : (
        <span className="dt-annotations__value">{typeof value === "string" ? value : JSON.stringify(value)}</span>
      )}
    </li>
  ));
  const owners = arr(meta.ownerReferences).map((o) => {
    const kind = str(get(o, "kind")) ?? "";
    const name = str(get(o, "name"));
    return link({ apiVersion: str(get(o, "apiVersion")) ?? "v1", kind }, name, ns, `${kind} ${name ?? ""}`);
  });
  const rows: FieldRow[] = [
    ["created", created(str(meta.creationTimestamp))],
    ["name", meta.name],
    ["namespace", link(KINDS.namespace, meta.namespace)],
    ["uid", meta.uid],
    ["labels", mapChips(meta.labels)],
    ["annotations", annotations.length > 0 ? <ul className="dt-annotations">{annotations}</ul> : null],
    ["finalizers", chips(strings(meta.finalizers))],
    ["controlledBy", inline(owners)],
  ];
  return (
    <Block title={t("details:sections.metadata")}>
      <Fields rows={rows} />
    </Block>
  );
}

/** Fields of the kind (pod containers, service ports, node addresses, …) or the kind's registered `details`. */
export function FieldsSection({ clusterId, objectRef, obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const View = kindView(objectRef.kind);
  const Registered = findResourceDef(objectRef.kind)?.details;
  let content: ReactNode = null;
  if (View) content = <View obj={obj} clusterId={clusterId} objectRef={objectRef} />;
  else if (Registered) content = <Registered obj={obj} />;
  return <Block title={t("details:sections.fields", { kind: objectRef.kind.kind })}>{content}</Block>;
}

export function hasFields(kind: ObjectRef["kind"]): boolean {
  return Boolean(kindView(kind) ?? findResourceDef(kind)?.details);
}

/** `status.conditions` of any kind that has them (workloads, nodes, pods, custom resources, …). */
export function ConditionsSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const conditions = obj ? arr(get(obj, "status", "conditions")).filter((c) => str(get(c, "type"))) : [];
  const rows = conditions.map((c) => {
    const value = str(get(c, "status")) ?? "";
    const since = str(get(c, "lastTransitionTime"));
    return [
      str(get(c, "type")),
      <span key="s" className={`dt-condition dt-condition--${value.toLowerCase()}`}>
        {value}
      </span>,
      str(get(c, "reason")),
      str(get(c, "message")),
      since ? <Age key="a" timestamp={since} /> : null,
    ];
  });
  const content = table(
    [
      t("details:columns.type"),
      t("details:columns.status"),
      t("details:columns.reason"),
      t("details:columns.message"),
      t("details:columns.lastTransition"),
    ],
    rows,
  );
  if (!content) return null;
  return <Block title={t("details:sections.conditions")}>{content}</Block>;
}
