// The pane layout of a terminal dock tab (#154): a tree of panes and splits. A split lays its children out in a row
// (side by side) or a column (one above another) with relative sizes that add up to 1. Every function here is pure:
// it returns a new tree and never changes the one it is given.

export type SplitDirection = "row" | "column";
export type FocusDirection = "left" | "right" | "up" | "down";

export interface PaneNode<P> {
  type: "pane";
  id: string;
  pane: P;
}

export interface SplitNode<P> {
  type: "split";
  id: string;
  direction: SplitDirection;
  children: LayoutNode<P>[];
  /** Relative sizes of `children`, each > 0, adding up to 1. */
  sizes: number[];
}

export type LayoutNode<P> = PaneNode<P> | SplitNode<P>;

/** The smallest share of a split a pane can be resized to. */
export const MIN_SIZE = 0.1;
/** Most panes one tab holds (each is a shell session with its own flow control). */
export const MAX_PANES = 8;

let counter = 0;
/** A new node id, unique in this window. */
export function newNodeId(prefix = "pane"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function paneNode<P>(pane: P, id = newNodeId()): PaneNode<P> {
  return { type: "pane", id, pane };
}

/** The panes of `node` in reading order (left to right, top to bottom). */
export function panesOf<P>(node: LayoutNode<P>): PaneNode<P>[] {
  return node.type === "pane" ? [node] : node.children.flatMap((c) => panesOf(c));
}

export function findPane<P>(node: LayoutNode<P>, id: string): PaneNode<P> | undefined {
  return panesOf(node).find((p) => p.id === id);
}

/**
 * Splits pane `id` in `direction`: the new pane goes after it (right of it in a row, below it in a column) and the
 * two share the old pane's place. A split of the same direction takes the new pane as one more child instead of
 * nesting. Nothing changes when `id` is not in the tree or the tab already has `MAX_PANES` panes.
 */
export function splitPane<P>(
  root: LayoutNode<P>,
  id: string,
  direction: SplitDirection,
  added: PaneNode<P>,
): LayoutNode<P> {
  if (panesOf(root).length >= MAX_PANES || !findPane(root, id)) return root;
  const visit = (node: LayoutNode<P>): LayoutNode<P> => {
    if (node.type === "pane") {
      if (node.id !== id) return node;
      return { type: "split", id: newNodeId("split"), direction, children: [node, added], sizes: [0.5, 0.5] };
    }
    const index = node.children.findIndex((c) => c.type === "pane" && c.id === id);
    if (index >= 0 && node.direction === direction) {
      // Halve the split pane's share between it and the new one.
      const half = node.sizes[index]! / 2;
      const children = [...node.children];
      children.splice(index + 1, 0, added);
      const sizes = [...node.sizes];
      sizes.splice(index, 1, half, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/**
 * The tree without pane `id`; its share goes to its neighbours in proportion. A split left with one child is replaced
 * by that child. `null` when the closed pane was the last one.
 */
export function closePane<P>(root: LayoutNode<P>, id: string): LayoutNode<P> | null {
  if (root.type === "pane") return root.id === id ? null : root;
  const children: LayoutNode<P>[] = [];
  const sizes: number[] = [];
  root.children.forEach((child, i) => {
    const next = closePane(child, id);
    if (next) {
      children.push(next);
      sizes.push(root.sizes[i]!);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  if (children.length === root.children.length && children.every((c, i) => c === root.children[i])) return root;
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...root, children, sizes: sizes.map((s) => s / total) };
}

/**
 * Moves the border between children `index` and `index + 1` of split `splitId` by `delta` (a share of the split):
 * positive grows the first. Neither gets smaller than `MIN_SIZE`.
 */
export function resizeSplit<P>(root: LayoutNode<P>, splitId: string, index: number, delta: number): LayoutNode<P> {
  if (root.type === "pane") return root;
  if (root.id !== splitId) {
    const children = root.children.map((c) => resizeSplit(c, splitId, index, delta));
    return children.every((c, i) => c === root.children[i]) ? root : { ...root, children };
  }
  const a = root.sizes[index];
  const b = root.sizes[index + 1];
  if (a === undefined || b === undefined || !Number.isFinite(delta)) return root;
  const pair = a + b;
  const first = Math.min(Math.max(a + delta, MIN_SIZE), pair - MIN_SIZE);
  if (first === a) return root;
  const sizes = [...root.sizes];
  sizes[index] = first;
  sizes[index + 1] = pair - first;
  return { ...root, sizes };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where each pane sits in a unit square. */
export function paneRects<P>(root: LayoutNode<P>): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const visit = (node: LayoutNode<P>, rect: Rect) => {
    if (node.type === "pane") {
      rects.set(node.id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const size = node.sizes[i] ?? 0;
      const part =
        node.direction === "row"
          ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
      offset += size;
      visit(child, part);
    });
  };
  visit(root, { x: 0, y: 0, w: 1, h: 1 });
  return rects;
}

/** A border between two children of a split, which the user drags to resize them. */
export interface SplitHandle {
  splitId: string;
  /** The border between children `index` and `index + 1`. */
  index: number;
  direction: SplitDirection;
  /** Where the border is in the unit square: a vertical line (`row`) at `x` from `y` over `length`, else horizontal. */
  x: number;
  y: number;
  length: number;
  /** The split's extent along its direction (a share of the whole), to turn a dragged distance into a share. */
  extent: number;
}

/** The borders of every split of `root`, in the unit square. */
export function splitHandles<P>(root: LayoutNode<P>): SplitHandle[] {
  const handles: SplitHandle[] = [];
  const visit = (node: LayoutNode<P>, rect: Rect) => {
    if (node.type === "pane") return;
    let offset = 0;
    node.children.forEach((child, i) => {
      const size = node.sizes[i] ?? 0;
      const row = node.direction === "row";
      if (i > 0)
        handles.push({
          splitId: node.id,
          index: i - 1,
          direction: node.direction,
          x: row ? rect.x + offset * rect.w : rect.x,
          y: row ? rect.y : rect.y + offset * rect.h,
          length: row ? rect.h : rect.w,
          extent: row ? rect.w : rect.h,
        });
      const part = row
        ? { x: rect.x + offset * rect.w, y: rect.y, w: size * rect.w, h: rect.h }
        : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: size * rect.h };
      offset += size;
      visit(child, part);
    });
  };
  visit(root, { x: 0, y: 0, w: 1, h: 1 });
  return handles;
}

const EPSILON = 1e-6;

/**
 * The pane next to `id` in `direction` (Ctrl+Shift+Arrow): of the panes beyond its edge that overlap it across that
 * edge, the nearest one, then the one sharing most of the edge, then the first in reading order. `null` at the edge.
 */
export function neighbour<P>(root: LayoutNode<P>, id: string, direction: FocusDirection): string | null {
  const rects = paneRects(root);
  const from = rects.get(id);
  if (!from) return null;
  let best: { id: string; distance: number; overlap: number } | null = null;
  for (const [other, r] of rects) {
    if (other === id) continue;
    let distance: number;
    let overlap: number;
    const horizontal = direction === "left" || direction === "right";
    if (horizontal) {
      distance = direction === "right" ? r.x - (from.x + from.w) : from.x - (r.x + r.w);
      overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
    } else {
      distance = direction === "down" ? r.y - (from.y + from.h) : from.y - (r.y + r.h);
      overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
    }
    if (distance < -EPSILON || overlap <= EPSILON) continue;
    if (
      !best ||
      distance < best.distance - EPSILON ||
      (Math.abs(distance - best.distance) <= EPSILON && overlap > best.overlap + EPSILON)
    )
      best = { id: other, distance, overlap };
  }
  return best?.id ?? null;
}

/** The focus direction of a Ctrl+Shift+Arrow key event, `null` for any other key. */
export function focusKey(e: Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): FocusDirection | null {
  if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null;
  switch (e.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}
