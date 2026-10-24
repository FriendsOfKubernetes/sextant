// The one cleaner for URIs and free text from cluster objects that the AI-serving views show (KServe, KubeRay;
// ADR-0115): a URI loses its userinfo (`user:token@`), its query (`?X-Amz-Signature=…`, an Azure SAS) and its
// fragment, and a free text (a condition's or a failure's message) gets the same done to every URI-looking part of
// it. Pure functions.

export interface SafeUri {
  text: string;
  /** Credentials (`user:password@`), a query or a fragment were left out. */
  hidden: boolean;
}

/**
 * The characters trimmed around a URI and ending a URI-looking part of a text: Unicode's White_Space (U+0085 included,
 * which JavaScript's `\s` leaves out), the byte order mark (which Rust's leaves out) and the zero-width spaces and
 * joiners. Kept equal to `SPACE` in `crates/sextant-core/src/alerts/read.rs`; `src/resources/uri-cases.json` holds the
 * cases both must pass.
 */
const SPACE = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u180e\\u2000-\\u200d\\u2028\\u2029\\u202f\\u205f\\u2060\\u3000\\ufeff";
const TRIM = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");

/** `scheme:`, then any slashes, then the rest (newlines included). */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/*)([\s\S]*)$/;
/** A `scheme:/` anywhere: where a URI starts after something else (an invisible mark, say). */
const SCHEME_INSIDE = /[A-Za-z][A-Za-z0-9+.-]*:\//;

/**
 * A URI as it may be shown. The value is trimmed (see `SPACE`); everything from the first `?` or `#` is dropped; of
 * what is left, everything between `scheme:` with its slashes and the last `@` is dropped (a password may hold `/` or
 * `@`; the last `@` before the query ends the userinfo as far as anyone can tell, so a path's `@` loses what precedes
 * it — never too little). A value that does not start with a scheme but has `scheme:/` further on keeps what precedes
 * it and is cleaned from there. A value without a scheme (or `user:password@host` without slashes) loses everything up
 * to the `@` before its first `/`. `undefined` for nothing.
 */
export function safeUri(value: string | undefined): SafeUri | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.replace(TRIM, "");
  if (!trimmed) return undefined;
  const cut = trimmed.search(/[?#]/);
  const main = cut < 0 ? trimmed : trimmed.slice(0, cut);
  const cleaned = cleanMain(main);
  return { text: cleaned.text, hidden: cut >= 0 || cleaned.hidden };
}

function cleanMain(main: string): SafeUri {
  const m = SCHEME.exec(main);
  const slashes = m?.[2] ?? "";
  const rest = m?.[3] ?? "";
  if (m && (slashes || !rest.includes("@"))) {
    const at = rest.lastIndexOf("@");
    return { text: `${m[1]}${slashes}${at < 0 ? rest : rest.slice(at + 1)}`, hidden: at >= 0 };
  }
  const inside = m ? -1 : main.search(SCHEME_INSIDE);
  if (inside > 0) {
    const tail = cleanMain(main.slice(inside));
    return { text: main.slice(0, inside) + tail.text, hidden: tail.hidden };
  }
  const text = main.replace(/^[^/]*@/, "");
  return { text, hidden: text !== main };
}

/** The shown text of a URI, `undefined` for nothing. */
export const safeUriText = (value: string | undefined): string | undefined => safeUri(value)?.text;

/**
 * URI-looking parts of a free text: `scheme:/…` (one slash or more), and `user:password@host…` without a scheme. A
 * part ends at a `SPACE` character, a quote or an angle bracket.
 */
const URI_IN_TEXT = new RegExp(
  `[A-Za-z][A-Za-z0-9+.-]*:/+[^${SPACE}"'\`<>]+|[^${SPACE}"'\`<>/@:]+:[^${SPACE}"'\`<>/@]*@[^${SPACE}"'\`<>]+`,
  "g",
);

/** A free text with every URI-looking part cleaned as `safeUri` cleans a URI; `undefined` stays `undefined`. */
export function cleanText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return text.replace(URI_IN_TEXT, (part) => safeUri(part)?.text ?? "");
}
