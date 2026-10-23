import type { CoreError } from "./generated/CoreError";
import type { ErrorCode } from "./generated/ErrorCode";

export const ERROR_CODES: readonly ErrorCode[] = [
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
];

/** Error thrown by every `api.*` function. `code` selects the translated text (`errors:<code>`). */
export class ApiError extends Error {
  readonly code: ErrorCode;
  /** What a failed exec auth plugin printed, masked by the backend: shown in the window only (#256). */
  readonly pluginOutput?: string;

  constructor(code: ErrorCode, message: string, pluginOutput?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    if (pluginOutput !== undefined) this.pluginOutput = pluginOutput;
  }

  toCoreError(): CoreError {
    const error: CoreError = { code: this.code, message: this.message };
    if (this.pluginOutput !== undefined) error.pluginOutput = this.pluginOutput;
    return error;
  }
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/** Normalizes whatever a rejected `invoke` produced: a `CoreError` object, a string, an Error. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (typeof err === "object" && err !== null && "code" in err && isErrorCode(err.code)) {
    const message = "message" in err && typeof err.message === "string" ? err.message : "";
    const output = "pluginOutput" in err && typeof err.pluginOutput === "string" ? err.pluginOutput : undefined;
    return new ApiError(err.code, message, output);
  }
  if (typeof err === "string") return new ApiError("other", err);
  if (err instanceof Error) return new ApiError("other", err.message);
  return new ApiError("other", String(err));
}

/** i18n key of the human-readable text for an error code. */
export function errorKey(code: ErrorCode): string {
  return `errors:${code}`;
}
