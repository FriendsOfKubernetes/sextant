// The one cleaner for URIs and free text from cluster objects that the AI-serving views show (KServe, KubeRay;
// ADR-0115): a URI loses its userinfo (`user:token@`), its query (`?X-Amz-Signature=…`, an Azure SAS) and its
// fragment, and a free text (a condition's or a failure's message) gets the same done to every URI-looking part of
// it. Pure functions.

export interface SafeUri {
  text: string;
  /** Credentials (`user:password@`), a query or a fragment were left out. */
  hidden: boolean;
}

/** `scheme:`, then any slashes, then the rest (newlines included). */
const SCHEME = /^([a-z][a-z0-9+.-]*:)(\/*)([\s\S]*)$/i;

/**
 * A URI as it may be shown. The value is trimmed; everything from the first `?` or `#` is dropped; of what is left,
 * everything between `scheme:` with its slashes and the last `@` is dropped (a password may hold `/` or `@`; the
 * last `@` before the query ends the userinfo as far as anyone can tell, so a path's `@` loses what precedes it —
 * never too little). A value without a scheme (or `user:password@host` without slashes) loses everything up to the
 * `@` before its first `/`. `undefined` for nothing.
 */
export function safeUri(value: string | undefined): SafeUri | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const cut = trimmed.search(/[?#]/);
  const main = cut < 0 ? trimmed : trimmed.slice(0, cut);
  let hidden = cut >= 0;
  const m = SCHEME.exec(main);
  const slashes = m?.[2] ?? "";
  const rest = m?.[3] ?? "";
  if (m && (slashes || !rest.includes("@"))) {
    const at = rest.lastIndexOf("@");
    if (at >= 0) hidden = true;
    return { text: `${m[1]}${slashes}${at < 0 ? rest : rest.slice(at + 1)}`, hidden };
  }
  const text = main.replace(/^[^/]*@/, "");
  return { text, hidden: hidden || text !== main };
}

/** The shown text of a URI, `undefined` for nothing. */
export const safeUriText = (value: string | undefined): string | undefined => safeUri(value)?.text;

/**
 * URI-looking parts of a free text: `scheme:/…` (one slash or more), and `user:password@host…` without a scheme. A
 * part ends at whitespace, a quote or an angle bracket.
 */
const URI_IN_TEXT = /[a-z][a-z0-9+.-]*:\/+[^\s"'`<>]+|[^\s"'`<>/@:]+:[^\s"'`<>/@]*@[^\s"'`<>]+/gi;

/** A free text with every URI-looking part cleaned as `safeUri` cleans a URI; `undefined` stays `undefined`. */
export function cleanText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.replace(URI_IN_TEXT, (part) => safeUri(part)?.text ?? "");
}
