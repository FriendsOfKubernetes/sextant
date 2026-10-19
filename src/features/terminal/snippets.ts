// Terminal snippets (#154): saved commands whose `{{placeholder}}`s are filled from the pane they go into. Values are
// shell-quoted with single quotes, so a name can never run as code; the filled command is typed on one line without
// control characters, and only "Run" adds Enter.
import type { Snippet } from "../../api/generated/Snippet";
import { hasHiddenChars } from "./text";
import { printable } from "./useTerminal";

export { hasHiddenChars, visibleText } from "./text";

export type { Snippet };

/** Most snippets kept (`MAX_SNIPPETS` in `crates/sextant-core/src/settings/snippets.rs`). */
export const MAX_SNIPPETS = 500;
export const MAX_SNIPPET_NAME_CHARS = 120;
export const MAX_SNIPPET_COMMAND_CHARS = 4096;

/** The placeholders a snippet may use. */
export const PLACEHOLDERS = ["namespace", "pod", "container", "cluster", "context"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** What a pane knows about where it runs; a missing value leaves its placeholder unfilled. */
export type PaneContext = Partial<Record<Placeholder, string>>;

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

/**
 * How values are quoted for the shell of a pane: `posix` (sh, bash, zsh, fish: a container, node or debug shell, a
 * local shell on Linux and macOS), `powershell` (the local shell on Windows), `unknown` (not known yet).
 */
export type ShellKind = "posix" | "powershell" | "unknown";

/** Characters that need no quoting in a POSIX shell word (no `=`, which would make a first word an assignment). */
const SAFE_WORD = /^[A-Za-z0-9_./:@%+,-]+$/;
/** Single quotes for PowerShell: the ASCII one and the typographic ones it also accepts. */
const POWERSHELL_QUOTES = /['‘’‚‛]/g;
/** Any quote character of any shell this may be (refused in a value when the shell is unknown). */
const ANY_QUOTE = /['"`‘-‟]/;

/**
 * `value` as one word of `shell`, or `null` when it cannot be quoted safely there. Never quoted: control, invisible
 * and text-direction characters and backslashes (fish reads `\'` inside single quotes). POSIX: as it is when it has
 * only safe characters, otherwise in single quotes with each `'` written as `'\''`. PowerShell: always in single
 * quotes, each single quote (also ‘ ’ ‚ ‛, which PowerShell takes as quotes) doubled. Unknown: in single quotes, and
 * only without any quote character. Nothing inside single quotes is special (`$()`, backticks, `$VAR`, `;`).
 */
export function quoteFor(shell: ShellKind, value: string): string | null {
  if (hasHiddenChars(value) || value.includes("\\")) return null;
  switch (shell) {
    case "posix":
      return SAFE_WORD.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
    case "powershell":
      return `'${value.replace(POWERSHELL_QUOTES, (q) => q + q)}'`;
    case "unknown":
      return ANY_QUOTE.test(value) ? null : `'${value}'`;
  }
}

/** `value` as one POSIX shell word (see [`quoteFor`]); `null` when it cannot be quoted. */
export function shellQuote(value: string): string | null {
  return quoteFor("posix", value);
}

/** The known placeholders `command` uses, in order of first use. */
export function placeholdersOf(command: string): Placeholder[] {
  const found: Placeholder[] = [];
  for (const m of command.matchAll(PLACEHOLDER_RE)) {
    const name = m[1] as Placeholder;
    if ((PLACEHOLDERS as readonly string[]).includes(name) && !found.includes(name)) found.push(name);
  }
  return found;
}

export interface FilledSnippet {
  /** The command with every known placeholder that has a value replaced by the quoted value; one line. */
  text: string;
  /** Placeholders the command uses that the pane has no value for (the snippet cannot be used there). */
  missing: Placeholder[];
  /** Placeholders whose value cannot be quoted safely for the pane's shell (the snippet cannot be used there). */
  refused: Placeholder[];
}

/** `command` filled from `context` for `shell`; unknown `{{words}}` stay as they are. */
export function fillSnippet(command: string, context: PaneContext, shell: ShellKind = "posix"): FilledSnippet {
  const missing: Placeholder[] = [];
  const refused: Placeholder[] = [];
  const filled = command.replace(PLACEHOLDER_RE, (whole, raw: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(raw)) return whole;
    const name = raw as Placeholder;
    const value = context[name];
    if (value === undefined || value === "") {
      if (!missing.includes(name)) missing.push(name);
      return whole;
    }
    const quoted = quoteFor(shell, value);
    if (quoted === null) {
      if (!refused.includes(name)) refused.push(name);
      return whole;
    }
    return quoted;
  });
  return { text: printable(filled), missing, refused };
}

/** What is typed into the pane: the filled text, plus Enter (`\r`) only for "Run". */
export function snippetInput(filled: FilledSnippet, run: boolean): string | null {
  if (filled.missing.length > 0 || filled.refused.length > 0 || !filled.text) return null;
  return run ? `${filled.text}\r` : filled.text;
}

/** Whether `snippet` may be saved: a name and a command within the limits, without hidden characters. */
export function isValidSnippet(snippet: Pick<Snippet, "name" | "command">): boolean {
  const name = snippet.name.trim();
  const command = snippet.command.trim();
  return (
    name.length > 0 &&
    Array.from(name).length <= MAX_SNIPPET_NAME_CHARS &&
    command.length > 0 &&
    Array.from(command).length <= MAX_SNIPPET_COMMAND_CHARS &&
    !hasHiddenChars(name) &&
    !hasHiddenChars(command)
  );
}

/** A new snippet id (`[A-Za-z0-9_-]`, like the other saved entries). */
export function newSnippetId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** `list` with `snippet` added at the end, or replacing the one with its id. */
export function upsertSnippet(list: Snippet[], snippet: Snippet): Snippet[] {
  const index = list.findIndex((s) => s.id === snippet.id);
  if (index < 0) return list.length >= MAX_SNIPPETS ? list : [...list, snippet];
  return list.map((s, i) => (i === index ? snippet : s));
}

export function deleteSnippet(list: Snippet[], id: string): Snippet[] {
  return list.filter((s) => s.id !== id);
}
