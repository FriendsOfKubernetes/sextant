// The backend side of the SDK (ADR-0131): what a backend written in TypeScript imports as
// `@sextant/extension-sdk/backend`. It runs inside the WebAssembly component (built by `sextant-ext build` with
// componentize-js), not in a frame:
//
//   import { defineBackend, host } from "@sextant/extension-sdk/backend";
//
//   export const handle = defineBackend({
//     async summary() {
//       const clusters = host.clusters.list();
//       const answer = await fetch("https://api.example.com/status"); // a host the manifest declares
//       return { clusters: clusters.length, status: answer.status };
//     },
//   });
//
// `handle` must be exported under that name: it answers the frames' `sextant.backend.call(method, params)`.
// `fetch` reaches only the hosts of `backend.network.hosts`, over HTTPS.
// The host module exists only inside the component (componentize-js links it); its types are ambient.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./backend-host.d.ts" />
import { call as hostCall, log as hostLog, type CallError } from "sextant:extension/host@1.0.0";
import type { JsonValue, Methods } from "./api";
import { SextantError, toSextantError } from "./errors";

/** One method of the backend: its parameters as the frame sent them, and its answer (anything `JSON.stringify` writes). */
export type BackendHandler = (params: JsonValue) => unknown;

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err) ?? String(err);
}

/**
 * The `handle` export from a map of methods: parameters parsed from JSON, the answer written as JSON, any error (a
 * thrown `Error`, a string, a failed `host` call) turned into the message the frame's call fails with.
 */
export function defineBackend(handlers: Record<string, BackendHandler>): (method: string, params: string) => Promise<string> {
  return async (method, params) => {
    const handler = Object.prototype.hasOwnProperty.call(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw `unknown method ${method}`;
    try {
      const parsed = params === "" ? null : (JSON.parse(params) as JsonValue);
      const answer = await handler(parsed);
      return JSON.stringify(answer ?? null);
    } catch (err) {
      // componentize-js passes a thrown string as the `result`'s error; anything else would abort the component.
      throw message(err);
    }
  };
}

type Params<M extends keyof Methods> = Methods[M]["params"];
type Result<M extends keyof Methods> = Methods[M]["result"];

/** A method of the extension API the backend may call (the frame-only ones and watches are left out). */
export type BackendMethod = Exclude<
  keyof Methods,
  "context.get" | "ui.openDetails" | "ui.navigate" | "ui.notify" | "ui.close" | "resources.watch" | "resources.unwatch" | "backend.call"
>;

/** Calls one extension-API method with the extension's grant; throws a `SextantError`. */
function callApi<M extends BackendMethod>(method: M, params?: Params<M>): Result<M> {
  try {
    return JSON.parse(hostCall(method, JSON.stringify(params ?? {}))) as Result<M>;
  } catch (err) {
    const payload = (err as { payload?: CallError }).payload;
    throw payload ? toSextantError(payload, method) : new SextantError("other", message(err), method);
  }
}

/** What a backend reaches through Sextant. Calls are synchronous: they block the backend until Sextant answers. */
export const host = {
  call: callApi,
  clusters: { list: () => callApi("clusters.list") },
  resources: {
    list: (params: Params<"resources.list">) => callApi("resources.list", params),
    get: (params: Params<"resources.get">) => callApi("resources.get", params),
    apply: (params: Params<"resources.apply">) => callApi("resources.apply", params),
    patch: (params: Params<"resources.patch">) => callApi("resources.patch", params),
    delete: (params: Params<"resources.delete">) => callApi("resources.delete", params),
  },
  logs: { tail: (params: Params<"logs.tail">) => callApi("logs.tail", params) },
  secret: { value: (params: Params<"secret.value">) => callApi("secret.value", params) },
  storage: {
    get: <T extends JsonValue = JsonValue>(key: string) => callApi("storage.get", { key }) as T | null,
    set: (key: string, value: JsonValue) => void callApi("storage.set", { key, value }),
    remove: (key: string) => void callApi("storage.remove", { key }),
  },
  /** A credential the manifest declares and the user entered in Sextant, or `null`. */
  credentials: {
    get: (name: string): string | null => {
      try {
        return JSON.parse(hostCall("credentials.get", JSON.stringify({ name }))) as string | null;
      } catch (err) {
        const payload = (err as { payload?: CallError }).payload;
        throw payload ? toSextantError(payload, "credentials.get") : new SextantError("other", message(err));
      }
    },
  },
  /** Lines of the backend's log (Settings → Extensions → Backend log). */
  log: {
    debug: (text: string) => hostLog("debug", text),
    info: (text: string) => hostLog("info", text),
    warn: (text: string) => hostLog("warn", text),
    error: (text: string) => hostLog("error", text),
  },
};
