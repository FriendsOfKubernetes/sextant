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
//
// Problem judges (`contributes.problemJudges`, ADR-0168) are answered through the second argument: Sextant calls
// `problemJudge:<id>` with the objects of the kinds the judge reads, and the judge says which of them have which facts.
// It decides only from those objects: every `host` call and every `fetch` fails while it runs.
//
//   export const handle = defineBackend({}, {
//     problemJudges: {
//       routing: (objects) => objects.filter((o) => !o.values[".spec.hosts"]).map((o) => ({ uid: o.metadata.uid, fact: "no-hosts" })),
//     },
//   });
// The host module exists only inside the component (componentize-js links it); its types are ambient.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./backend-host.d.ts" />
import { call as hostCall, log as hostLog, type CallError } from "sextant:extension/host@1.0.0";
import type { JsonValue, Methods } from "./api";
import { SextantError, toSextantError } from "./errors";
import type { JudgedFact } from "./generated/JudgedFact";
import type { JudgedObject } from "./generated/JudgedObject";

export type { JudgedFact, JudgedObject };

/** One method of the backend: its parameters as the frame sent them, and its answer (anything `JSON.stringify` writes). */
export type BackendHandler = (params: JsonValue) => unknown;

/**
 * A problem judge (ADR-0168): given the objects of the kinds it reads — `{apiVersion, kind, metadata: {name,
 * namespace?, uid, creationTimestamp?}, values: {<declared path>: value}}` — the facts of the ones that have them. A
 * fact names one the manifest declares; its `values` only the names that fact declares (texts, at most 1000
 * characters shown). Sextant leaves out anything else. No `host` call or `fetch` works while it runs.
 */
export type ProblemJudge = (objects: JudgedObject[]) => JudgedFact[] | Promise<JudgedFact[]>;

/** What `defineBackend` answers besides the frames' methods. */
export interface BackendOptions {
  /** The judges of `contributes.problemJudges`, by id: Sextant calls each as `problemJudge:<id>`. */
  problemJudges?: Record<string, ProblemJudge>;
}

/** The method Sextant calls a problem judge by (`problemJudge:<id>`). */
export const PROBLEM_JUDGE_PREFIX = "problemJudge:";

function message(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err) ?? String(err);
}

/**
 * The `handle` export from a map of methods: parameters parsed from JSON, the answer written as JSON, any error (a
 * thrown `Error`, a string, a failed `host` call) turned into the message the frame's call fails with.
 */
export function defineBackend(
  handlers: Record<string, BackendHandler>,
  options: BackendOptions = {},
): (method: string, params: string) => Promise<string> {
  const judges = options.problemJudges ?? {};
  const own = (map: object, key: string) => Object.prototype.hasOwnProperty.call(map, key);
  return async (method, params) => {
    if (method.startsWith(PROBLEM_JUDGE_PREFIX)) {
      const id = method.slice(PROBLEM_JUDGE_PREFIX.length);
      const judge = own(judges, id) ? judges[id] : undefined;
      if (!judge) throw `unknown problem judge ${id}`;
      try {
        const given = (params === "" ? {} : JSON.parse(params)) as { objects?: JudgedObject[] };
        return JSON.stringify((await judge(given.objects ?? [])) ?? []);
      } catch (err) {
        throw message(err);
      }
    }
    const handler = own(handlers, method) ? handlers[method] : undefined;
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
    getMany: (params: Params<"resources.getMany">) => callApi("resources.getMany", params),
    apply: (params: Params<"resources.apply">) => callApi("resources.apply", params),
    create: (params: Params<"resources.create">) => callApi("resources.create", params),
    patch: (params: Params<"resources.patch">) => callApi("resources.patch", params),
    delete: (params: Params<"resources.delete">) => callApi("resources.delete", params),
    instantiate: (params: Params<"resources.instantiate">) => callApi("resources.instantiate", params),
  },
  logs: { tail: (params: Params<"logs.tail">) => callApi("logs.tail", params) },
  secret: { value: (params: Params<"secret.value">) => callApi("secret.value", params) },
  metrics: { query: (params: Params<"metrics.query">) => callApi("metrics.query", params) },
  exec: { run: (params: Params<"exec.run">) => callApi("exec.run", params) },
  /** The extension's data; `{session: true}` (since Sextant 0.30): this run's only, in memory. */
  storage: {
    get: <T extends JsonValue = JsonValue>(key: string, o?: { session?: boolean }) =>
      callApi("storage.get", o?.session === true ? { key, session: true } : { key }) as T | null,
    set: (key: string, value: JsonValue, o?: { session?: boolean }) =>
      void callApi("storage.set", o?.session === true ? { key, value, session: true } : { key, value }),
    remove: (key: string, o?: { session?: boolean }) =>
      void callApi("storage.remove", o?.session === true ? { key, session: true } : { key }),
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
