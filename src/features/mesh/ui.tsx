// Small pieces the mesh views share: phrases as lines, links to objects, the problems of an object.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { Icon } from "../../components";
import { ObjectLink } from "../../resources";
import { apiVersionOf } from "./kinds";
import type { Ref } from "./istio";
import type { Phrase } from "./phrases";
import { useMeshConfig } from "./store";

export type T = (key: string, options?: Record<string, unknown>) => string;

export const phraseText = (ph: Phrase, t: T) => t(ph.key, ph.params);

/** One paragraph per phrase. */
export function PhraseLines({ phrases, className = "mesh-line" }: { phrases: readonly Phrase[]; className?: string }) {
  const { t } = useTranslation();
  return (
    <>
      {phrases.map((ph, i) => (
        <p key={`${i}:${ph.key}`} className={className}>
          {phraseText(ph, t)}
        </p>
      ))}
    </>
  );
}

/** A link opening the details of `ref`, labelled `label` (default `namespace/name`, or the name in `from`). */
export function meshLink(ref: Ref, label?: string, from?: string): ReactNode {
  if (!ref.name) return null;
  const text = label ?? (ref.namespace && ref.namespace !== from ? `${ref.namespace}/${ref.name}` : ref.name);
  return (
    <ObjectLink
      key={`${ref.kind.kind}/${ref.namespace}/${ref.name}`}
      target={{ apiVersion: apiVersionOf(ref.kind), kind: ref.kind.kind, name: ref.name }}
      namespace={ref.namespace || null}
    >
      {text}
    </ObjectLink>
  );
}

/** The mesh problems of `obj` (VirtualServices and DestinationRules), each a warning line. */
export function ObjectProblems({ clusterId, obj }: { clusterId: ClusterId; obj: KubeObject }) {
  const { t } = useTranslation();
  const config = useMeshConfig(clusterId);
  const uid = obj.metadata?.uid;
  const mine = config.problems.filter((p) => p.uid === uid);
  if (mine.length === 0) return null;
  return (
    <div className="mesh-problems" role="alert">
      {mine.map((p, i) => (
        <p key={i} className="mesh-problem">
          <Icon name="warning" />
          <span>
            <strong>{p.reason}</strong> {t(`problems:messages.mesh${p.reason}`, p.params)}
          </span>
        </p>
      ))}
    </div>
  );
}
