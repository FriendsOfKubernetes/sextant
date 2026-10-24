// The names a workload's controller gives its pods, the window's twin of `crates/sextant-core/src/pod_names.rs` (see
// its notes for the sources): the API server cuts a `generateName` base to 58 characters before adding 5 characters of
// the safe alphabet; a Deployment's pods are `<deployment>-<pod-template-hash>-` + 5, the hash being 1 to 10 safe
// characters; a ReplicaSet's, DaemonSet's and Job's `<name>-` + 5; an indexed Job's `<job>-<index>-` + 5 with the Job
// name cut so the base stays within 58; a StatefulSet's `<name>-<ordinal>`, never cut.
import type { WorkloadKind } from "./group";

const SAFE = "[bcdfghjklmnpqrstvwxz2456789]";
/** `names.MaxGeneratedNameLength`. */
export const MAX_GENERATED_BASE = 58;
const MAX_HASH = 10;
const MAX_INDEX_DIGITS = 6;

const literal = (text: string) => text.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");

/** `<name>-<part>-` cut to 58, `<part>` being 1 to `maxPart` characters of `cls`. */
function generatedBase(name: string, cls: string, maxPart: number): string {
  const room = Math.max(0, MAX_GENERATED_BASE - (name.length + 1));
  if (room === 0) return literal(`${name}-`.slice(0, MAX_GENERATED_BASE));
  const forms: string[] = [];
  const whole = Math.min(maxPart, room - 1);
  if (whole >= 1) forms.push(`${cls}{1,${whole}}-`);
  if (room <= maxPart) forms.push(`${cls}{${room}}`);
  return forms.length === 1 ? `${literal(name)}-${forms[0]}` : `${literal(name)}-(?:${forms.join("|")})`;
}

const simpleBase = (name: string) => literal(`${name}-`.slice(0, MAX_GENERATED_BASE));

function indexedBases(name: string): string[] {
  const out: Array<{ kept: string; lo: number; hi: number }> = [];
  for (let digits = 1; digits <= MAX_INDEX_DIGITS; digits++) {
    const append = digits + 2;
    const kept = name.length + append > MAX_GENERATED_BASE ? name.slice(0, MAX_GENERATED_BASE - append) : name;
    const last = out[out.length - 1];
    if (last && last.kept === kept) last.hi = digits;
    else out.push({ kept, lo: digits, hi: digits });
  }
  return out.map(({ kept, lo, hi }) => `${literal(kept)}-[0-9]{${lo === hi ? lo : `${lo},${hi}`}}-`);
}

/** The anchored pattern of the pod names of workload `name` of `kind` (not for a bare Pod). */
export function podNamePattern(kind: Exclude<WorkloadKind, "Pod">, name: string): RegExp {
  const body =
    kind === "Deployment"
      ? `${generatedBase(name, SAFE, MAX_HASH)}${SAFE}{5}`
      : kind === "StatefulSet"
        ? `${literal(name)}-[0-9]+`
        : kind === "Job"
          ? `(?:${[simpleBase(name), ...indexedBases(name)].join("|")})${SAFE}{5}`
          : `${simpleBase(name)}${SAFE}{5}`;
  return new RegExp(`^(?:${body})$`);
}
