// What the extension's backend decides for the Trigger table's Filter column (ADR-0172, a judge only a computed
// column asks): the former built-in column's text, `filterText(triggerFilter(trigger).terms)`, ported unchanged — every
// dialect of `spec.filters`, the nested `all`, `any` and `not`, and the older `spec.filter.attributes` — which no rule
// or case could write out. Sextant sends each Trigger's `spec.filters` and `spec.filter` only. Pure.
import type { KubeObject } from "@sextant/extension-sdk";
import { filterText, triggerFilter } from "./eventing";

/** A Trigger as the judge gets it (the SDK's `JudgedObject`): its uid and the declared fields only. */
export interface JudgedTrigger {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string | null; uid: string };
  values: Record<string, unknown>;
}

/** The judge's id and its one fact, as the manifest declares them. */
export const FILTERS_JUDGE = "filters";
export const FILTER_FACT = "filter";

/** The filter text of each Trigger that has one (the built-in column showed nothing for none). */
export function filterFacts(objects: readonly JudgedTrigger[]): { uid: string; fact: string; values: { text: string } }[] {
  return objects.flatMap((o) => {
    const spec: Record<string, unknown> = {};
    if (o.values[".spec.filters"] !== undefined) spec.filters = o.values[".spec.filters"];
    if (o.values[".spec.filter"] !== undefined) spec.filter = o.values[".spec.filter"];
    const trigger = { apiVersion: o.apiVersion, kind: o.kind, metadata: { name: o.metadata.name, uid: o.metadata.uid }, spec } as KubeObject;
    const text = filterText(triggerFilter(trigger).terms);
    return text ? [{ uid: o.metadata.uid, fact: FILTER_FACT, values: { text } }] : [];
  });
}
