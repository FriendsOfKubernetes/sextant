// The "Rook Ceph topology" section of a Node: the labels Rook reads for the CRUSH location of the node's OSDs and their
// device class (ceph-cluster-crd.md "OSD Topology", "OSD Device Class via Node Label"), editable. Rook applies the
// topology labels to OSDs created after the change, and a device class to existing OSDs only with the CephCluster's
// `allowDeviceClassUpdate`; a node with its own `deviceClass` in a CephCluster is skipped by Rook when it also has the
// label, which is refused here.
import type { KubeObject, Sextant } from "@sextant/extension-sdk";
import { CRUSH_NAME, NODE_DEVICE_CLASS, nodeLabelsPatch, TOPOLOGY_LABELS } from "./changes";
import { element, errorBox } from "./dom";
import { t } from "./i18n";
import { CEPH_CLUSTER, type CephCluster } from "./rook";
import { changeButton, field, showPreview, textInput } from "./ui";

type ClusterWithNodes = CephCluster & {
  spec?: { storage?: { nodes?: { name?: string; config?: { deviceClass?: string } }[]; allowDeviceClassUpdate?: boolean } };
};

/** CephClusters that give `node` a device class of their own (`storage.nodes[].config.deviceClass`). */
export function nodeClassOwners(clusters: readonly ClusterWithNodes[], node: string): string[] {
  return clusters
    .filter((c) => (c.spec?.storage?.nodes ?? []).some((n) => n.name === node && n.config?.deviceClass))
    .map((c) => `${c.metadata.namespace}/${c.metadata.name}`);
}

export function topologyView(sextant: Sextant, node: KubeObject, clusters: readonly ClusterWithNodes[]): HTMLElement {
  const labels = node.metadata.labels ?? {};
  const inputs = TOPOLOGY_LABELS.map((entry) => ({ ...entry, input: textInput(labels[entry.label]) }));
  const deviceClass = textInput(labels[NODE_DEVICE_CLASS], "ssd");
  const owners = nodeClassOwners(clusters, node.metadata.name);
  const classUpdates = clusters.some((c) => c.spec?.storage?.allowDeviceClassUpdate);
  const build = (): { change: unknown } | { reason: string } => {
    const changes: Record<string, string | null> = {};
    for (const { label, input } of [...inputs, { label: NODE_DEVICE_CLASS, input: deviceClass }]) {
      const value = input.value.trim();
      if (value === (labels[label] ?? "")) continue;
      if (value !== "" && !CRUSH_NAME.test(value)) return { reason: t("topology.badName", { value }) };
      changes[label] = value === "" ? null : value;
    }
    if (NODE_DEVICE_CLASS in changes && changes[NODE_DEVICE_CLASS] !== null && owners.length) {
      return { reason: t("topology.classConflict", { clusters: owners.join(", ") }) };
    }
    if (!Object.keys(changes).length) return { reason: t("change.nothing") };
    return { change: nodeLabelsPatch(changes, node.metadata.resourceVersion) };
  };
  const reason = element("p", { className: "muted" });
  const previewSlot = element("div", {});
  const ref = { kind: { group: "", version: "v1", kind: "Node" }, namespace: null, name: node.metadata.name };
  const { button, status } = changeButton(t("change.apply"), async () => {
    const built = build();
    if ("reason" in built) throw new Error(built.reason);
    await sextant.resources.patch({ ref, patch: built.change as never, patchType: "merge" });
  }, { primary: true });
  const form = element(
    "div",
    { className: "form topology" },
    ...inputs.map(({ level, label, input }) => field(level, input, label)),
    field(t("topology.deviceClass"), deviceClass, NODE_DEVICE_CLASS),
  );
  const refresh = () => {
    const built = build();
    reason.textContent = "reason" in built ? built.reason : "";
    showPreview(previewSlot, "change" in built ? built.change : null);
    button.disabled = "reason" in built;
  };
  form.addEventListener("input", refresh);
  refresh();
  return element(
    "div",
    {},
    element("p", { className: "muted", textContent: t("topology.intro") }),
    element("p", { className: "warning-text", textContent: t("topology.existingOsds") }),
    form,
    element("p", { className: "muted hint", textContent: t(classUpdates ? "topology.classApplies" : "topology.classNew") }),
    owners.length ? element("p", { className: "warning-text", textContent: t("topology.classOwned", { clusters: owners.join(", ") }) }) : null,
    reason,
    previewSlot,
    element("div", { className: "actions" }, status, button),
  );
}

export function startNodeTopology(sextant: Sextant, root: HTMLElement): () => void {
  const ref = sextant.context.selection[0];
  if (!ref) {
    root.replaceChildren(element("p", { className: "muted", textContent: t("common.nothingSelected") }));
    return () => undefined;
  }
  let shown: string | null | undefined;
  const show = async () => {
    try {
      const [node, clusters] = await Promise.all([
        sextant.resources.get({ ref }),
        sextant.resources.list({ kind: CEPH_CLUSTER }).then((r) => r.items as ClusterWithNodes[]).catch(() => []),
      ]);
      root.replaceChildren(topologyView(sextant, node, clusters));
    } catch (err) {
      root.replaceChildren(errorBox(err));
    }
  };
  const follow = () => {
    if (sextant.context.resourceVersion === shown) return;
    shown = sextant.context.resourceVersion;
    void show();
  };
  follow();
  return sextant.onContextChange(follow);
}
