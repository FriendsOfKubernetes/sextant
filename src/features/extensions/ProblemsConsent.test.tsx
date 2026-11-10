// The consent block of problem rules: the kinds judged, and those only looked up by name (ADR-0144) — each a kind the
// user agrees to have read.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ProblemContribution, ProblemJudgeContribution } from "../../api";
import "../../i18n";
import { axeViolations } from "../../test/axe";
import { judgeReads, judgedKinds, lookedUpKinds, ProblemsConsent } from "./ProblemsConsent";

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

  it("name the kinds a rule's definitions define, not an empty kind (kindsFrom)", async () => {
    const definition = { group: "apiextensions.crossplane.io", kind: "CompositeResourceDefinition" };
    const fromDefinitions = rule({
      kind: { group: "", kind: "" },
      kindsFrom: { kind: definition, groupPath: ".spec.group", kindPaths: [".spec.names.kind", ".spec.claimNames.kind"], max: 20 },
    });
    expect(judgedKinds([fromDefinitions])).toEqual([]);
    const { container } = render(<ProblemsConsent rules={[fromDefinitions]} />);
    expect(
      screen.getByText(
        "The kinds that objects of CompositeResourceDefinition (apiextensions.crossplane.io) define (the API group at .spec.group, the kinds at .spec.names.kind, .spec.claimNames.kind), read from the first 20 of them by name",
      ),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("say which kinds and fields a problem judge's backend gets, and that its code runs for them (ADR-0168)", async () => {
    const VS = { group: "networking.istio.io", kind: "VirtualService" };
    const judges: ProblemJudgeContribution[] = [
      { id: "routing", reads: [{ kind: VS, paths: [".spec.hosts", ".spec.exportTo"] }], facts: [{ id: "unknown-host", values: ["host"] }] },
      { id: "tls", reads: [{ kind: { group: "networking.istio.io", kind: "virtualservice" }, paths: [".spec.hosts", ".spec.tls"] }], facts: [{ id: "c", values: [] }] },
    ];
    expect(judgeReads(judges)).toEqual([{ kind: "VirtualService (networking.istio.io)", paths: [".spec.hosts", ".spec.exportTo", ".spec.tls"] }]);
    const judgedRule = rule({ kind: VS, when: { type: "judged", judge: "routing", fact: "unknown-host" } });
    const { container } = render(<ProblemsConsent rules={[judgedRule]} judges={judges} />);
    expect(screen.getByText(/backend decides some of these problems/)).toBeInTheDocument();
    expect(screen.getByText(".spec.exportTo")).toBeInTheDocument();
    expect(screen.getByText(/besides its backend's decisions/)).toBeInTheDocument();
    expect(screen.queryByText(/No code of the extension runs for this/)).not.toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
