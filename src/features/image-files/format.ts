// Pure helpers of the image file viewer: `ls -l` style modes and where a path's parent folders are.
import type { ImageEntryKind } from "../../api";

const TYPE_CHAR: Record<ImageEntryKind, string> = {
  file: "-",
  directory: "d",
  symlink: "l",
  hardlink: "-",
  other: "?",
};

/** `drwxr-xr-x`, with `s`/`S` for setuid and setgid and `t`/`T` for the sticky bit, as `ls -l` writes them. */
export function modeString(kind: ImageEntryKind, mode: number): string {
  const bit = (mask: number, c: string) => (mode & mask ? c : "-");
  const special = (exec: number, flag: number, on: string) => {
    const x = (mode & exec) !== 0;
    if (mode & flag) return x ? on : on.toUpperCase();
    return x ? "x" : "-";
  };
  return (
    TYPE_CHAR[kind] +
    bit(0o400, "r") +
    bit(0o200, "w") +
    special(0o100, 0o4000, "s") +
    bit(0o040, "r") +
    bit(0o020, "w") +
    special(0o010, 0o2000, "s") +
    bit(0o004, "r") +
    bit(0o002, "w") +
    special(0o001, 0o1000, "t")
  );
}

/** `0755`. */
export function modeOctal(mode: number): string {
  return `0${(mode & 0o7777).toString(8).padStart(3, "0")}`;
}

/** The folders that contain `path`, outermost first (`/usr/bin/sh` → `/`, `/usr`, `/usr/bin`). */
export function parentFolders(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out = ["/"];
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join("/")}`);
  return out;
}
