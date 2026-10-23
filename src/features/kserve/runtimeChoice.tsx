// "Serving runtime" of an InferenceService's details: the runtime KServe chooses for the predictor now, computed from
// the namespace's ServingRuntimes and the ClusterServingRuntimes as KServe does (runtimes.ts), the other candidates
// in KServe's order, why none fits, and whether it differs from what KServe recorded in the status.
import { useTranslation } from "react-i18next";
import type { ClusterId, KubeObject } from "../../api";
import { formatList } from "../../i18n";
import { Block, Fields, link, type FieldRow } from "../details";
import { useRuntimes } from "./hooks";
import { recordedRuntimeOf, type ComponentSpec } from "./model";
import { Muted, Note, runtimeType } from "./parts";
import { chooseRuntime } from "./runtimes";

const CHOICE_LABELS = "kserve:choice.fields";

export function RuntimeChoice({ clusterId, obj, predictor, modelMesh }: { clusterId: ClusterId; obj: KubeObject; predictor: ComponentSpec; modelMesh: boolean }) {
  const { t } = useTranslation();
  const ns = obj.metadata?.namespace ?? null;
  const { namespaced, clusterWide } = useRuntimes(clusterId, ns);
  const recorded = recordedRuntimeOf(obj);
  let body;
  if (!namespaced.loaded || !clusterWide.loaded) body = <Muted text={t("kserve:choice.loading")} />;
  else if (namespaced.notServed && clusterWide.notServed) body = <Muted text={t("kserve:choice.notServed")} />;
  else if (namespaced.error || clusterWide.error || namespaced.truncated || clusterWide.truncated) body = <Muted text={t("kserve:choice.unreadable")} />;
  else {
    const choice = chooseRuntime(predictor, namespaced.items, clusterWide.items, modelMesh);
    if (choice.kind === "noFormat") body = <Muted text={t("kserve:choice.noFormat")} />;
    else if (choice.kind === "none") body = <Note text={t("kserve:choice.none", { format: predictor.format?.name ?? "" })} tone="danger" />;
    else if (choice.kind === "chosen") {
      const differs = recorded && (recorded.name !== choice.runtime.name || recorded.cluster !== choice.runtime.cluster);
      const others = choice.candidates.slice(1).map((c) => c.name);
      const chosenRows: FieldRow[] = [[choice.named ? "named" : "auto", link(runtimeType(choice.runtime), choice.runtime.name, choice.runtime.cluster ? null : ns)]];
      body = (
        <>
          <Fields
            rows={chosenRows}
            labelPrefix={CHOICE_LABELS}
          />
          {others.length > 0 && <Muted text={t("kserve:choice.others", { names: formatList(others) })} />}
          {differs && <Note text={t("kserve:choice.differs", { recorded: recorded.name })} tone="warning" />}
        </>
      );
    } else body = <Note text={t(`kserve:choice.${choice.kind}`, { name: choice.runtime.name })} tone="danger" />;
  }
  return <Block title={t("kserve:choice.title")}>{body}</Block>;
}
