// The window's side of the AI agents' read-only diagnostic tools (#210, ADR-0094): `DiagnosticsHost`, mounted once by
// `AppShell`, computes `mcp-diagnostic` requests with the screens' own engines and hooks; nothing is drawn.
export { DiagnosticsHost, MAX_RUNNING, SETTLE_MS } from "./DiagnosticsHost";
export { canRead } from "./scope";
