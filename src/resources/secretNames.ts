// Whether a key, flag or variable name looks like it holds a secret, and what is shown instead of its value: the one
// rule of the details' Secret-like fields and k3s/RKE2's node arguments and chart values (ADR-0115, ADR-0123). Pure.

export const HIDDEN = "<hidden>";

/** Words that make a name secret wherever they appear in it (separators ignored). */
const SECRET_SUBSTRINGS = ["secret", "password", "passwd", "credential", "apikey", "accesskey", "privatekey", "passphrase"];
/** Words that make a name secret as a whole part of it (`HF_TOKEN`, `authToken`, `AWS_ACCESS_KEY_ID`; not `tokenizer`, `author`, `monkey`). */
const SECRET_PARTS = new Set(["token", "key", "auth", "authorization", "pwd", "pass", "cred", "creds", "sas", "signature", "cookie", "bearer", "dsn"]);

/** Whether a key, flag or variable name looks like it holds a secret. */
export function looksSecret(name: string): boolean {
  const flat = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SECRET_SUBSTRINGS.some((w) => flat.includes(w)) || flat.endsWith("token")) return true;
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return parts.some((p) => SECRET_PARTS.has(p));
}
