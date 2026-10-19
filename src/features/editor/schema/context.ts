// Where the cursor is in a YAML text, by lines and indentation, so it works on half-typed text that does not parse:
// the document (`---`) and its apiVersion/kind, the path of the map or list around the cursor, and whether a key or
// a value is being typed. Block style across lines; flow style (`{a: 1, b: [x]}`) on the cursor's line.
import type { PathSeg } from "./model";

export interface DocumentSpan {
  /** Offsets of the document's text (without its `---` line). */
  from: number;
  to: number;
  /** Index of the first line of the document. */
  firstLine: number;
  /** Index after its last line. */
  endLine: number;
  apiVersion?: string;
  kind?: string;
}

export interface CursorContext {
  /** The path of the map (or list) the cursor is in, from the document's root. */
  path: PathSeg[];
  /** `key`: a key of the map at `path` is typed; `value`: the value of `key` (a field name, or -1 for a list item). */
  mode: "key" | "value";
  key?: PathSeg;
  /** What is typed so far, and where it starts. */
  prefix: string;
  from: number;
  /** The column of the key being typed (block style), for indenting what is inserted below it. */
  column: number;
  /** Keys the map at `path` already has (block style), left out of completion. */
  siblings: string[];
}

/** A line split into its list items (`- `) and key (`key:`), by column. */
interface Opening {
  col: number;
  kind: "item" | "key";
  key?: string;
  /** Where the text after `key:` (or after the last `- `) starts. */
  rest: number;
}

const BLOCK_SCALAR = /^[|>][-+0-9]*\s*(#.*)?$/;
const SEPARATOR = /^(---|\.\.\.)(\s|$)/;

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function unquote(key: string): string {
  if (key.length >= 2 && key.startsWith('"') && key.endsWith('"')) {
    try {
      return JSON.parse(key) as string;
    } catch {
      return key.slice(1, -1);
    }
  }
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1).replace(/''/g, "'");
  return key.trimEnd();
}

function openingsOf(line: string): Opening[] {
  const out: Opening[] = [];
  let i = 0;
  while (line[i] === " ") i++;
  while (line[i] === "-" && (i + 1 === line.length || line[i + 1] === " ")) {
    const col = i;
    i++;
    while (line[i] === " ") i++;
    out.push({ col, kind: "item", rest: i });
  }
  const key = keyAt(line, i);
  if (key) {
    let rest = key.end;
    while (line[rest] === " ") rest++;
    out.push({ col: i, kind: "key", key: key.key, rest });
  }
  return out;
}

/** A key starting at `i` (`name:`, `"a b":`, `'x':`), up to after its colon; `null` when there is none. */
function keyAt(line: string, i: number): { key: string; end: number } | null {
  const first = line[i];
  if (first === undefined) return null;
  if (first === '"' || first === "'") {
    let j = i + 1;
    while (j < line.length && line[j] !== first) j += first === '"' && line[j] === "\\" ? 2 : 1;
    let k = j + 1;
    while (line[k] === " ") k++;
    if (j >= line.length || line[k] !== ":" || !endsToken(line, k + 1)) return null;
    return { key: unquote(line.slice(i, j + 1)), end: k + 1 };
  }
  if ("#{[]},&*!|>%@`:".includes(first)) return null;
  for (let j = i + 1; j < line.length; j++) {
    const c = line[j];
    if (c === "#" && line[j - 1] === " ") return null;
    if (c === ":" && endsToken(line, j + 1)) return { key: line.slice(i, j).trimEnd(), end: j + 1 };
  }
  return null;
}

function endsToken(line: string, at: number): boolean {
  return at >= line.length || line[at] === " " || line[at] === "\t";
}

function isBlank(line: string): boolean {
  const t = line.trimStart();
  return t === "" || t.startsWith("#");
}

/** The documents of `text` (split at `---`), with the apiVersion and kind written at their top level. */
export function documentsOf(text: string): DocumentSpan[] {
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const docs: DocumentSpan[] = [];
  let first = 0;
  const close = (endLine: number) => {
    const span: DocumentSpan = {
      from: starts[first] ?? text.length,
      to: endLine < starts.length ? (starts[endLine] ?? text.length) - 1 : text.length,
      firstLine: first,
      endLine,
    };
    for (let l = first; l < endLine; l++) {
      const line = lines[l] ?? "";
      const top = /^(apiVersion|kind):[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
      if (top) span[top[1] as "apiVersion" | "kind"] ??= top[2] ?? top[3] ?? top[4];
    }
    docs.push(span);
  };
  lines.forEach((line, l) => {
    if (SEPARATOR.test(line)) {
      if (l > first) close(l);
      first = l + 1;
    }
  });
  if (first < lines.length || docs.length === 0) close(lines.length);
  return docs;
}

/** The document `offset` is in. */
export function documentAt(text: string, offset: number): DocumentSpan | undefined {
  const docs = documentsOf(text);
  return docs.find((d) => offset >= d.from && offset <= d.to) ?? docs[docs.length - 1];
}

/** Lines inside a block scalar (`key: |`), whose text is not YAML structure. */
function blockScalarLines(lines: readonly string[], first: number, end: number): boolean[] {
  const inside = new Array<boolean>(lines.length).fill(false);
  let parent = -1;
  for (let l = first; l < end; l++) {
    const line = lines[l] ?? "";
    if (parent >= 0) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > parent) {
        inside[l] = true;
        continue;
      }
      parent = -1;
    }
    const ops = openingsOf(line);
    const last = ops[ops.length - 1];
    if (last && BLOCK_SCALAR.test(line.slice(last.rest))) parent = last.col;
  }
  return inside;
}

/**
 * The path of the node a key at column `col` belongs to (or, with `item`, of the list an item at `col` belongs to),
 * found from the lines above `lineNo`.
 */
function parentPath(lines: readonly string[], scalar: readonly boolean[], first: number, lineNo: number, col: number, item: boolean): PathSeg[] {
  const path: PathSeg[] = [];
  let target = col;
  let inItem = item;
  for (let l = lineNo - 1; l >= first && (target > 0 || inItem); l--) {
    const line = lines[l] ?? "";
    if (scalar[l] || isBlank(line)) continue;
    const ops = openingsOf(line);
    let pick = -1;
    ops.forEach((op, at) => {
      if (op.col < target || (inItem && op.kind === "key" && op.col === target)) pick = at;
    });
    if (pick < 0) continue;
    for (let at = pick; at >= 0; at--) {
      const op = ops[at];
      if (!op) continue;
      path.unshift(op.kind === "key" ? (op.key ?? "") : -1);
      target = op.col;
      inItem = op.kind === "item";
    }
  }
  return path;
}

/** The keys at column `col` of the map the line `lineNo` is in (block style). */
function siblingKeys(lines: readonly string[], scalar: readonly boolean[], first: number, end: number, lineNo: number, col: number): string[] {
  const keys: string[] = [];
  for (const step of [-1, 1]) {
    for (let l = lineNo + step; l >= first && l < end; l += step) {
      const line = lines[l] ?? "";
      if (scalar[l] || isBlank(line)) continue;
      const ops = openingsOf(line);
      const key = ops.find((op) => op.kind === "key" && op.col === col);
      const outer = ops.some((op) => op.col < col);
      if (key?.key !== undefined && (step < 0 || !outer)) keys.push(key.key);
      if (outer) break;
    }
  }
  return keys;
}

/** Where the cursor at `offset` is: the path around it and what is being typed. `null` in a comment or block scalar. */
export function contextAt(text: string, offset: number): CursorContext | null {
  const lines = text.split("\n");
  const starts = lineStarts(text);
  let lineNo = starts.length - 1;
  while (lineNo > 0 && (starts[lineNo] ?? 0) > offset) lineNo--;
  const doc = documentsOf(text).find((d) => lineNo >= d.firstLine && lineNo < d.endLine);
  if (!doc) return null;
  const lineStart = starts[lineNo] ?? 0;
  const before = (lines[lineNo] ?? "").slice(0, offset - lineStart);
  const scalar = blockScalarLines(lines, doc.firstLine, doc.endLine);
  if (scalar[lineNo] || /(^|\s)#/.test(before.replace(/"[^"]*"|'[^']*'/g, '""'))) return null;

  const ops = openingsOf(before);
  const items = ops.filter((op) => op.kind === "item");
  const key = ops.find((op) => op.kind === "key");
  const keyCol = key ? key.col : (ops[ops.length - 1]?.rest ?? before.length - before.trimStart().length);
  // The path of the map the key at `keyCol` is in: the lines above, then the items opened on this line.
  const outer = items[0];
  const base = outer
    ? [...parentPath(lines, scalar, doc.firstLine, lineNo, outer.col, true), ...items.map(() => -1)]
    : parentPath(lines, scalar, doc.firstLine, lineNo, keyCol, false);
  const siblings = siblingKeys(lines, scalar, doc.firstLine, doc.endLine, lineNo, keyCol);

  if (key?.key !== undefined) {
    const valueText = before.slice(key.rest);
    if (/^[{[]/.test(valueText)) return flowContext(valueText, offset, [...base, key.key]);
    return { path: base, mode: "value", key: key.key, prefix: valueText, from: offset - valueText.length, column: keyCol, siblings };
  }
  const typed = before.slice(keyCol);
  if (/^[{[]/.test(typed)) return flowContext(typed, offset, base);
  if (/[:{}[\],]/.test(typed) || /^["']/.test(typed)) return null;
  return { path: base, mode: "key", prefix: typed, from: offset - typed.length, column: keyCol, siblings };
}

interface Frame {
  list: boolean;
  /** The key whose value is being typed (maps), once its colon was seen. */
  key?: string;
  /** Start of the current token. */
  token: number;
}

/** The cursor inside a flow collection on its line: `text` starts with `{` or `[` and ends at the cursor; `path` is where the collection is. */
function flowContext(text: string, offset: number, path: readonly PathSeg[]): CursorContext | null {
  const base: PathSeg[] = [...path];
  const frames: Frame[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      continue;
    }
    const top = frames[frames.length - 1];
    if (c === '"' || c === "'") quote = c;
    else if (c === "{" || c === "[") {
      if (top) base.push(top.list ? -1 : (top.key ?? ""));
      frames.push({ list: c === "[", token: i + 1 });
    } else if (c === "}" || c === "]") {
      frames.pop();
      if (frames.length > 0) base.pop();
      if (frames.length === 0) return null;
    } else if (c === "," && top) {
      top.key = undefined;
      top.token = i + 1;
    } else if (c === ":" && top && !top.list && (text[i + 1] === " " || i + 1 === text.length) && top.key === undefined) {
      top.key = unquote(text.slice(top.token, i).trim());
      top.token = i + 1;
    }
  }
  const top = frames[frames.length - 1];
  if (!top || quote) return null;
  const raw = text.slice(top.token);
  const prefix = raw.trimStart();
  const from = offset - prefix.length;
  if (top.list) return { path: base, mode: "value", key: -1, prefix, from, column: 0, siblings: [] };
  if (top.key !== undefined) return { path: base, mode: "value", key: top.key, prefix, from, column: 0, siblings: [] };
  return { path: base, mode: "key", prefix, from, column: 0, siblings: [] };
}

/** The path of the field under `offset` (a key, or the value of a key), with the word's range; for hover/Explain. */
export function fieldAt(text: string, offset: number): { path: PathSeg[]; from: number; to: number } | null {
  const word = /[\w./-]/;
  let from = offset;
  let to = offset;
  while (from > 0 && word.test(text[from - 1] ?? "")) from--;
  while (to < text.length && word.test(text[to] ?? "")) to++;
  const ctx = contextAt(text, to);
  if (!ctx) return null;
  if (ctx.mode === "key") return ctx.prefix ? { path: [...ctx.path, ctx.prefix], from, to } : null;
  return ctx.key === undefined ? null : { path: [...ctx.path, ctx.key], from, to };
}
