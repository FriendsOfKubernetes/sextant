// The "Event path" block of the Eventing details (#234): the tree of eventingPath.ts — the sources that send to the
// hub, the hub (Broker or Channel), its Triggers or Subscriptions, and their subscribers and replies — with the opened
// object marked, each object a link with its state, and each destination with the address it resolved to.
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClusterId, KindRef, KubeObject } from "../../api";
import { StatusText } from "../../resources";
import { formatList, formatParts } from "../../i18n/format";
import { Block, link } from "../details";
import { BROKER, groupOf, isChannelKind, type FilterTerm } from "./eventing";
import { eventPath, pathNeeds, type PathLists, type PathNode } from "./eventingPath";
import { usePathLists } from "./eventingHooks";
import { HEALTH_TONE, healthOf, sameKind } from "./model";

/** One filter term in words. */
export function useFilterWords() {
  const { t } = useTranslation();
  const words = (term: FilterTerm): string => {
    switch (term.op) {
      case "exact":
      case "prefix":
      case "suffix":
        return t(`knative:eventing.filter.${term.op}`, { attribute: term.attribute, value: term.value });
      case "anyValue":
        return t("knative:eventing.filter.anyValue", { attribute: term.attribute });
      case "cesql":
        return t("knative:eventing.filter.cesql", { expression: term.expression });
      case "all":
      case "any":
      case "not":
        return t(`knative:eventing.filter.${term.op}`, { terms: formatList(term.terms.map(words)) });
    }
  };
  return words;
}

/** Roles whose label is shown before the kind (a hub, Trigger, Subscription or source says what it is by its kind). */
const LABELLED = new Set(["sink", "subscriber", "reply", "filter"]);

function NodeItem({ node, lists }: { node: PathNode; lists: PathLists }) {
  const { t } = useTranslation();
  const words = useFilterWords();
  const health = node.obj ? healthOf(node.obj) : undefined;
  const name = node.name
    ? node.current
      ? <strong>{node.name}</strong>
      : node.kind
        ? link({ apiVersion: node.apiVersion ?? "v1", kind: node.kind }, node.name, node.namespace ?? null)
        : node.name
    : null;
  const nodeKind = { group: groupOf(node.apiVersion), kind: node.kind ?? "" };
  let empty: ReactNode = null;
  if (node.children.length === 0 && node.kind) {
    if (sameKind(nodeKind, BROKER) && lists.triggers) empty = <p className="cm-muted">{t("knative:eventing.path.noTriggers")}</p>;
    else if (isChannelKind(nodeKind) && lists.subscriptions) empty = <p className="cm-muted">{t("knative:eventing.path.noSubscriptions")}</p>;
  }
  const filter = node.filter ? (node.filter.length === 0 ? t("knative:eventing.filter.none") : formatParts(node.filter.map(words))) : undefined;
  return (
    <li className="cm-chain__item" aria-current={node.current ? "true" : undefined}>
      <span className="cm-chain__row">
        {node.role === "step" && <span className="cm-chain__kind">{t("knative:eventing.path.step", { index: node.index })}</span>}
        {node.role === "branch" && <span>{t("knative:eventing.path.branch", { index: node.index })}</span>}
        {LABELLED.has(node.role) && <span className="cm-chain__kind">{t(`knative:eventing.path.role.${node.role}`)}</span>}
        {node.kind && <span className="cm-chain__kind">{node.kind}</span>}
        {name}
        {health && <StatusText value={t(`knative:health.${health}`)} tone={HEALTH_TONE[health]} />}
        {filter && <span className="cm-chain__extra">{filter}</span>}
        {node.uri && <span className="cm-chain__extra">{node.uri}</span>}
      </span>
      {empty}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child, i) => (
            <NodeItem key={`${child.role}/${child.kind ?? ""}/${child.name ?? child.uri ?? ""}/${i}`} node={child} lists={lists} />
          ))}
          {node.more ? <li className="cm-chain__item cm-muted">{t("knative:eventing.path.more", { count: node.more })}</li> : null}
        </ul>
      )}
    </li>
  );
}

export function EventPathView({ clusterId, kind, obj }: { clusterId: ClusterId; kind: KindRef; obj: KubeObject }) {
  const { t } = useTranslation();
  const needs = pathNeeds(kind, obj);
  const { lists, loading } = usePathLists(clusterId, needs);
  const path = eventPath(kind, obj, lists);
  if (!path) return null;
  return (
    <Block title={t("knative:eventing.path.title")}>
      {loading && <p className="cm-muted">{t("knative:eventing.path.loading")}</p>}
      {path.from && path.from.length > 0 && (
        <>
          <p className="cm-muted">{t("knative:eventing.path.from")}</p>
          <ul className="cm-chain">
            {path.from.map((node, i) => (
              <NodeItem key={`${node.kind ?? ""}/${node.name ?? ""}/${i}`} node={node} lists={lists} />
            ))}
            {path.fromMore ? <li className="cm-chain__item cm-muted">{t("knative:eventing.path.more", { count: path.fromMore })}</li> : null}
          </ul>
        </>
      )}
      {path.from && path.from.length === 0 && <p className="cm-muted">{t("knative:eventing.path.noSources")}</p>}
      <ul className="cm-chain" aria-label={t("knative:eventing.path.title")}>
        <NodeItem node={path.root} lists={lists} />
      </ul>
    </Block>
  );
}
