// @vitest-environment node
// sdk/scripts/minisign.mjs and blake2b.mjs: keys and signatures in minisign's own format. The `reference.*` fixtures
// were made by the reference implementation (the rust-minisign crate); the catalog fixture is verified by the app with
// `minisign-verify` (crates/sextant-core/src/extensions/catalog.rs).
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blake2b } from "../scripts/blake2b.mjs";
import {
  generateKeyPair,
  isEncrypted,
  keyIdText,
  MinisignError,
  parsePublicKey,
  parseSecretKey,
  parseSignature,
  scryptParams,
  sign,
  verify,
} from "../scripts/minisign.mjs";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/minisign/${name}`, import.meta.url));
// Small scrypt limits so the tests do not spend 1 GiB per key.
const LIGHT = { opslimit: 32768, memlimit: 16 * 1024 * 1024 };

function failure(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof MinisignError) return err.message;
    throw err;
  }
  throw new Error("accepted");
}

describe("blake2b", () => {
  it("gives RFC 7693's digests and agrees with Node's BLAKE2b-512", () => {
    expect(blake2b(Buffer.from(""), 32).toString("hex")).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(blake2b(Buffer.from("abc"), 64).toString("hex")).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    for (const size of [1, 127, 128, 129, 1000]) {
      const data = randomBytes(size);
      expect(blake2b(data, 64).equals(createHash("blake2b512").update(data).digest())).toBe(true);
    }
  });
});

describe("the reference implementation's files", () => {
  it("verifies its signature and decrypts its encrypted secret key", () => {
    const result = verify(fixture("reference.txt"), fixture("reference.txt.minisig").toString(), fixture("reference.pub").toString());
    expect(result).toEqual({ keyId: parsePublicKey(fixture("reference.pub").toString()).keyId, trustedComment: "from-rust", prehashed: true });
    const key = parseSecretKey(fixture("reference.key").toString(), "reference");
    expect(key.keyId).toBe(result.keyId);
    expect(failure(() => parseSecretKey(fixture("reference.key").toString(), "wrong"))).toBe("wrong password for the secret key");
    expect(failure(() => parseSecretKey(fixture("reference.key").toString()))).toBe("the secret key is encrypted: give its password");
  });

  it("refuses a changed file, a changed trusted comment and another key", () => {
    const data = Buffer.from(fixture("reference.txt"));
    const sig = fixture("reference.txt.minisig").toString();
    const pub = fixture("reference.pub").toString();
    const changed = Buffer.from(data);
    changed[0] = changed[0]! ^ 1;
    expect(failure(() => verify(changed, sig, pub))).toBe("the signature does not match the file");
    const comment = sig.replace("trusted comment: from-rust", "trusted comment: from-someone");
    expect(failure(() => verify(data, comment, pub))).toBe("the trusted comment's signature does not match");
    const other = generateKeyPair();
    expect(failure(() => verify(data, sig, other.publicKeyText))).toMatch(/^the file is signed with key [0-9A-F]{16}, not with key [0-9A-F]{16}$/);
  });
});

describe("keys made here", () => {
  it("sign and verify, unencrypted and encrypted", () => {
    const data = randomBytes(5000);
    for (const pair of [generateKeyPair(), generateKeyPair({ password: "secret", limits: LIGHT })]) {
      const encrypted = isEncrypted(pair.secretKeyText);
      const secret = parseSecretKey(pair.secretKeyText, encrypted ? "secret" : undefined);
      expect(secret.keyId).toBe(pair.keyId);
      const text = sign(data, secret, { fileName: "x.sextant-ext" });
      expect(text.split("\n")[2]).toMatch(/^trusted comment: timestamp:\d+\tfile:x\.sextant-ext\thashed$/);
      expect(verify(data, text, pair.publicKeyBase64).keyId).toBe(pair.keyId);
      expect(verify(data, text, pair.publicKeyText).keyId).toBe(pair.keyId);
    }
  });

  it("write the key id as minisign prints it", () => {
    expect(keyIdText(Buffer.from([1, 2, 3, 4, 5, 6, 7, 0xab]))).toBe("AB07060504030201");
    const pair = generateKeyPair();
    expect(pair.publicKeyText).toBe(`untrusted comment: minisign public key ${pair.keyId}\n${pair.publicKeyBase64}\n`);
  });

  it("pick libsodium's scrypt parameters", () => {
    expect(scryptParams(33554432, 1073741824)).toEqual({ N: 2 ** 20, r: 8, p: 1 });
    expect(scryptParams(1048576, 33554432)).toEqual({ N: 2 ** 15, r: 8, p: 1 });
    expect(scryptParams(32768, 16 * 1024 * 1024)).toEqual({ N: 2 ** 10, r: 8, p: 1 });
  });
});

describe("malformed input", () => {
  it("is refused with a reason", () => {
    expect(failure(() => parsePublicKey("not a key"))).toBe("the public key is not base64");
    expect(failure(() => parsePublicKey("RWQ="))).toBe("the public key has the wrong length");
    expect(failure(() => parseSignature("untrusted comment: x\nAAAA\n"))).toBe("a signature file has four lines");
    expect(failure(() => parseSignature("x".repeat(5000)))).toBe("the signature file is too large");
    const pair = generateKeyPair();
    const text = sign(Buffer.from("x"), parseSecretKey(pair.secretKeyText));
    expect(failure(() => parseSignature(text.replace("untrusted comment: ", "comment: ")))).toBe(
      'the signature\'s first line must start with "untrusted comment:"',
    );
    expect(failure(() => sign(Buffer.from("x"), parseSecretKey(pair.secretKeyText), { trustedComment: "a\nb" }))).toBe(
      "the trusted comment must be one line of at most 2048 bytes",
    );
  });
});
