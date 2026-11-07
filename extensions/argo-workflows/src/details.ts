// The details sections of Argo Workflows objects (the manifest's `contributes.detailsSections`):
//   workflow        — phase, progress, times and duration (ticking while it runs), the failed step and its message,
//                     the CronWorkflow and template it came from, how to retry it outside Sextant; the step tree (at
//                     most `MAX_TREE_NODES` rows, collapsed below the root, "Show the failed step", "Collapse all"),
//                     each pod node linked to its pod with its logs one click away (Sextant's logs tab);
//   cron-workflow   — the schedules, time zone, concurrency, suspension, last run, the active Workflows, counts;
//   template        — the entrypoint and the templates of a (Cluster)WorkflowTemplate.
// Each frame reads the shown object again whenever its resourceVersion changes. Conditions and YAML are Sextant's own
// sections. The actions are in ./actions.ts.
import { ui, type KubeObject, type ObjectRef, type RefInput, type Sextant, type UiContent } from "@sextant/extension-sdk";
import { age, dateTime, durationText, element, errorText } from "./dom";
import { t } from "./i18n";
import {
  activeWorkflows,
  CLUSTER_WORKFLOW_TEMPLATE,
  CRON_WORKFLOW,
  cronCounts,
  cronOf,
  cronSuspended,
  durationOf,
  failedNode,
  failureMessage,
  get,
  isFailedPhase,
  lastScheduled,
  MAX_TREE_NODES,
  nodesElsewhere,
  nodesOf,
  pathTo,
  phaseTone,
  POD,
  podNameOf,
  progressOf,
  rootOf,
  schedulesOf,
  str,
  templateRefOf,
  templateSummary,
  treeRows,
  WORKFLOW,
  WORKFLOW_TEMPLATE,
  workflowPhase,
  type WorkflowNode,
} from "./model";

const VERSION = "v1alpha1";

/** A link to an object's details in Sextant's panel. */
const link = (sextant: Sextant, ref: RefInput, text?: string) => ui.objectLink(sextant, ref as ObjectRef, text ?? ref.name);

/** `ui.fields`, or nothing when no row has a value. */
function fieldsOf(rows: readonly (readonly [string, UiContent])[]): HTMLElement | null {
  const list = ui.fields(rows);
  return list.childElementCount > 0 ? list : null;
}

const present = (nodes: (Node | null)[]): Node[] => nodes.filter((n): n is Node => n !== null);
const muted = (text: string) => element("p", { className: "aw-muted", textContent: text });

/** A duration that ticks: its text is set again every second (`every` 1) or every five seconds (`every` 5). */
export interface Ticking {
  node: HTMLElement;
  /** What holds `startedAt` and `finishedAt`. */
  of: unknown;
  every: 1 | 5;
}

/** A duration's text, kept in `ticking` while it may still change; nothing before it starts. */
function duration(of: unknown, now: number, ticking: Ticking[], every: 1 | 5): HTMLElement | null {
  const ms = durationOf(of, now);
  if (ms === undefined) return null;
  const node = element("span", { textContent: durationText(ms) });
  if (str(get(of, "finishedAt")) === undefined) ticking.push({ node, of, every });
  return node;
}

/** Sets the ticking durations' texts again: those of `every` 5 only on every fifth tick. */
export function tick(ticking: readonly Ticking[], count: number, now: number): void {
  for (const entry of ticking) {
    if (entry.every === 5 && count % 5 !== 0) continue;
    const ms = durationOf(entry.of, now);
    if (ms !== undefined) entry.node.textContent = durationText(ms);
  }
}

const phaseStatus = (phase: string | undefined) => (phase ? ui.status(phase, phaseTone(phase)) : null);

export function workflowFields(sextant: Sextant, wf: KubeObject, ticking: Ticking[], now = Date.now()): Node[] {
  const ns = wf.metadata.namespace ?? null;
  const phase = workflowPhase(wf);
  const failed = isFailedPhase(phase) ? failedNode(wf) : undefined;
  const template = templateRefOf(wf);
  const cron = cronOf(wf);
  const templateLink = template
    ? link(sextant, {
        kind: { ...(template.cluster ? CLUSTER_WORKFLOW_TEMPLATE : WORKFLOW_TEMPLATE), version: VERSION },
        namespace: template.cluster ? null : ns,
        name: template.name,
      })
    : undefined;
  return present([
    fieldsOf([
      [t("fields.phase"), phaseStatus(phase)],
      [t("fields.progress"), progressOf(wf)],
      [t("fields.startedAt"), dateTime(str(get(wf, "status", "startedAt")))],
      [t("fields.finishedAt"), dateTime(str(get(wf, "status", "finishedAt")))],
      [t("fields.duration"), duration(get(wf, "status"), now, ticking, 1)],
      [t("fields.message"), str(get(wf, "status", "message"))],
      [t("fields.failedStep"), failed?.displayName],
      [t("fields.failedMessage"), failed ? failureMessage(wf, failed) : undefined],
      [t("fields.cronWorkflow"), cron ? link(sextant, { kind: { ...CRON_WORKFLOW, version: VERSION }, namespace: ns, name: cron }) : undefined],
      [t("fields.workflowTemplate"), templateLink],
    ]),
    // Retry is not an action (ADR-0097): it rebuilds the node tree and deletes pods, as only Argo does.
    isFailedPhase(phase) ? muted(t("retryHint", { name: wf.metadata.name, namespace: ns ?? "" })) : null,
  ]);
}

/** What the tree keeps between reads of one Workflow: the expanded nodes. */
export interface TreeState {
  /** The Workflow whose tree this is (its uid, else its name). */
  of?: string;
  expanded: Set<string>;
}

/** Opens the logs of the pod of a node in Sextant's logs tab; says so when the pod is gone (Argo's pod GC). */
function logsButton(sextant: Sextant, namespace: string, pod: string): HTMLElement {
  const error = element("span", { className: "aw-node__error" });
  const button = ui.button(t("tree.logs"), () => {
    error.replaceChildren();
    void sextant.ui.openLogs({ namespace, pod }).catch((err: unknown) => error.replaceChildren(ui.errorState(errorText(err))));
  });
  button.setAttribute("aria-label", t("tree.logsOf", { name: pod }));
  return element("span", { className: "aw-node__logs" }, button, error);
}

function nodeRow(
  sextant: Sextant,
  wf: KubeObject,
  row: { node: WorkflowNode; depth: number; hasChildren: boolean },
  pod: string | undefined,
  open: boolean,
  toggle: () => void,
  ticking: Ticking[],
  now: number,
): HTMLElement {
  const { node, depth, hasChildren } = row;
  const ns = wf.metadata.namespace ?? "";
  const failed = isFailedPhase(node.phase);
  let toggler: HTMLElement;
  if (hasChildren) {
    const button = element("button", { type: "button", className: "aw-toggle", textContent: open ? "▾" : "▸" });
    button.dataset.node = node.id;
    button.setAttribute("aria-label", t(open ? "tree.collapse" : "tree.expand", { name: node.displayName }));
    button.setAttribute("aria-expanded", String(open));
    button.addEventListener("click", toggle);
    toggler = button;
  } else {
    toggler = element("span", { className: "aw-node__spacer" });
  }
  const head = element(
    "div",
    { className: "aw-node__head" },
    toggler,
    element("span", { className: "aw-node__name", textContent: node.displayName }),
    element("span", { className: "aw-node__type", textContent: node.type }),
    phaseStatus(node.phase),
    element("span", { className: "aw-node__time" }, duration(node.raw, now, ticking, 5)),
    pod && ns ? link(sextant, { kind: { ...POD, version: "v1" }, namespace: ns, name: pod }) : null,
    pod && ns ? logsButton(sextant, ns, pod) : null,
  );
  const item = element(
    "li",
    { className: `aw-node${failed ? " aw-node--failed" : ""}` },
    head,
    node.message ? element("div", { className: "aw-node__message", textContent: node.message }) : null,
  );
  item.style.paddingLeft = `${depth * 1.25}rem`;
  return item;
}

/**
 * The step tree of a Workflow: the rows `treeRows` gives for the expanded nodes. `redraw` draws it again after a
 * change of `state`, keeping the focus on the toggle of `focus`.
 */
export function treeView(
  sextant: Sextant,
  wf: KubeObject,
  state: TreeState,
  redraw: (focus?: string) => void,
  ticking: Ticking[],
  now = Date.now(),
): Node[] {
  const elsewhere = nodesElsewhere(wf);
  if (elsewhere) return [muted(t(`tree.${elsewhere}`))];
  const nodes = nodesOf(wf);
  const root = rootOf(wf, nodes);
  if (!root) return [muted(t("tree.none"))];
  const rows = treeRows(wf, nodes, state.expanded);
  const failed = failedNode(wf, nodes);
  const toggle = (id: string) => () => {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    redraw(id);
  };
  const tools = element(
    "div",
    { className: "aw-tree__tools" },
    element("span", { className: "aw-muted", textContent: t("tree.count", { count: nodes.size }) }),
    failed
      ? ui.button(t("tree.expandFailed"), () => {
          for (const id of pathTo(wf, nodes, failed.id)) state.expanded.add(id);
          redraw();
        })
      : null,
    ui.button(t("tree.collapseAll"), () => {
      state.expanded = new Set([root.id]);
      redraw();
    }),
  );
  const list = element(
    "ul",
    { className: "aw-tree" },
    ...rows.map((row) =>
      nodeRow(sextant, wf, row, podNameOf(wf, row.node, nodes), state.expanded.has(row.node.id), toggle(row.node.id), ticking, now),
    ),
  );
  return present([
    tools,
    list,
    rows.length >= MAX_TREE_NODES ? muted(t("tree.capped", { shown: MAX_TREE_NODES, count: nodes.size })) : null,
  ]);
}

export function cronView(sextant: Sextant, cron: KubeObject, now = Date.now()): Node[] {
  const ns = cron.metadata.namespace ?? null;
  const counts = cronCounts(cron);
  const last = lastScheduled(cron);
  const active = activeWorkflows(cron).map((a) => link(sextant, { kind: { ...WORKFLOW, version: VERSION }, namespace: a.namespace ?? ns, name: a.name }));
  return present([
    fieldsOf([
      [t("fields.schedules"), ui.chips(schedulesOf(cron))],
      [t("fields.timezone"), str(get(cron, "spec", "timezone"))],
      [t("fields.concurrencyPolicy"), str(get(cron, "spec", "concurrencyPolicy"))],
      [t("fields.suspended"), cronSuspended(cron) ? t("yes") : undefined],
      [t("fields.lastScheduled"), last ? element("span", { className: "aw-when" }, dateTime(last), age(last, now)) : undefined],
      [t("fields.active"), active.length > 0 ? ui.inline(active) : undefined],
      [t("fields.succeeded"), counts.succeeded === undefined ? undefined : String(counts.succeeded)],
      [t("fields.failed"), counts.failed === undefined ? undefined : String(counts.failed)],
      [t("fields.entrypoint"), templateSummary(cron).entrypoint],
    ]),
  ]);
}

export function templateView(obj: KubeObject): Node[] {
  const summary = templateSummary(obj);
  return present([
    fieldsOf([
      [t("fields.entrypoint"), summary.entrypoint],
      [t("fields.templates"), ui.chips(summary.templates)],
    ]),
  ]);
}

/**
 * Starts the details section `contribution` on the object in the context: read again whenever its resourceVersion
 * changes. A Workflow's durations tick while it runs: the field every second, the steps every five, as the built-in
 * view drew them. A section with nothing to show hides itself, title included, until it has something
 * (`ui.setHidden`).
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  let shownVersion: string | null | undefined;
  let shownRef: string | null = null;
  let reading = 0;
  let object: KubeObject | null = null;
  let hidden = false;
  let ticking: Ticking[] = [];
  let ticks = 0;
  const tree: TreeState = { expanded: new Set() };
  const treeSlot = element("div", { className: "aw-tree-slot" });

  /** Shows `nodes`, hiding the section while there are none. */
  const show = (nodes: Node[]) => {
    root.replaceChildren(...nodes);
    const empty = nodes.length === 0;
    if (empty === hidden) return;
    hidden = empty;
    void sextant.ui.setHidden(empty).catch(() => undefined);
  };

  /** The tree drawn again (a toggle, "Show the failed step", "Collapse all"), the focus kept on `focus`'s toggle. */
  const redrawTree = (focus?: string) => {
    if (!object) return;
    ticking = ticking.filter((entry) => entry.every !== 5);
    treeSlot.replaceChildren(...treeView(sextant, object, tree, redrawTree, ticking));
    if (focus !== undefined) {
      const toggle = [...treeSlot.querySelectorAll<HTMLButtonElement>("button.aw-toggle")].find((b) => b.dataset.node === focus);
      toggle?.focus();
    }
  };

  const render = () => {
    if (!object) return;
    ticking = [];
    if (contribution === "workflow") {
      // A tree of its own per Workflow: what is expanded does not carry over to another one. Collapsed below the root.
      const uid = object.metadata.uid ?? object.metadata.name;
      if (tree.of !== uid) {
        const first = rootOf(object, nodesOf(object));
        if (first) {
          tree.of = uid;
          tree.expanded = new Set([first.id]);
        }
      }
      treeSlot.replaceChildren(...treeView(sextant, object, tree, redrawTree, ticking));
      show([...workflowFields(sextant, object, ticking), ui.block(t("sections.nodes"), treeSlot)]);
    } else if (contribution === "cron-workflow") {
      show(cronView(sextant, object));
    } else if (contribution === "template") {
      show(templateView(object));
    } else {
      show([ui.empty(t("common.nothingToShow", { view: contribution }))]);
    }
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading) return;
      object = fresh;
      render();
    } catch (err) {
      if (attempt === reading) show([ui.errorState(errorText(err))]);
    }
  };

  const follow = () => {
    const ref = sextant.context.selection[0];
    if (!ref) {
      show([ui.empty(t("common.nothingSelected"))]);
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      ticking = [];
      show([ui.loading(t("loading"))]);
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) return;
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  const timer = setInterval(() => tick(ticking, ++ticks, Date.now()), 1000);
  return () => {
    clearInterval(timer);
    stopFollow();
  };
}
