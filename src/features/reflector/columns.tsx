// The "Reflection" column of the Secret and ConfigMap tables (#241): on a mirror its state (in sync, stale, source
// missing, not allowed, judged by the shared store over its source's namespace only), on a source "Source" (or
// "Source, mirrored automatically"); empty for every other object, which asks for nothing.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import type { ColumnDef } from "../../resources";
import { stateWord } from "./details";
import { judgeMirror } from "./judge";
import { reflectedKind, reflectionOf, type ReflectedKind } from "./model";
import { useReflector } from "./store";

/** The sort and search value: what the object is to Reflector. */
export function roleOf(obj: KubeObject): "mirror" | "source" | "sourceAuto" | undefined {
  const r = reflectionOf(obj);
  if (r.reflects) return "mirror";
  if (r.allowed) return r.autoEnabled ? "sourceAuto" : "source";
  return undefined;
}

function MirrorCell({ clusterId, kind, obj }: { clusterId: ClusterId; kind: ReflectedKind; obj: KubeObject }) {
  const { t } = useTranslation();
  const ref = reflectionOf(obj).reflects;
  const state = useReflector(clusterId, ref?.namespace ? { kind, namespaces: [ref.namespace] } : null);
  if (!ref) return null;
  const source = ref.namespace ? state.lookup.get(kind, ref.namespace, ref.name) : null;
  return <>{stateWord(t, judgeMirror(obj, source, state.lookup.labels), state.loading)}</>;
}

function SourceCell({ role }: { role: "source" | "sourceAuto" }) {
  const { t } = useTranslation();
  return <span>{t(`reflector:role.${role}`)}</span>;
}

export const reflectionColumn: ColumnDef = {
  id: "reflection",
  titleKey: "reflector:column",
  value: (o) => roleOf(o) ?? "",
  width: "minmax(110px, 1fr)",
  render: (obj, ctx) => {
    const role = roleOf(obj);
    const kind = reflectedKind(ctx.kind);
    if (!role || !kind) return null;
    if (role === "mirror") return <MirrorCell clusterId={ctx.clusterId} kind={kind} obj={obj} />;
    return <SourceCell role={role} />;
  },
};
