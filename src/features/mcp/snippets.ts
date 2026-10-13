// Configuration the user copies into an AI agent. Pure text, so the exact output is tested.

export type SnippetKind = "claudeCode" | "cursor" | "claudeDesktop";
export const SNIPPET_KINDS: readonly SnippetKind[] = ["claudeCode", "cursor", "claudeDesktop"];

export interface SnippetInput {
  /** `http://127.0.0.1:<port>/mcp`. */
  url: string;
  token: string;
  /** Path of the Sextant executable; `null` when it is not known. */
  binary: string | null;
}

/** Shown in place of the executable path when the backend could not tell it. */
export const UNKNOWN_BINARY = "sextant";

/** Whether the snippet carries the token (Claude Desktop starts `sextant mcp`, which reads the token itself). */
export function snippetHasToken(kind: SnippetKind): boolean {
  return kind !== "claudeDesktop";
}

export function snippet(kind: SnippetKind, { url, token, binary }: SnippetInput): string {
  switch (kind) {
    case "claudeCode":
      return `claude mcp add --transport http sextant ${url} --header "Authorization: Bearer ${token}"`;
    case "cursor":
      return JSON.stringify({ mcpServers: { sextant: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
    case "claudeDesktop":
      return JSON.stringify({ mcpServers: { sextant: { command: binary ?? UNKNOWN_BINARY, args: ["mcp"] } } }, null, 2);
  }
}

export function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/** Whole ports a normal program may listen on. */
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;

/** The port a text field holds, or `null` when it is not a whole number in range. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}
