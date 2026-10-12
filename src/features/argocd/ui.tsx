// Small building blocks of the Argo CD details: status words, times, links. The field list and chips are the
// details panel's own (`Fields` with the prefix `argocd:fields`, `chips`). Values are prepared outside JSX (the i18n
// lint rule forbids string literals there).
import type { ReactNode } from "react";
import { Age } from "../../components";
import { ObjectLink, StatusText } from "../../resources";
import type { Tone } from "../../resources/status";

const isEmpty = (value: ReactNode) => value === null || value === undefined || value === false || value === "";

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
