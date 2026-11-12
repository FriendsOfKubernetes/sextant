// The notes the "What's new" window shows (ADR-0166): per version, the changes a user notices, each a heading and a
// sentence of `whatsnew:<version key>.<item>`, and the extensions of Sextant's own that left the core in that version
// (offered for install). Pure.
import { OFFERS } from "../extension-offers/offers";

export interface ReleaseNotes {
  /** `major.minor.patch`. */
  version: string;
  /** Item keys under `whatsnew:<versionKey>`: each has `.title` and `.text`. */
  items: readonly string[];
  /** Extensions of Sextant's own that replaced built-in views in this version. */
  extensions: readonly string[];
}

/** Newest first. */
export const NOTES: readonly ReleaseNotes[] = [
  {
    version: "0.30.2",
    items: ["hiddenSections", "rollouts", "coverage"],
    extensions: [],
  },
  {
    version: "0.30.1",
    items: ["memory", "api5", "commandValues"],
    extensions: [],
  },
  {
    version: "0.30.0",
    items: ["extensionsMoved", "agentTools", "api4"],
    extensions: OFFERS.map((offer) => offer.id),
  },
];

/** The i18n key part of a version: `0.30.0` → `v0_30_0`. */
export const versionKey = (version: string): string => `v${version.replaceAll(".", "_")}`;

/** Compares `major.minor.patch` versions (a pre-release or build suffix ignored); unreadable parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[-+]/)[0]!.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The notes newer than `seen`, newest first. */
export function notesSince(seen: string): ReleaseNotes[] {
  return NOTES.filter((n) => compareVersions(n.version, seen) > 0);
}

/** What to remember as seen: the app's version or the newest notes, whichever is newer (`major.minor.patch`). */
export function seenAfter(appVersion: string | null): string {
  const newest = NOTES[0]?.version ?? "0.0.0";
  const app = appVersion?.split(/[-+]/)[0];
  if (!app || !/^\d+\.\d+\.\d+$/.test(app)) return newest;
  return compareVersions(app, newest) > 0 ? app : newest;
}
