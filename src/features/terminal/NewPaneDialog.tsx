// What a new split pane runs: the same as the current pane, a local terminal, a shell in a container, a shell on a node
// or a debug container — through the same start functions and confirmations as a new tab. Pods and nodes are watched
// only while this dialog is open and that choice is made, pods only in the namespace typed in.
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWatch, type KindRef, type ObjectRef } from "../../api";
import type { DebugSpec } from "../../api/generated/DebugSpec";
import { Button, Dialog, Radio } from "../../components";
import type { SplitDirection } from "./layout";
import { NodeShellConfirm } from "./NodeShellConfirm";
import { DebugConfirm, DebugLauncher, type PaneSpec } from "./paneViews";

const POD: KindRef = { group: "", version: "v1", kind: "Pod" };
const NODE: KindRef = { group: "", version: "v1", kind: "Node" };
/** Most pods or nodes offered in a list. */
const MAX_CHOICES = 500;

type Choice = "same" | "local" | "exec" | "node" | "debug";

export interface NewPaneDialogProps {
  /** The focused pane: its cluster, namespace and pod are the defaults. */
  current: PaneSpec;
  direction: SplitDirection;
  close: () => void;
  onCreate: (spec: PaneSpec) => void;
}

export function NewPaneDialog({ current, direction, close, onCreate }: NewPaneDialogProps) {
  const { t } = useTranslation();
  const clusterId = current.clusterId;
  const [choice, setChoice] = useState<Choice>("same");
  const [namespace, setNamespace] = useState(
    current.kind === "exec" || current.kind === "debug" ? (current.pod.namespace ?? "default") : "default",
  );
  const [pod, setPod] = useState("");
  const [container, setContainer] = useState("");
  const [node, setNode] = useState(current.kind === "node" ? current.node : "");
  /** A step that asks first: a privileged pod on a node, or another debug container. */
  const [step, setStep] = useState<null | "node" | "debug" | "same">(null);
  const nsId = useId();
  const podId = useId();
  const containerId = useId();
  const nodeId = useId();

  const wantsPods = clusterId !== null && (choice === "exec" || choice === "debug") && namespace.trim() !== "";
  const pods = useWatch(
    wantsPods ? clusterId : null,
    wantsPods ? { kind: POD, namespaces: [namespace.trim()], labelSelector: null, fieldSelector: "status.phase=Running" } : null,
  );
  const nodes = useWatch(
    clusterId !== null && choice === "node" ? clusterId : null,
    choice === "node" ? { kind: NODE, namespaces: null, labelSelector: null, fieldSelector: null, metadataOnly: true } : null,
  );
  const podList = useMemo(
    () =>
      [...pods.items.values()]
        .map((p) => ({
          name: p.metadata?.name ?? "",
          containers: ((p.spec as { containers?: { name?: unknown }[] } | undefined)?.containers ?? [])
            .map((c) => c.name)
            .filter((n): n is string => typeof n === "string"),
        }))
        .filter((p) => p.name)
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, MAX_CHOICES),
    [pods.items],
  );
  const nodeList = useMemo(
    () =>
      [...nodes.items.values()]
        .map((n) => n.metadata?.name ?? "")
        .filter(Boolean)
        .sort()
        .slice(0, MAX_CHOICES),
    [nodes.items],
  );
  const chosenPod = podList.find((p) => p.name === pod);
  const chosenContainer = container || chosenPod?.containers[0] || "";
  const podRef: ObjectRef | null = chosenPod ? { kind: POD, namespace: namespace.trim(), name: chosenPod.name } : null;

  const ready =
    choice === "same" ||
    choice === "local" ||
    (choice === "exec" && podRef !== null && chosenContainer !== "") ||
    (choice === "debug" && podRef !== null) ||
    (choice === "node" && node !== "");

  const create = () => {
    if (!ready) return;
    switch (choice) {
      case "same":
        // A node shell or a debug container creates something in the cluster: asked like a reconnect.
        if (current.kind === "node" || current.kind === "debug") setStep("same");
        else onCreate(current.kind === "local" ? { kind: "local", clusterId } : current);
        return;
      case "local":
        onCreate({ kind: "local", clusterId });
        return;
      case "exec":
        if (clusterId && podRef) onCreate({ kind: "exec", clusterId, pod: podRef, container: chosenContainer });
        return;
      case "node":
        setStep("node");
        return;
      case "debug":
        setStep("debug");
        return;
    }
  };

  if (step === "same" && current.kind === "node")
    return <NodeShellConfirm node={current.node} onConfirm={() => onCreate(current)} onCancel={() => setStep(null)} />;
  if (step === "same" && current.kind === "debug")
    return (
      <DebugConfirm debug={current.debug} pod={current.pod.name} onConfirm={() => onCreate(current)} onCancel={() => setStep(null)} />
    );
  if (step === "node" && clusterId)
    return (
      <NodeShellConfirm
        node={node}
        onConfirm={() => onCreate({ kind: "node", clusterId, node })}
        onCancel={() => setStep(null)}
      />
    );
  if (step === "debug" && clusterId && podRef)
    return (
      <DebugLauncher
        clusterId={clusterId}
        pod={podRef}
        target={chosenContainer || undefined}
        close={() => setStep(null)}
        onStart={(debug: DebugSpec) => onCreate({ kind: "debug", clusterId, pod: podRef, debug })}
      />
    );

  const choices: Choice[] = clusterId === null ? ["same", "local"] : ["same", "local", "exec", "node", "debug"];
  return (
    <Dialog
      open
      title={t(direction === "row" ? "terminal:panes.newRight" : "terminal:panes.newDown")}
      onClose={close}
      footer={
        <>
          <Button onClick={close}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" disabled={!ready} onClick={create}>
            {t(choice === "debug" ? "terminal:panes.next" : "terminal:panes.open")}
          </Button>
        </>
      }
    >
      <div className="terminal-form">
        <div className="terminal-form__field" role="radiogroup" aria-label={t("terminal:panes.what")}>
          <span className="terminal-form__label">{t("terminal:panes.what")}</span>
          {choices.map((c) => (
            <label key={c} className="terminal-form__option">
              <Radio name="pane-kind" checked={choice === c} onChange={() => setChoice(c)} />
              {t(`terminal:panes.choice.${c}`)}
            </label>
          ))}
        </div>
        {(choice === "exec" || choice === "debug") && (
          <>
            <div className="terminal-form__field">
              <label htmlFor={nsId}>{t("terminal:panes.namespace")}</label>
              <input
                id={nsId}
                type="text"
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setPod("");
                  setContainer("");
                }}
              />
            </div>
            <div className="terminal-form__field">
              <label htmlFor={podId}>{t("terminal:panes.pod")}</label>
              <select
                id={podId}
                value={pod}
                onChange={(e) => {
                  setPod(e.target.value);
                  setContainer("");
                }}
              >
                <option value="">{t(pods.status === "loading" && wantsPods ? "terminal:panes.loading" : "terminal:panes.choosePod")}</option>
                {podList.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              {wantsPods && pods.status === "ready" && podList.length === 0 && (
                <span className="terminal-form__hint">{t("terminal:panes.noPods")}</span>
              )}
              {pods.status === "error" && <span className="terminal-form__hint">{pods.error?.message}</span>}
            </div>
            {chosenPod && chosenPod.containers.length > 1 && (
              <div className="terminal-form__field">
                <label htmlFor={containerId}>{t("terminal:panes.container")}</label>
                <select id={containerId} value={chosenContainer} onChange={(e) => setContainer(e.target.value)}>
                  {chosenPod.containers.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
        {choice === "node" && (
          <div className="terminal-form__field">
            <label htmlFor={nodeId}>{t("terminal:panes.node")}</label>
            <select id={nodeId} value={node} onChange={(e) => setNode(e.target.value)}>
              <option value="">{t(nodes.status === "loading" ? "terminal:panes.loading" : "terminal:panes.chooseNode")}</option>
              {nodeList.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            {nodes.status === "error" && <span className="terminal-form__hint">{nodes.error?.message}</span>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
