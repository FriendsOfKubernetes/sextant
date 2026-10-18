// Calico's selector expressions (`app == 'web' && has(tier)`, `role in {'a', 'b'}`, `!has(legacy) || all()`), parsed
// and evaluated against labels. `global()` (non-namespaced endpoints) is "maybe" for a pod; an expression that does not
// parse is `null` and its policy or rule is not evaluated.
import type { Labels, Tri } from "./model";

export type Expr =
  | { type: "all" }
  | { type: "global" }
  | { type: "has"; key: string }
  | { type: "eq"; key: string; value: string }
  | { type: "ne"; key: string; value: string }
  | { type: "in"; key: string; values: string[] }
  | { type: "notIn"; key: string; values: string[] }
  | { type: "contains" | "startsWith" | "endsWith"; key: string; value: string }
  | { type: "not"; expr: Expr }
  | { type: "and" | "or"; left: Expr; right: Expr };

type Token = { t: "id"; v: string } | { t: "str"; v: string } | { t: "op"; v: string };

function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "&&" || two === "||") {
      tokens.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if ("!(){},".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return null;
      tokens.push({ t: "str", v: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z0-9_./-]+/.exec(text.slice(i));
    if (!m) return null;
    tokens.push({ t: "id", v: m[0] });
    i += m[0].length;
  }
  return tokens;
}

/** Parses a selector; `""` (and whitespace) is `all()`. */
export function parseCalicoSelector(text: string): Expr | null {
  const tokens = tokenize(text);
  if (!tokens) return null;
  if (tokens.length === 0) return { type: "all" };
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const isId = (v: string) => peek()?.t === "id" && peek()!.v === v;
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new Error(v);
    pos++;
  };
  const string = (): string => {
    const tok = peek();
    if (tok?.t !== "str") throw new Error("string");
    pos++;
    return tok.v;
  };
  const set = (): string[] => {
    expectOp("{");
    const values: string[] = [];
    if (!isOp("}")) {
      values.push(string());
      while (isOp(",")) {
        pos++;
        values.push(string());
      }
    }
    expectOp("}");
    return values;
  };
  const or = (): Expr => {
    let left = and();
    while (isOp("||")) {
      pos++;
      left = { type: "or", left, right: and() };
    }
    return left;
  };
  const and = (): Expr => {
    let left = unary();
    while (isOp("&&")) {
      pos++;
      left = { type: "and", left, right: unary() };
    }
    return left;
  };
  const unary = (): Expr => {
    if (isOp("!")) {
      pos++;
      return { type: "not", expr: unary() };
    }
    return primary();
  };
  const primary = (): Expr => {
    if (isOp("(")) {
      pos++;
      const e = or();
      expectOp(")");
      return e;
    }
    const tok = peek();
    if (tok?.t !== "id") throw new Error("id");
    pos++;
    if ((tok.v === "all" || tok.v === "global") && isOp("(")) {
      pos++;
      expectOp(")");
      return { type: tok.v };
    }
    if (tok.v === "has" && isOp("(")) {
      pos++;
      const key = peek();
      if (key?.t !== "id") throw new Error("key");
      pos++;
      expectOp(")");
      return { type: "has", key: key.v };
    }
    const key = tok.v;
    if (isOp("==")) {
      pos++;
      return { type: "eq", key, value: string() };
    }
    if (isOp("!=")) {
      pos++;
      return { type: "ne", key, value: string() };
    }
    if (isId("in")) {
      pos++;
      return { type: "in", key, values: set() };
    }
    if (isId("not")) {
      pos++;
      if (!isId("in")) throw new Error("in");
      pos++;
      return { type: "notIn", key, values: set() };
    }
    if (isId("contains")) {
      pos++;
      return { type: "contains", key, value: string() };
    }
    if (isId("starts") || isId("ends")) {
      const kind = peek()!.v;
      pos++;
      if (!isId("with")) throw new Error("with");
      pos++;
      return { type: kind === "starts" ? "startsWith" : "endsWith", key, value: string() };
    }
    throw new Error("operator");
  };
  try {
    const expr = or();
    return pos === tokens.length ? expr : null;
  } catch {
    return null;
  }
}

function not(t: Tri): Tri {
  return t === "yes" ? "no" : t === "no" ? "yes" : "maybe";
}

/** Evaluates an expression on labels; `global()` is "maybe" (it selects host endpoints and global network sets). */
export function evalCalico(expr: Expr, labels: Labels): Tri {
  const has = (k: string) => Object.hasOwn(labels, k);
  const v = (k: string) => labels[k];
  switch (expr.type) {
    case "all":
      return "yes";
    case "global":
      return "no";
    case "has":
      return has(expr.key) ? "yes" : "no";
    case "eq":
      return has(expr.key) && v(expr.key) === expr.value ? "yes" : "no";
    case "ne":
      return !has(expr.key) || v(expr.key) !== expr.value ? "yes" : "no";
    case "in":
      return has(expr.key) && expr.values.includes(v(expr.key)!) ? "yes" : "no";
    case "notIn":
      return !has(expr.key) || !expr.values.includes(v(expr.key)!) ? "yes" : "no";
    case "contains":
      return has(expr.key) && v(expr.key)!.includes(expr.value) ? "yes" : "no";
    case "startsWith":
      return has(expr.key) && v(expr.key)!.startsWith(expr.value) ? "yes" : "no";
    case "endsWith":
      return has(expr.key) && v(expr.key)!.endsWith(expr.value) ? "yes" : "no";
    case "not":
      return not(evalCalico(expr.expr, labels));
    case "and": {
      const l = evalCalico(expr.left, labels);
      if (l === "no") return "no";
      const r = evalCalico(expr.right, labels);
      return r === "no" ? "no" : l === "maybe" || r === "maybe" ? "maybe" : "yes";
    }
    case "or": {
      const l = evalCalico(expr.left, labels);
      if (l === "yes") return "yes";
      const r = evalCalico(expr.right, labels);
      return r === "yes" ? "yes" : l === "maybe" || r === "maybe" ? "maybe" : "no";
    }
  }
}

/** Whether the expression uses `global()` (it then selects non-namespaced endpoints, which pods are not). */
export function usesGlobal(expr: Expr): boolean {
  switch (expr.type) {
    case "global":
      return true;
    case "not":
      return usesGlobal(expr.expr);
    case "and":
    case "or":
      return usesGlobal(expr.left) || usesGlobal(expr.right);
    default:
      return false;
  }
}
