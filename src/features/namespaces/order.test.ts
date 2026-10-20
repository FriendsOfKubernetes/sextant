import { describe, expect, it } from "vitest";
import { orderNamespaces } from "./order";

describe("orderNamespaces", () => {
  it.each([
    { name: "nothing selected", all: ["b", "a", "c"], pinned: [], filter: "", selected: [], others: ["a", "b", "c"] },
    {
      name: "selected first, both groups sorted",
      all: ["default", "web", "api", "kube-system"],
      pinned: ["web", "api"],
      filter: "",
      selected: ["api", "web"],
      others: ["default", "kube-system"],
    },
    { name: "everything selected", all: ["b", "a"], pinned: ["a", "b"], filter: "", selected: ["a", "b"], others: [] },
    {
      name: "a pinned name the list does not have is dropped",
      all: ["a", "b"],
      pinned: ["gone", "b"],
      filter: "",
      selected: ["b"],
      others: ["a"],
    },
    {
      name: "the filter keeps the split",
      all: ["web-a", "web-b", "api", "web-c"],
      pinned: ["web-b", "api"],
      filter: "web",
      selected: ["web-b"],
      others: ["web-a", "web-c"],
    },
    {
      name: "the filter is trimmed and case-insensitive",
      all: ["Team-A", "team-b", "other"],
      pinned: ["team-b"],
      filter: "  TEAM ",
      selected: ["team-b"],
      others: ["Team-A"],
    },
    { name: "a filter matching nothing", all: ["a", "b"], pinned: ["a"], filter: "zzz", selected: [], others: [] },
    { name: "duplicates are listed once", all: ["a", "a", "b"], pinned: ["b", "b"], filter: "", selected: ["b"], others: ["a"] },
  ])("$name", ({ all, pinned, filter, selected, others }) => {
    expect(orderNamespaces(all, pinned, filter)).toEqual({ selected, others });
  });
});
