// Signing for the extension catalog (ADR-0130): a publisher makes a minisign key pair once, signs every package it
// releases, and puts the public key into its catalog entry. The files are minisign's own, so `minisign` and `rsign`
// read and write them too.
//
//   sextant-ext keygen <name> [--out <dir>] [--password-env <VAR>]   write <name>.pub and <name>.key
//   sextant-ext sign <file> (--key <file.key> | --key-env <VAR>) [--password-env <VAR>]   write <file>.minisig
//   sextant-ext verify <file> --key <file.pub | base64>   check <file>.minisig
//
// A password is read from the environment variable `--password-env` names, never from the command line. Without one,
// `keygen` writes an unencrypted secret key: fine in a CI secret store, not on a shared disk.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { generateKeyPair, isEncrypted, MinisignError, parseSecretKey, sign, verify } from "./minisign.mjs";
import { SIGNATURE_SUFFIX } from "./catalog.mjs";

class UsageError extends Error {}

function options(argv, names) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (!names.includes(name)) throw new UsageError(`unknown option ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      out[name] = value;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function passwordFrom(variable) {
  if (variable === undefined) return undefined;
  const value = process.env[variable];
  if (!value) throw new UsageError(`the environment variable ${variable} is empty`);
  return value;
}

function keygen(argv) {
  const args = options(argv, ["out", "password-env"]);
  const [name] = args.positional;
  if (!name || args.positional.length !== 1 || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    throw new UsageError("usage: keygen <name> [--out <dir>] [--password-env <VAR>]");
  }
  const password = passwordFrom(args["password-env"]);
  const dir = resolve(args.out ?? ".");
  const pair = generateKeyPair({ password });
  // `wx`: an existing key is never overwritten.
  writeFileSync(join(dir, `${name}.key`), pair.secretKeyText, { flag: "wx", mode: 0o600 });
  writeFileSync(join(dir, `${name}.pub`), pair.publicKeyText, { flag: "wx" });
  process.stdout.write(`key ${pair.keyId}: ${join(dir, `${name}.pub`)} and ${join(dir, `${name}.key`)}\n`);
  process.stdout.write(`publisherKey for the catalog entry: ${pair.publicKeyBase64}\n`);
  if (!password) {
    process.stderr.write("the secret key is not encrypted: keep it in a secret store (a GitHub Actions secret), not on a shared disk\n");
  }
  return 0;
}

function signCommand(argv) {
  const args = options(argv, ["key", "key-env", "password-env"]);
  const [file] = args.positional;
  if (!file || args.positional.length !== 1 || (args.key === undefined) === (args["key-env"] === undefined)) {
    throw new UsageError("usage: sign <file> (--key <file.key> | --key-env <VAR>) [--password-env <VAR>]");
  }
  const keyText = args.key !== undefined ? readFileSync(args.key, "utf8") : passwordFrom(args["key-env"]);
  const password = passwordFrom(args["password-env"]);
  if (isEncrypted(keyText) && password === undefined) throw new UsageError("the secret key is encrypted: name its password with --password-env");
  const secret = parseSecretKey(keyText, password);
  const data = readFileSync(file);
  const name = file.split(/[\\/]/).pop();
  const output = `${file}${SIGNATURE_SUFFIX}`;
  writeFileSync(output, sign(data, secret, { fileName: name }));
  process.stdout.write(`${output} (key ${secret.keyId})\n`);
  return 0;
}

function verifyCommand(argv) {
  const args = options(argv, ["key"]);
  const [file] = args.positional;
  if (!file || args.positional.length !== 1 || args.key === undefined) throw new UsageError("usage: verify <file> --key <file.pub | base64>");
  let keyText = args.key;
  try {
    keyText = readFileSync(args.key, "utf8");
  } catch {
    // Not a file: the base64 line itself.
  }
  const result = verify(readFileSync(file), readFileSync(`${file}${SIGNATURE_SUFFIX}`, "utf8"), keyText);
  process.stdout.write(`${file}: signed by key ${result.keyId}\n`);
  return 0;
}

const COMMANDS = { keygen, sign: signCommand, verify: verifyCommand };

/** Runs one of `keygen`, `sign`, `verify`; returns the exit code. */
export function main(command, argv) {
  try {
    return COMMANDS[command](argv);
  } catch (err) {
    if (err instanceof UsageError || err instanceof MinisignError) {
      process.stderr.write(`${command}: ${err.message}\n`);
      return err instanceof UsageError ? 2 : 1;
    }
    if (err?.code === "EEXIST") {
      process.stderr.write(`${command}: ${err.path} exists; Sextant's tools never overwrite a key\n`);
      return 1;
    }
    if (err?.code === "ENOENT") {
      process.stderr.write(`${command}: ${err.path} does not exist\n`);
      return 1;
    }
    throw err;
  }
}
