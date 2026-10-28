// Small rules of installing: which links the URL install accepts, how a source reads, and the title of an install
// error (the message of the error is the backend's own and is shown under it).
import type { TFunction } from "i18next";
import type { ApiError, ExtensionSource } from "../../api";

/**
 * `https://github.com/<owner>/<repo>/releases/download/<tag>/<file>`: the same rule the backend applies (it is
 * checked there again). Anything else is refused before a request is made.
 */
export function isReleaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password) return false;
  if (url.search) return false;
  const segments = url.pathname.slice(1).split("/");
  return (
    segments.length >= 6 &&
    segments[2] === "releases" &&
    segments[3] === "download" &&
    segments.every((s) => s !== "" && s !== "." && s !== "..")
  );
}

/** Where the extension came from, as a line of text. */
export function sourceText(source: ExtensionSource, t: TFunction): string {
  switch (source.type) {
    case "folder":
      return t("extensions:source.folder", { path: source.path });
    case "file":
      return t("extensions:source.file", { name: source.name });
    case "url":
      return t("extensions:source.url", { url: source.url });
    case "catalog":
      return t("extensions:source.catalog", { repository: source.repository });
  }
}

/**
 * How to review the permissions of a paused extension that was installed from a package: install it again from where
 * it came from (only a folder can be read again in place). `null` for a folder.
 */
export function reinstallText(source: ExtensionSource, t: TFunction): string | null {
  switch (source.type) {
    case "folder":
      return null;
    case "file":
      return t("extensions:reinstall.file", { name: source.name });
    case "url":
      return t("extensions:reinstall.url", { url: source.url });
    case "catalog":
      return t("extensions:reinstall.catalog");
  }
}

/** The headline of an install error, by its code (manifest, unsupported API, conflict, download problems). */
export function installErrorTitle(error: ApiError, t: TFunction): string {
  switch (error.code) {
    case "invalid":
    case "conflict":
    case "notFound":
    case "timeout":
    case "unreachable":
      return t(`extensions:errors.${error.code}`);
    default:
      return t("extensions:errors.other");
  }
}
