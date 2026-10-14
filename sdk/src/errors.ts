import type { ErrorCode } from "./generated/ErrorCode";

/**
 * A call that failed: Sextant refused it (`denied` — outside what the user granted, or the user said no; `invalid`;
 * `notFound`; `forbidden` by the cluster; …), or no answer came in time (`timeout`).
 */
export class SextantError extends Error {
  override readonly name = "SextantError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    /** The API method that failed, when it was a call. */
    readonly method?: string,
  ) {
    super(message);
  }
}

/** Whether `err` is a `SextantError` (with `code`, when given). */
export function isSextantError(err: unknown, code?: ErrorCode): err is SextantError {
  return err instanceof SextantError && (code === undefined || err.code === code);
}

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "unreachable",
  "unauthorized",
  "forbidden",
  "notFound",
  "conflict",
  "invalid",
  "authPlugin",
  "helmMissing",
  "portInUse",
  "kubeconfig",
  "timeout",
  "denied",
  "other",
]);

/** The error of an answer (`{code, message}`), whatever shape it came in. */
export function toSextantError(error: unknown, method?: string): SextantError {
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof record.code === "string" && CODES.has(record.code) ? (record.code as ErrorCode) : "other";
  const message = typeof record.message === "string" && record.message !== "" ? record.message : String(error);
  return new SextantError(code, message, method);
}
