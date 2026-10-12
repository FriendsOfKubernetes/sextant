// Small building blocks of the Argo CD details: a field list labelled from `argocd:fields.*`, chips, status words.
// Values are prepared outside JSX (the i18n lint rule forbids string literals there).
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Age } from "../../components";
import { ObjectLink, StatusText } from "../../resources";
import type { Tone } from "../../resources/status";

/** `[key under argocd:fields, value]`; rows with an empty value are left out. */
export type ArgoFieldRow = readonly [key: string, value: ReactNode];

const isEmpty = (value: ReactNode) => value === null || value === undefined || value === false || value === "";

export function ArgoFields({ rows }: { rows: ArgoFieldRow[] }) {
  const { t } = useTranslation();
  const shown = rows.filter(([, value]) => !isEmpty(value));
  if (shown.length === 0) return null;
  return (
    <dl className="dt-fields">
      {shown.map(([key, value]) => (
        <FieldRow key={key} label={t(`argocd:fields.${key}`)} value={value} />
      ))}
    </dl>
  );
}

function FieldRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="dt-fields__label">{label}</dt>
      <dd className="dt-fields__value">{value}</dd>
    </>
  );
}

export function chipList(values: (string | undefined)[]): ReactNode {
  const list = values.filter((v): v is string => Boolean(v));
  if (list.length === 0) return null;
  return (
    <span className="dt-chips">
      {list.map((v, i) => (
        <span key={`${i}:${v}`} className="dt-chip">
          {v}
        </span>
      ))}
    </span>
  );
}

export function statusWord(value: string | undefined, tone: (v: string) => Tone): ReactNode {
  return value ? <StatusText value={value} tone={tone(value)} /> : null;
}

/** A status word followed by a muted explanation. */
export function withMessage(word: ReactNode, message: string | undefined): ReactNode {
  if (!word && !message) return null;
  return (
    <span className="argo-with-message">
      {word}
      {message && <span className="dt-muted">{message}</span>}
    </span>
  );
}

/** "3m" next to the timestamp itself. */
export function when(timestamp: string | undefined): ReactNode {
  if (!timestamp) return null;
  return (
    <span className="argo-when">
      <Age timestamp={timestamp} /> <span className="dt-muted">{timestamp}</span>
    </span>
  );
}

/** A link opening the details of an object, labelled with its name. */
export function objectLink(apiVersion: string, kind: string, name: string | undefined, namespace: string | null): ReactNode {
  if (!name) return null;
  return (
    <ObjectLink key={`${kind}/${namespace ?? ""}/${name}`} target={{ apiVersion, kind, name }} namespace={namespace}>
      {name}
    </ObjectLink>
  );
}

/** Several nodes in a wrapping row; `null` when there are none. */
export function inlineList(nodes: ReactNode[]): ReactNode {
  const list = nodes.filter((n) => !isEmpty(n));
  return list.length > 0 ? <span className="dt-links">{list}</span> : null;
}
