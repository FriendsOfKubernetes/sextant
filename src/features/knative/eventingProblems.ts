// The problems of Knative Eventing objects (#234), in the `knative` category (`knativeProblems` in problemRules.ts
// hands Eventing kinds here): an object of the section whose Ready condition is False, after the Serving grace. Told
// once, where the user acts:
// - an object another Eventing object controls (a Broker's or Channel's backing InMemoryChannel, a Trigger's,
//   Sequence's or Parallel's Subscriptions and Channels, a ContainerSource's SinkBinding) is told through its owner,
//   whose conditions carry its failure;
// - a Trigger that is not ready only because its Broker is not (BrokerReady False with the Broker's own reason) is
//   told through the Broker; a Broker that does not exist or cannot be read is the Trigger's own problem.
import type { KindRef, KubeObject } from "../../api";
import type { Detected } from "../problems/model";
import { brokerOf, eventingKind, ownedByEventing, TRIGGER } from "./eventing";
import { conditionOf, failingCondition, readyStatus, sameKind } from "./model";

/** As Serving's: a rollout the next reconcile fixes passes quietly. */
export const EVENTING_GRACE_MS = 2 * 60_000;

/** The reasons of BrokerReady False the Trigger reconciler writes itself (pkg/reconciler/broker/trigger). */
const TRIGGER_OWN_BROKER_REASONS = new Set(["BrokerDoesNotExist", "FailedToGetBroker", "MissingBrokerChannel"]);

export function eventingProblems(kind: Pick<KindRef, "group" | "kind">, obj: KubeObject): Detected[] {
  if (!eventingKind(kind)) return [];
  if (readyStatus(obj) !== "False") return [];
  if (ownedByEventing(obj)) return [];
  const failing = failingCondition(obj);
  if (sameKind(kind, TRIGGER) && brokerOf(obj)) {
    const broker = conditionOf(obj, "BrokerReady");
    if (broker?.status === "False" && failing?.type === "BrokerReady" && !TRIGGER_OWN_BROKER_REASONS.has(broker.reason ?? "")) return [];
  }
  return [
    {
      reason: failing?.reason ?? "NotReady",
      group: "notReady",
      message: failing?.message,
      since: failing?.lastTransitionTime,
      graceMs: EVENTING_GRACE_MS,
      notify: true,
    },
  ];
}
