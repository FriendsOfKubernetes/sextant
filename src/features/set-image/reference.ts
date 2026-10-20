// Image references as container runtimes read them (the grammar of github.com/distribution/reference):
//
//   reference := name [ ":" tag ] [ "@" digest ]
//   name      := [ host [ ":" port ] "/" ] path-component ( "/" path-component )*
//   tag       := [\w][\w.-]{0,127}
//   digest    := algorithm ":" hex      (sha256: 64 hex digits, sha384: 96, sha512: 128; other algorithms ≥ 32)
//
// A path component is lowercase letters and digits, joined by one ".", one or two "_" or any number of "-". The first
// part of the name is a registry host only when it has a "." or a ":", or is "localhost". Kubernetes itself checks
// little more than "not empty, no surrounding spaces", so a mistyped image would only show up as ImagePullBackOff;
// the dialog checks the grammar before anything is sent.

/** Why a reference is not valid (a key of `setimage:invalid.*`). */
export type ImageError = "empty" | "spaces" | "tooLong" | "uppercase" | "name" | "host" | "tag" | "digest";

/** A valid reference the user may still want to reconsider (a key of `setimage:warning.*`). */
export type ImageWarning = "latest" | "noTag";

export interface ImageReference {
  /** The registry host with its port, `null` for the default registry. */
  host: string | null;
  /** The repository path ("library/nginx", "team/app"). */
  path: string;
  tag: string | null;
  digest: string | null;
}

export type ImageCheck =
  | { ok: true; reference: ImageReference; warning: ImageWarning | null }
  | { ok: false; error: ImageError };

/** The longest name (host and path) a registry accepts. */
export const MAX_NAME_LENGTH = 255;

const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const DOMAIN_COMPONENT = "(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])";
const HOST = new RegExp(`^(?:${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*|\\[[a-fA-F0-9:]+\\])(?::[0-9]+)?$`);
const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^([A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*):([0-9a-fA-F]{32,})$/;
const DIGEST_LENGTHS: Record<string, number> = { sha256: 64, sha384: 96, sha512: 128 };

/** Whether the first part of a name is a registry host rather than a path component. */
function isHost(part: string): boolean {
  return part.includes(".") || part.includes(":") || part === "localhost" || part.startsWith("[");
}

/** Checks one image reference; a valid one comes back split, with a warning for `:latest` or no tag at all. */
export function checkImage(text: string): ImageCheck {
  if (text === "") return { ok: false, error: "empty" };
  if (/\s/.test(text)) return { ok: false, error: "spaces" };
  let rest = text;
  let digest: string | null = null;
  const at = rest.indexOf("@");
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    const match = DIGEST.exec(digest);
    const algorithm = match?.[1]?.toLowerCase() ?? "";
    const expected = DIGEST_LENGTHS[algorithm];
    if (!match || (expected !== undefined && match[2]?.length !== expected)) return { ok: false, error: "digest" };
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(":");
  if (colon > rest.lastIndexOf("/")) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) return { ok: false, error: "tag" };
  }
  if (rest.length > MAX_NAME_LENGTH) return { ok: false, error: "tooLong" };
  const parts = rest.split("/");
  let host: string | null = null;
  if (parts.length > 1 && isHost(parts[0] ?? "")) {
    host = parts.shift() ?? null;
    if (host === null || !HOST.test(host)) return { ok: false, error: "host" };
  }
  for (const part of parts) {
    if (PATH_COMPONENT.test(part)) continue;
    return { ok: false, error: PATH_COMPONENT.test(part.toLowerCase()) ? "uppercase" : "name" };
  }
  const warning: ImageWarning | null = digest !== null ? null : tag === null ? "noTag" : tag === "latest" ? "latest" : null;
  return { ok: true, reference: { host, path: parts.join("/"), tag, digest }, warning };
}
