// minisign keys and signatures (https://jedisct1.github.io/minisign/), the format Sextant checks catalog packages in
// (ADR-0130; the app verifies with the `minisign-verify` crate). Ed25519 through Node's crypto, prehashed signatures
// ("ED": the signature is over the file's BLAKE2b-512), a trusted comment signed with the signature. Secret keys are
// minisign's: encrypted with scrypt (as libsodium's crypto_pwhash_scryptsalsa208sha256 picks its parameters) or, for
// keys kept in a CI secret, not encrypted; either way with the BLAKE2b-256 checksum minisign checks.
import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync, sign as edSign, verify as edVerify } from "node:crypto";
import { blake2b } from "./blake2b.mjs";

export class MinisignError extends Error {}

const ALG = Buffer.from("Ed");
const ALG_HASHED = Buffer.from("ED");
const KDF_SCRYPT = Buffer.from("Sc");
const KDF_NONE = Buffer.from([0, 0]);
const CHK_BLAKE2B = Buffer.from("B2");
const KEYNUM_BYTES = 8;
const PUBLIC_KEY_BYTES = 2 + KEYNUM_BYTES + 32;
const SECRET_KEY_BYTES = 2 + 2 + 2 + 32 + 8 + 8 + KEYNUM_BYTES + 64 + 32;
const SIGNATURE_BYTES = 2 + KEYNUM_BYTES + 64;
/** A signature file is refused when larger (the format's comments are capped well below this). */
export const MAX_SIGNATURE_BYTES = 4096;
const MAX_COMMENT_BYTES = 1024;
const MAX_TRUSTED_COMMENT_BYTES = 2048;
/** libsodium's OPSLIMIT_SENSITIVE / MEMLIMIT_SENSITIVE, what `minisign -G` uses: scrypt with N = 2^20, r = 8, 1 GiB. */
export const SENSITIVE = { opslimit: 33554432, memlimit: 1073741824 };
// A key file asking scrypt for more than this is refused rather than run.
const MAX_SCRYPT_MEMORY = 2 * 1024 * 1024 * 1024;

const UNTRUSTED = "untrusted comment: ";
const TRUSTED = "trusted comment: ";

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

/** The key id as minisign prints it: the 8 bytes read as a little-endian number, in upper-case hex. */
export function keyIdText(keyNum) {
  return Buffer.from(keyNum).reverse().toString("hex").toUpperCase();
}

function decodeBase64(text, bytes, what) {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new MinisignError(`${what} is not base64`);
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length !== bytes || decoded.toString("base64") !== trimmed) throw new MinisignError(`${what} has the wrong length`);
  return decoded;
}

function lines(text) {
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

function commentLine(line, prefix, max, what) {
  if (!line.startsWith(prefix)) throw new MinisignError(`${what} must start with "${prefix.trim()}"`);
  const comment = line.slice(prefix.length);
  if (Buffer.byteLength(comment) > max) throw new MinisignError(`${what} is too long`);
  return comment;
}

/**
 * A public key: the whole `.pub` file, or only its base64 line (as the catalog's `publisherKey` holds it). Returns
 * `{keyNum, publicKey, keyId, base64}`.
 */
export function parsePublicKey(text) {
  const all = lines(text).filter((line) => line.trim() !== "");
  if (all.length === 2) commentLine(all[0], UNTRUSTED, MAX_COMMENT_BYTES, "the key's first line");
  else if (all.length !== 1) throw new MinisignError("a public key is one base64 line, or a comment line and that line");
  const base64 = all[all.length - 1].trim();
  const bytes = decodeBase64(base64, PUBLIC_KEY_BYTES, "the public key");
  if (!bytes.subarray(0, 2).equals(ALG)) throw new MinisignError("the public key is not an Ed25519 minisign key");
  const keyNum = bytes.subarray(2, 2 + KEYNUM_BYTES);
  return { keyNum, publicKey: bytes.subarray(2 + KEYNUM_BYTES), keyId: keyIdText(keyNum), base64 };
}

/** A `.minisig` file: `{algorithm, keyNum, keyId, signature, trustedComment, globalSignature}`. */
export function parseSignature(text) {
  if (Buffer.byteLength(String(text)) > MAX_SIGNATURE_BYTES) throw new MinisignError("the signature file is too large");
  const all = lines(text);
  while (all.length > 4 && all[all.length - 1] === "") all.pop();
  if (all.length !== 4) throw new MinisignError("a signature file has four lines");
  commentLine(all[0], UNTRUSTED, MAX_COMMENT_BYTES, "the signature's first line");
  const bytes = decodeBase64(all[1], SIGNATURE_BYTES, "the signature");
  const algorithm = bytes.subarray(0, 2);
  if (!algorithm.equals(ALG) && !algorithm.equals(ALG_HASHED)) throw new MinisignError("the signature is not an Ed25519 minisign signature");
  const trustedComment = commentLine(all[2], TRUSTED, MAX_TRUSTED_COMMENT_BYTES, "the signature's third line");
  const globalSignature = decodeBase64(all[3], 64, "the trusted comment's signature");
  const keyNum = bytes.subarray(2, 2 + KEYNUM_BYTES);
  return { algorithm: algorithm.toString(), keyNum, keyId: keyIdText(keyNum), signature: bytes.subarray(2 + KEYNUM_BYTES), trustedComment, globalSignature };
}

function publicKeyObject(raw) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) }, format: "jwk" });
}

const blake2b512 = (data) => createHash("blake2b512").update(data).digest();

/**
 * Checks that `signatureText` (a `.minisig`) signs `message` with `publicKeyText`; throws `MinisignError` otherwise.
 * Returns `{keyId, trustedComment, prehashed}`.
 */
export function verify(message, signatureText, publicKeyText) {
  const key = parsePublicKey(publicKeyText);
  const sig = parseSignature(signatureText);
  if (!sig.keyNum.equals(key.keyNum)) {
    throw new MinisignError(`the file is signed with key ${sig.keyId}, not with key ${key.keyId}`);
  }
  const object = publicKeyObject(key.publicKey);
  const prehashed = sig.algorithm === "ED";
  if (!edVerify(null, prehashed ? blake2b512(message) : Buffer.from(message), object, sig.signature)) {
    throw new MinisignError("the signature does not match the file");
  }
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment)]);
  if (!edVerify(null, global, object, sig.globalSignature)) throw new MinisignError("the trusted comment's signature does not match");
  return { keyId: key.keyId, trustedComment: sig.trustedComment, prehashed };
}

/** libsodium's `pickparams` for crypto_pwhash_scryptsalsa208sha256: `{N, r, p}`. */
export function scryptParams(opslimit, memlimit) {
  let ops = Math.max(32768, opslimit);
  const r = 8;
  let logN = 1;
  let p;
  if (ops < memlimit / 32) {
    p = 1;
    const maxN = Math.floor(ops / (r * 4));
    while (logN < 63 && 2 ** logN <= maxN / 2) logN += 1;
  } else {
    const maxN = Math.floor(memlimit / (r * 128));
    while (logN < 63 && 2 ** logN <= maxN / 2) logN += 1;
    const maxrp = Math.min(Math.floor(ops / 4 / 2 ** logN), 0x3fffffff);
    p = Math.floor(maxrp / r);
  }
  return { N: 2 ** logN, r, p };
}

function keyStream(password, salt, opslimit, memlimit, length) {
  const { N, r, p } = scryptParams(opslimit, memlimit);
  const memory = 128 * N * r;
  if (memory > MAX_SCRYPT_MEMORY || p > 16) throw new MinisignError("the key file asks for more memory than Sextant's tools allow");
  return scryptSync(Buffer.from(password, "utf8"), salt, length, { N, r, p, maxmem: memory + 64 * 1024 * 1024 });
}

const checksum = (keyNum, secret) => blake2b(Buffer.concat([ALG, keyNum, secret]), 32);

const xor = (a, b) => Buffer.from(a.map((byte, i) => byte ^ b[i]));

/**
 * A new key pair. With a `password` the secret key is encrypted as `minisign -G` does (`limits` default to its
 * sensitive ones: about a second and 1 GiB of memory); without, it is written unencrypted (`minisign -G -W`).
 * Returns `{keyId, publicKeyText, publicKeyBase64, secretKeyText}`.
 *
 * @param {{ password?: string, limits?: { opslimit: number, memlimit: number } }} [options]
 */
export function generateKeyPair({ password, limits = SENSITIVE } = {}) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const pk = Buffer.from(jwk.x, "base64url");
  const keyNum = randomBytes(KEYNUM_BYTES);
  const secret = Buffer.concat([seed, pk]);
  const plain = Buffer.concat([keyNum, secret, checksum(keyNum, secret)]);
  const salt = password ? randomBytes(32) : Buffer.alloc(32);
  const ops = password ? limits.opslimit : 0;
  const mem = password ? limits.memlimit : 0;
  const header = Buffer.alloc(16);
  header.writeBigUInt64LE(BigInt(ops), 0);
  header.writeBigUInt64LE(BigInt(mem), 8);
  const sealed = password ? xor(plain, keyStream(password, salt, ops, mem, plain.length)) : plain;
  const secretBytes = Buffer.concat([ALG, password ? KDF_SCRYPT : KDF_NONE, CHK_BLAKE2B, salt, header, sealed]);
  const publicKeyBase64 = Buffer.concat([ALG, keyNum, pk]).toString("base64");
  const keyId = keyIdText(keyNum);
  return {
    keyId,
    publicKeyBase64,
    publicKeyText: `${UNTRUSTED}minisign public key ${keyId}\n${publicKeyBase64}\n`,
    secretKeyText: `${UNTRUSTED}minisign ${password ? "encrypted" : "unencrypted"} secret key\n${secretBytes.toString("base64")}\n`,
  };
}

/** Whether a secret key file needs a password. */
export function isEncrypted(secretKeyText) {
  const all = lines(secretKeyText).filter((line) => line.trim() !== "");
  const bytes = decodeBase64(all[all.length - 1] ?? "", SECRET_KEY_BYTES, "the secret key");
  return bytes.subarray(2, 4).equals(KDF_SCRYPT);
}

/** A secret key file, decrypted with `password` when it is encrypted: `{keyNum, keyId, seed, publicKey}`. */
export function parseSecretKey(secretKeyText, password) {
  const all = lines(secretKeyText).filter((line) => line.trim() !== "");
  if (all.length !== 2) throw new MinisignError("a secret key file is a comment line and a base64 line");
  commentLine(all[0], UNTRUSTED, MAX_COMMENT_BYTES, "the key's first line");
  const bytes = decodeBase64(all[1], SECRET_KEY_BYTES, "the secret key");
  if (!bytes.subarray(0, 2).equals(ALG)) throw new MinisignError("the secret key is not an Ed25519 minisign key");
  const kdf = bytes.subarray(2, 4);
  if (!bytes.subarray(4, 6).equals(CHK_BLAKE2B)) throw new MinisignError("the secret key's checksum is not BLAKE2b");
  const salt = bytes.subarray(6, 38);
  const ops = bytes.readBigUInt64LE(38);
  const mem = bytes.readBigUInt64LE(46);
  let plain = bytes.subarray(54);
  if (kdf.equals(KDF_SCRYPT)) {
    if (typeof password !== "string" || password === "") throw new MinisignError("the secret key is encrypted: give its password");
    if (ops > BigInt(Number.MAX_SAFE_INTEGER) || mem > BigInt(MAX_SCRYPT_MEMORY)) {
      throw new MinisignError("the key file asks for more memory than Sextant's tools allow");
    }
    plain = xor(plain, keyStream(password, salt, Number(ops), Number(mem), plain.length));
  } else if (!kdf.equals(KDF_NONE)) {
    throw new MinisignError("the secret key uses an unknown encryption");
  }
  const keyNum = plain.subarray(0, KEYNUM_BYTES);
  const secret = plain.subarray(KEYNUM_BYTES, KEYNUM_BYTES + 64);
  if (!checksum(keyNum, secret).equals(plain.subarray(KEYNUM_BYTES + 64))) {
    throw new MinisignError(kdf.equals(KDF_SCRYPT) ? "wrong password for the secret key" : "the secret key is damaged");
  }
  return { keyNum, keyId: keyIdText(keyNum), seed: secret.subarray(0, 32), publicKey: secret.subarray(32) };
}

/**
 * A prehashed minisign signature of `message` (the text of a `.minisig`). `trustedComment` is signed too; it defaults
 * to minisign's `timestamp:<seconds>\tfile:<name>\thashed`.
 *
 * @param {Uint8Array} message
 * @param {{ keyNum: Uint8Array, keyId: string, seed: Uint8Array, publicKey: Uint8Array }} secretKey
 * @param {{ fileName?: string, trustedComment?: string, untrustedComment?: string }} [options]
 */
export function sign(message, secretKey, { fileName = "", trustedComment, untrustedComment } = {}) {
  const key = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: b64url(secretKey.seed), x: b64url(secretKey.publicKey) },
    format: "jwk",
  });
  const comment = trustedComment ?? `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${fileName}\thashed`;
  if (/[\r\n]/.test(comment) || Buffer.byteLength(comment) > MAX_TRUSTED_COMMENT_BYTES) {
    throw new MinisignError("the trusted comment must be one line of at most 2048 bytes");
  }
  const signature = edSign(null, blake2b512(message), key);
  const global = edSign(null, Buffer.concat([signature, Buffer.from(comment)]), key);
  const untrusted = untrustedComment ?? `signature from minisign secret key ${secretKey.keyId}`;
  return `${UNTRUSTED}${untrusted}\n${Buffer.concat([ALG_HASHED, secretKey.keyNum, signature]).toString("base64")}\n${TRUSTED}${comment}\n${global.toString("base64")}\n`;
}
