import { describe, expect, it } from "vitest";
import { pluralLabel } from "./pluralLabel";

describe("a counter's plural label", () => {
  it("takes the form the language picks, else other", () => {
    const en = { one: "{{count}} workflow failed recently", other: "{{count}} workflows failed recently" };
    expect(pluralLabel(en, 1, "en")).toBe("1 workflow failed recently");
    expect(pluralLabel(en, 3, "en")).toBe("3 workflows failed recently");
    const ru = { one: "{{count}} процесс", few: "{{count}} процесса", many: "{{count}} процессов", other: "{{count}} процесса" };
    expect(pluralLabel(ru, 21, "ru")).toBe("21 процесс");
    expect(pluralLabel(ru, 3, "ru")).toBe("3 процесса");
    expect(pluralLabel(ru, 5, "ru")).toBe("5 процессов");
    expect(pluralLabel({ other: "{{count}} failed" }, 1, "en")).toBe("1 failed");
  });
});
