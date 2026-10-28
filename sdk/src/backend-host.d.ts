// The interface Sextant gives a backend (sdk/wit/sextant-extension.wit, `sextant:extension/host`), as componentize-js
// exposes it to JavaScript: a WIT `result` error is thrown as an error whose `payload` is the WIT value.
declare module "sextant:extension/host@1.0.0" {
  export interface CallError {
    code: string;
    message: string;
  }
  export type Level = "debug" | "info" | "warn" | "error";
  /** One extension-API method, parameters and answer as JSON text; throws with `payload: CallError`. */
  export function call(method: string, params: string): string;
  export function log(level: Level, message: string): void;
}
