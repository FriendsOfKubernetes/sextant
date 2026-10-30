// The sections this feature adds to the details panel: summary (actions, "deleted" notice), metadata, the
// kind-specific fields and conditions (YAML is in YamlSection.tsx). Each one is registered in index.ts.
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ObjectRef } from "../../api";
import { Age, Button } from "../../components";
import type { DetailsSectionProps } from "../../layout/details/registry";
import { findResourceDef, status } from "../../resources";
import { cleanText } from "../../resources/uri";
import { ActionBar } from "./ActionBar";
import { kindView } from "./kinds";
import { useDetailsLife } from "./liveObject";
import { listedAnnotation, shownAnnotation } from "./secrets";
import { Block, breakable, chips, Fields, inline, KINDS, link, mapChips, muted, strings, table, type ColumnWrap, type FieldRow } from "./ui";

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

/** Longer than this, an annotation value is folded (so is a JSON object or array longer than `LONG_JSON`). */
export const LONG_ANNOTATION = 200;
const LONG_JSON = 40;
const COPIED_MS = 3000;

/** Whether an annotation value is folded by default: long, or a JSON document (`last-applied-configuration`). */
export function isLongAnnotation(value: string): boolean {
  if (value.length > LONG_ANNOTATION) return true;
  const text = value.trim();
  if (text.length <= LONG_JSON || !/^[[{]/.test(text)) return false;
  try {
    return typeof JSON.parse(text) === "object";
  } catch {
    return false;
  }
}

/**
 * An annotation value. A long one (or JSON, like `kubectl.kubernetes.io/last-applied-configuration`) is folded behind
 * "Show" so it does not push the rest of the panel down; it can be copied folded or not.
 */
function AnnotationValue({ name, value }: { name: string; value: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!isLongAnnotation(value)) return <span className="dt-annotations__value">{value}</span>;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="dt-annotations__long">
      <span className="dt-annotations__tools">
        <Button
          size="compact"
          icon={open ? "chevronDown" : "chevronRight"}
          aria-expanded={open}
          aria-label={t(open ? "details:annotations.hideValue" : "details:annotations.showValue", { key: name })}
          onClick={() => setOpen(!open)}
        >
          {t(open ? "details:annotations.hide" : "details:annotations.show")}
        </Button>
        <Button iconOnly size="compact" icon="copy" label={t("details:annotations.copy", { key: name })} onClick={() => void copy()} />
        {open ? null : muted(t("details:annotations.length", { count: value.length }))}
        {copied && (
          <span role="status" className="dt-muted">
            {t("details:annotations.copied")}
          </span>
        )}
      </span>
      {open && <span className="dt-annotations__value dt-annotations__value--long">{value}</span>}
    </span>
  );
}

export function MetadataSection({ obj, objectRef }: DetailsSectionProps) {
  const { t } = useTranslation();
  if (!obj) return null;
  const meta = obj.metadata ?? {};
  const ns = meta.namespace ?? null;
  const hidden = t("details:secret.annotationHidden");
  const annotations = Object.entries(record(meta.annotations))
    .filter(([key]) => listedAnnotation(objectRef.kind.kind, key))
    .map(([key, value]) => {
      const shown = shownAnnotation(objectRef.kind.kind, key, typeof value === "string" ? value : JSON.stringify(value));
      return (
        <li key={key}>
          <span className="dt-annotations__key">{key}</span>
          {shown === null ? muted(hidden) : <AnnotationValue name={key} value={shown} />}
        </li>
      );
    });
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
    <Block id="details:sections.metadata" title={t("details:sections.metadata")}>
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
  return <Block id="details:sections.fields" title={t("details:sections.fields", { kind: objectRef.kind.kind })}>{content}</Block>;
}

export function hasFields(kind: ObjectRef["kind"]): boolean {
  return Boolean(kindView(kind) ?? findResourceDef(kind)?.details);
}

// Type, status, reason and age stay on one line; the message wraps between words.
const CONDITION_COLUMNS: readonly ColumnWrap[] = ["nowrap", "nowrap", "nowrap", undefined, "nowrap"];

/** `status.conditions` of any kind that has them (workloads, nodes, pods, custom resources, …). */
export function ConditionsSection({ obj }: DetailsSectionProps) {
  const { t } = useTranslation();
  const conditions = obj ? arr(get(obj, "status", "conditions")).filter((c) => str(get(c, "type"))) : [];
  const rows = conditions.map((c) => {
    const value = str(get(c, "status")) ?? "";
    const since = str(get(c, "lastTransitionTime"));
    // Controllers write what they saw into messages: a URI's credentials, signed query or fragment are cut (#259).
    const message = cleanText(str(get(c, "message")));
    return [
      str(get(c, "type")),
      <span key="s" className={`dt-condition dt-condition--${value.toLowerCase()}`}>
        {value}
      </span>,
      str(get(c, "reason")),
      message ? breakable(message) : null,
      since ? <Age key="a" timestamp={since} /> : null,
    ];
  });
  const content = table(
    "conditions",
    [
      t("details:columns.type"),
      t("details:columns.status"),
      t("details:columns.reason"),
      t("details:columns.message"),
      t("details:columns.lastTransition"),
    ],
    rows,
    CONDITION_COLUMNS,
  );
  if (!content) return null;
  return <Block id="details:sections.conditions" title={t("details:sections.conditions")}>{content}</Block>;
}
