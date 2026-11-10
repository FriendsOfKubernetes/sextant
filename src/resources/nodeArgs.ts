// What of a k3s/RKE2 node's arguments may be shown (#270, ADR-0123): the masking of the annotation
// `<program>.io/node-args` that the details' metadata list applies (`src/features/details/secrets.ts`). The k3s / RKE2
// views are Sextant's own extension `extensions/k3s` since 0.30 (ADR-0162 amendment), which never gets these
// annotations (the host blanks them, `inline-secrets.json`); the window still shows them in the metadata list, masked
// by these rules. Pure.
//
//   k3s and RKE2 write the arguments a node was started with into the annotation `<program>.io/node-args` (k3s
//   pkg/nodeconfig/nodeconfig.go `NodeArgsAnnotation`), a JSON array of strings in which `--flag=value` is already
//   split into `--flag`, `value`. k3s itself replaces the value after its secret flags (`isSecret`: `--token`, `-t`,
//   `--agent-token`, `--datastore-endpoint`, `--etcd-s3-access-key`, `--etcd-s3-secret-key`, `--vpn-auth`) with
//   `********` (`OmittedValue`), but older releases did not, and a value passed through `--kube-apiserver-arg` and the
//   like is never masked there. So Sextant masks again, more widely: the value of each of k3s's secret flags, of every
//   flag whose name looks secret (`looksSecret`), of every `*-arg` flag whose `name=value` names a secret-looking
//   setting, and k3s's own mask are shown as "hidden" with the flag name only; every other value has its URI-looking
//   parts cleaned of credentials (`cleanText`).
import { cleanText } from "./uri";
import { looksSecret } from "./secretNames";

/** k3s's own mask (`OmittedValue` in pkg/nodeconfig/nodeconfig.go). */
export const K3S_OMITTED = "********";

/** The flags whose value k3s itself masks (`isSecret` in pkg/nodeconfig/nodeconfig.go). */
export const K3S_SECRET_FLAGS: ReadonlySet<string> = new Set([
  "--token",
  "-t",
  "--agent-token",
  "--datastore-endpoint",
  "--etcd-s3-access-key",
  "--etcd-s3-secret-key",
  "--vpn-auth",
]);

/** A node-args annotation longer than this is not read. */
export const MAX_ARGS_TEXT = 64 * 1024;
/** At most this many arguments are shown. */
export const MAX_ARGS = 300;

export interface NodeArg {
  /** `--disable`, or `undefined` for a word that is no flag (the `server` / `agent` subcommand). */
  flag?: string;
  /** The value as it may be shown; `undefined` for a flag without one or when hidden. */
  value?: string;
  hidden: boolean;
}

const isFlag = (word: string) => /^-{1,2}[A-Za-z0-9]/.test(word);

/** Whether the value of `flag` (with its value, for the `*-arg` flags) must not be shown. */
export function secretFlag(flag: string, value: string | undefined): boolean {
  if (K3S_SECRET_FLAGS.has(flag)) return true;
  const name = flag.replace(/^-+/, "");
  if (looksSecret(name) || name.endsWith("datastore-endpoint")) return true;
  // `--kube-apiserver-arg=oidc-client-secret=…`, `--kubelet-arg`, `--etcd-arg`, …: the setting named in the value.
  if (name.endsWith("-arg") && value !== undefined) {
    const setting = value.replace(/^-+/, "").split("=", 1)[0] ?? "";
    if (looksSecret(setting)) return true;
  }
  return false;
}

/** The arguments of `<program>.io/node-args`; `undefined` when absent; `null` when it cannot be read. */
export function nodeArgs(text: string | undefined): NodeArg[] | null | undefined {
  if (text === undefined) return undefined;
  if (text.length > MAX_ARGS_TEXT) return null;
  let words: unknown;
  try {
    words = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(words) || !words.every((w) => typeof w === "string")) return null;
  const list = words as string[];
  const out: NodeArg[] = [];
  for (let i = 0; i < list.length && out.length < MAX_ARGS; i++) {
    const word = list[i]!;
    if (!isFlag(word)) {
      // A bare word: the subcommand, or a value k3s could not pair with a flag.
      out.push({ value: cleanText(word) ?? "", hidden: word === K3S_OMITTED });
      continue;
    }
    let flag = word;
    let value: string | undefined;
    const eq = word.indexOf("=");
    if (eq > 0) {
      flag = word.slice(0, eq);
      value = word.slice(eq + 1);
    } else if (i + 1 < list.length && !isFlag(list[i + 1]!)) {
      value = list[++i]!;
    }
    const hidden = value !== undefined && (value === K3S_OMITTED || secretFlag(flag, value));
    out.push(hidden ? { flag, hidden: true } : { flag, ...(value !== undefined ? { value: cleanText(value) ?? "" } : {}), hidden: false });
  }
  return out;
}
