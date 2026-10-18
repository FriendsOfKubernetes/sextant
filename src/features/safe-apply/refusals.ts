// Which refusals of an apply's dry run block the apply (#141). The real apply stops at the first refused document,
// after applying the ones before it, so a refused document blocks "Apply" — except one whose namespace an earlier
// document of the same text creates: the server could not check it yet, and the apply creates the namespace first.
import type { DryRunObject, DryRunResult } from "../../api";

export interface Refusals {
  /** Refused documents that block the apply. */
  blocking: DryRunObject[];
  /** Refused only because their namespace is created by an earlier document; `namespace` names it. */
  awaitingNamespace: { object: DryRunObject; namespace: string }[];
}

export function refusalsOf(result: DryRunResult): Refusals {
  const refusals: Refusals = { blocking: [], awaitingNamespace: [] };
  result.objects.forEach((o, index) => {
    if (o.change !== "failed") return;
    const namespace = o.object.namespace;
    const createdEarlier =
      namespace !== null &&
      o.error?.code === "notFound" &&
      o.error.message.includes(namespace) &&
      result.objects
        .slice(0, index)
        .some(
          (earlier) =>
            earlier.object.kind.group === "" &&
            earlier.object.kind.kind === "Namespace" &&
            earlier.object.name === namespace &&
            earlier.change === "create",
        );
    if (createdEarlier) refusals.awaitingNamespace.push({ object: o, namespace });
    else refusals.blocking.push(o);
  });
  return refusals;
}
