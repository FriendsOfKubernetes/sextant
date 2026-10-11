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
  "other",
];

/** Error thrown by every `api.*` function. `code` selects the translated text (`errors:<code>`). */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }

  toCoreError(): CoreError {
    return { code: this.code, message: this.message };
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
    return new ApiError(err.code, message);
  }
  if (typeof err === "string") return new ApiError("other", err);
  if (err instanceof Error) return new ApiError("other", err.message);
  return new ApiError("other", String(err));
}

/** i18n key of the human-readable text for an error code. */
export function errorKey(code: ErrorCode): string {
  return `errors:${code}`;
}
