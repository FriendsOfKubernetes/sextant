// An extension's kinds in the command palette (ADR-0160): searched by default when asked, with short names that never
// shadow Sextant's own.
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceKind } from "../../api";
import { placeKind } from "../../resources/registry";
import { defaultSearchKinds, parseKindQuery, searchKinds } from "./objectIndex";

const kind = (group: string, name: string, plural: string): ResourceKind =>
  ({
    kindRef: { group, version: "v1", kind: name },
    plural,
    namespaced: true,
    verbs: ["list", "watch", "get"],
    printerColumns: [],
    shortNames: [],
  }) as unknown as ResourceKind;

const WIDGET = kind("demo.sextant.dev", "Widget", "widgets");
const GADGET = kind("demo.sextant.dev", "Gadget", "gadgets");
let removers: (() => void)[] = [];

afterEach(() => {
  for (const remove of removers) remove();
  removers = [];
});

describe("an extension's kinds in the palette", () => {
  it("are searched by default when the extension asks, and named by its short names", () => {
    const all = searchKinds([WIDGET, GADGET]);
    expect(defaultSearchKinds(all).map((k) => k.kind.kind)).toEqual([]);
    removers.push(
      placeKind(WIDGET.kindRef, { owner: "demo", section: "demo", order: 0, aliases: ["wd", "po"], searchByDefault: true }),
    );
    expect(defaultSearchKinds(all).map((k) => k.kind.kind)).toEqual(["Widget"]);
    expect(parseKindQuery("wd big", all).kind?.kind.kind).toBe("Widget");
    // `po` is Sextant's own short name for pods: never an extension's.
    expect(parseKindQuery("po big", all).kind?.kind.kind).not.toBe("Widget");
  });
});
