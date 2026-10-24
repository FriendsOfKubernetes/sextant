import { describe, expect, it } from "vitest";
import cases from "./uri-cases.json";
import { cleanText, safeUri } from "./uri";

// The same cases are read by the Rust twin's test (crates/sextant-core/src/alerts/tests.rs).
describe("the URI cleaners", () => {
  it.each(cases.uri)("safeUri($input)", ({ input, text, hidden }) => {
    expect(safeUri(input)).toEqual(text === null ? undefined : { text, hidden });
  });

  it.each(cases.text)("cleanText($input)", ({ input, output }) => {
    expect(cleanText(input)).toBe(output);
  });
});
