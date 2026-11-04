// The consent block of problem rules: the kinds judged, and those only looked up by name (ADR-0144) — each a kind the
// user agrees to have read.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProblemContribution } from "../../api";
import "../../i18n";
import { axeViolations } from "../../test/axe";
import { judgedKinds, lookedUpKinds, ProblemsConsent } from "./ProblemsConsent";

const rule = (over: Partial<ProblemContribution>): ProblemContribution => ({
  id: "r",
  title: "R",
  kind: { group: "kueue.x-k8s.io", kind: "LocalQueue" },
  when: { type: "exists", path: ".spec" },
  graceMinutes: 0,
  notify: true,
  toldThroughOwner: false,
  message: "m",
  ...over,
});

const RULES = [
  rule({
    when: {
      type: "all",
      of: [
        { type: "exists", path: ".spec.clusterQueue" },
        { type: "missing", path: ".spec.clusterQueue", kind: { group: "kueue.x-k8s.io", kind: "ClusterQueue" } },
      ],
    },
  }),
  rule({ id: "s", kind: { group: "kueue.x-k8s.io", kind: "localqueue" } }),
];

describe("problem rules on the consent screen", () => {
  it("list the kinds judged and, apart, the kinds looked up, each once", async () => {
    expect(judgedKinds(RULES)).toEqual(["LocalQueue (kueue.x-k8s.io)"]);
    expect(lookedUpKinds(RULES)).toEqual(["ClusterQueue (kueue.x-k8s.io)"]);
    const { container } = render(<ProblemsConsent rules={RULES} />);
    expect(screen.getByText(/also lists objects of these kinds/)).toBeInTheDocument();
    expect(screen.getByText("ClusterQueue (kueue.x-k8s.io)")).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("say nothing of lookups when no rule has one", () => {
    render(<ProblemsConsent rules={[rule({})]} />);
    expect(screen.queryByText(/also lists objects of these kinds/)).not.toBeInTheDocument();
  });
});
