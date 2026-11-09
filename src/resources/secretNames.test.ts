import { describe, expect, it } from "vitest";
import { looksSecret } from "./secretNames";

describe("a secret-looking name", () => {
  it("is told by its words, not by letters inside other words", () => {
    for (const name of ["HF_TOKEN", "authToken", "AWS_ACCESS_KEY_ID", "db-password", "--api-key", "clientSecret", "dsn"]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["tokenizer", "author", "monkey", "replicas", "image"]) expect(looksSecret(name), name).toBe(false);
  });
});
