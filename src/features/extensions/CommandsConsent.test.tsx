// The consent block of commands (ADR-0147): each program word for word, where it runs and whether it asks every time.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CommandContribution } from "../../api";
import "../../i18n";
import { axeViolations } from "../../test/axe";
import { CommandsConsent } from "./CommandsConsent";

const command = (over: Partial<CommandContribution>): CommandContribution => ({
  id: "status",
  title: "Ceph status",
  target: { labelSelector: "app=rook-ceph-tools", container: "rook-ceph-tools" },
  argv: ["ceph", "status"],
  params: [],
  changes: false,
  ...over,
});

describe("commands on the consent screen", () => {
  it("show each command word for word, where it runs, and that one that changes something asks every time", async () => {
    const { container } = render(
      <CommandsConsent
        commands={[
          command({}),
          command({ id: "out", title: "Mark an OSD out", argv: ["ceph", "osd", "out", "{{osd}}"], changes: true }),
        ]}
      />,
    );
    expect(screen.getByText("ceph status")).toBeInTheDocument();
    expect(screen.getByText("ceph osd out {{osd}}")).toBeInTheDocument();
    expect(screen.getByText(/^Only reads\. Runs in the container rook-ceph-tools .*app=rook-ceph-tools/)).toBeInTheDocument();
    expect(screen.getByText(/^Changes something: Sextant asks you every time\./)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("say what each parameter may be: one of its values, a whole number in its range, or a name (#339)", () => {
    render(
      <CommandsConsent
        commands={[
          command({
            id: "set",
            argv: ["ceph", "osd", "set", "{{flag}}"],
            params: [{ name: "flag", type: "enum", values: ["noout", "norebalance"] }],
          }),
          command({
            id: "reweight",
            argv: ["ceph", "osd", "reweight", "{{osd}}", "{{pool}}", "{{n}}", "{{m}}", "{{k}}"],
            params: [
              { name: "osd", type: "int", min: 0, max: 100000 },
              { name: "pool", type: "name" },
              { name: "n", type: "int", min: 1 },
              { name: "m", type: "int", max: 9 },
              { name: "k", type: "int" },
            ],
          }),
        ]}
      />,
    );
    expect(screen.getByText("flag: one of noout, norebalance")).toBeInTheDocument();
    expect(screen.getByText("osd: a whole number from 0 to 100000")).toBeInTheDocument();
    expect(screen.getByText("pool: an object name")).toBeInTheDocument();
    expect(screen.getByText("n: a whole number of at least 1")).toBeInTheDocument();
    expect(screen.getByText("m: a whole number of at most 9")).toBeInTheDocument();
    expect(screen.getByText("k: a whole number")).toBeInTheDocument();
  });
});
