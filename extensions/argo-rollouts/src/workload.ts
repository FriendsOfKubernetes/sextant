// The details section `managed-by-rollout` on Deployments (#341, ADR-0171): when a Rollout of the namespace takes its pod
// template from the Deployment (`spec.workloadRef`), it says so, and what the Deployment's replica count means then — the
// pods run in the Rollout's ReplicaSets, and the controller scales the Deployment down only with `scaleDown` onsuccess or
// progressively and only while the Rollout's first revision rolls out (`revision == 1` in rollout/sync.go and
// rollout/replicaset.go of Argo Rollouts v1.10.2: a one-time migration; `never`, the default, leaves it as it is). The
// section starts hidden and shows itself only for such a Deployment.
import { ui, type KubeObject, type ObjectRef, type Sextant } from "@sextant/extension-sdk";
import { errorText } from "./dom";
import { t } from "./i18n";
import { get, num, PHASE_TONE, revisionOf, ROLLOUT, rolloutPhase, str } from "./model";

/** The Rollouts of `rollouts` whose template comes from Deployment `name`. */
export function rolloutsOf(rollouts: readonly KubeObject[], name: string): KubeObject[] {
  return rollouts.filter((r) => str(get(r, "spec", "workloadRef", "kind")) === "Deployment" && str(get(r, "spec", "workloadRef", "name")) === name);
}

/**
 * What the Deployment's replica count means under the Rollout, as a text key: the controller scales it down only with
 * `scaleDown` onsuccess or progressively and only for the Rollout's first revision.
 */
export function replicasMeaning(
  scaleDown: string,
  replicas: number | undefined,
  revision: number | undefined,
): "scaledDown" | "scaledByHand" | "runsBeside" | "willScaleDown" | "stays" | undefined {
  if (replicas === undefined) return undefined;
  if (replicas === 0) return scaleDown === "never" ? "scaledByHand" : "scaledDown";
  if (scaleDown === "never") return "runsBeside";
  return revision !== undefined && revision > 1 ? "stays" : "willScaleDown";
}

export function view(sextant: Sextant, deployment: KubeObject | null, rollouts: readonly KubeObject[]): Node[] {
  if (rollouts.length === 0) return [];
  const replicas = deployment ? (num(get(deployment, "spec", "replicas")) ?? 1) : undefined;
  const nodes: Node[] = [];
  for (const ro of rollouts) {
    const scaleDown = str(get(ro, "spec", "workloadRef", "scaleDown")) ?? "never";
    const { phase } = rolloutPhase(ro);
    const name = ro.metadata?.name ?? "";
    const ref = { kind: ROLLOUT, namespace: ro.metadata?.namespace, name } as unknown as ObjectRef;
    nodes.push(
      ui.fields([
        [t("workload.rollout"), ui.objectLink(sextant, ref, name)],
        [t("fields.phase"), ui.status(phase, PHASE_TONE[phase])],
        [t("workload.scaleDown"), scaleDown],
      ]),
    );
    const meaning = replicasMeaning(scaleDown, replicas, revisionOf(ro));
    const p = document.createElement("p");
    p.className = "explain";
    p.textContent = [t("workload.template"), meaning ? t(`workload.${meaning}`, { scaleDown }) : ""].filter(Boolean).join(" ");
    nodes.push(p);
  }
  if (rollouts.length > 1) {
    const warn = document.createElement("p");
    warn.className = "explain";
    warn.textContent = t("workload.several", { count: rollouts.length });
    nodes.push(warn);
  }
  return nodes;
}

export function startWorkload(sextant: Sextant, root: HTMLElement): () => void {
  let reading = 0;
  let hidden = true;
  const show = (nodes: Node[]) => {
    root.replaceChildren(...nodes);
    const empty = nodes.length === 0;
    if (empty === hidden) return;
    hidden = empty;
    void sextant.ui.setHidden(empty).catch(() => undefined);
  };
  let shown: string | undefined;
  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref?.namespace) return show([]);
    const key = `${ref.namespace}/${ref.name}/${sextant.context.resourceVersion ?? ""}`;
    if (key === shown) return;
    shown = key;
    const attempt = ++reading;
    void (async () => {
      try {
        const list = await sextant.resources.list({ kind: ROLLOUT, namespace: ref.namespace ?? undefined, limit: 500 });
        const own = rolloutsOf(list.items, ref.name);
        if (attempt !== reading) return;
        if (own.length === 0) return show([]);
        const deployment = await sextant.resources.get({ ref }).catch(() => null);
        if (attempt === reading) show(view(sextant, deployment, own));
      } catch (err) {
        // Rollouts not served or not readable here: nothing to say about this Deployment.
        if (attempt === reading) show(hidden ? [] : [ui.errorState(errorText(err))]);
      }
    })();
  };
  follow();
  return sextant.onContextChange(follow);
}
