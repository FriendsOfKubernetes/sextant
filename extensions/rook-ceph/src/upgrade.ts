// What is checked before a CephCluster's Ceph image changes, after Rook v1.21.1's Documentation/Upgrade/ceph-upgrade.md:
// Rook supports Ceph Squid from v19.2.0 and Tentacle from v20.2.1 (v20.2.0 is not recommended: a known data
// corruption with read affinity), refuses to start an upgrade in HEALTH_ERR, and upgrades daemon by daemon. A check
// that "blocks" stops the change; one that "warns" is shown and the user may go on.
import { healthOf, versionsOf, type CephCluster } from "./rook";

export interface CephVersion {
  major: number;
  minor: number | null;
  patch: number | null;
}

/** The version in an image's tag: `quay.io/ceph/ceph:v20.2.4-20260818` → 20.2.4, `…:v20` → 20; `null` without one. */
export function versionOfImage(image: string): CephVersion | null {
  const tag = /:([^:/@]+)(@sha256:[0-9a-f]+)?$/.exec(image)?.[1];
  const match = tag ? /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[\w.]+)?$/.exec(tag) : null;
  if (!match) return null;
  const num = (s: string | undefined) => (s === undefined ? null : Number(s));
  return { major: Number(match[1]), minor: num(match[2]), patch: num(match[3]) };
}

/** Rook's `status.version.version` (`20.2.0-0`) or a `ceph version 20.2.0 (…)` line. */
export function versionOfText(text: string | null | undefined): CephVersion | null {
  const match = text ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null;
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) } : null;
}

/** -1, 0 or 1, comparing what both versions name (a missing part is treated as 0). */
export function compareVersions(a: CephVersion, b: CephVersion): number {
  const parts = (v: CephVersion) => [v.major, v.minor ?? 0, v.patch ?? 0];
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** The Ceph releases this Rook supports, by major version, and their first supported version. */
export const SUPPORTED: Readonly<Record<number, { release: string; from: CephVersion }>> = {
  19: { release: "Squid", from: { major: 19, minor: 2, patch: 0 } },
  20: { release: "Tentacle", from: { major: 20, minor: 2, patch: 1 } },
};

export type CheckId =
  | "badImage"
  | "noVersion"
  | "unsupported"
  | "tooOld"
  | "notRecommended"
  | "same"
  | "downgrade"
  | "majorJump"
  | "healthError"
  | "mixedVersions"
  | "otherRegistry"
  | "majorTag"
  | "healthWarn";

export interface UpgradeCheck {
  id: CheckId;
  level: "block" | "warn";
  values?: Record<string, string>;
}

const text = (v: CephVersion) => [v.major, v.minor, v.patch].filter((n) => n !== null).join(".");

/** The checks that apply to changing `cluster`'s Ceph image to `image`, blocking ones first. */
export function upgradeChecks(cluster: CephCluster, image: string): UpgradeCheck[] {
  const checks: UpgradeCheck[] = [];
  const target = image.trim();
  if (!/^[a-z0-9][a-z0-9.-]*(:[0-9]+)?(\/[a-z0-9._-]+)+(:[\w.-]+)?(@sha256:[0-9a-f]{64})?$/.test(target)) {
    return [{ id: "badImage", level: "block" }];
  }
  const to = versionOfImage(target);
  const versions = versionsOf(cluster);
  const from = versionOfText(versions.version) ?? versionOfText(versions.running[0]?.version);
  if (!to) checks.push({ id: "noVersion", level: "block" });
  else {
    const supported = SUPPORTED[to.major];
    if (!supported) checks.push({ id: "unsupported", level: "block", values: { version: text(to) } });
    else if (to.minor !== null && compareVersions(to, supported.from) < 0) {
      if (to.major === 20 && to.minor === 2 && to.patch === 0) {
        checks.push({ id: "notRecommended", level: "block", values: { version: text(to) } });
      } else {
        checks.push({ id: "tooOld", level: "block", values: { version: text(to), from: text(supported.from), release: supported.release } });
      }
    }
    if (from) {
      // A tag naming only the major version floats to its newest release: only the major is compared.
      const order = to.minor === null ? Math.sign(to.major - from.major) : compareVersions(to, from);
      if (to.minor !== null && order === 0) checks.push({ id: "same", level: "block", values: { version: text(to) } });
      else if (order < 0) checks.push({ id: "downgrade", level: "block", values: { version: text(to), current: text(from) } });
      if (to.major - from.major > 1) checks.push({ id: "majorJump", level: "block", values: { version: text(to), current: text(from) } });
    }
    if (to.minor === null) checks.push({ id: "majorTag", level: "warn" });
  }
  const health = healthOf(cluster);
  if (health === "HEALTH_ERR") checks.push({ id: "healthError", level: "block" });
  if (health === "HEALTH_WARN") checks.push({ id: "healthWarn", level: "warn" });
  if (versions.running.length > 1) checks.push({ id: "mixedVersions", level: "block", values: { count: String(versions.running.length) } });
  if (!target.startsWith("quay.io/ceph/ceph:") && !target.startsWith("quay.io/ceph/ceph@")) {
    checks.push({ id: "otherRegistry", level: "warn" });
  }
  return checks.sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
}
