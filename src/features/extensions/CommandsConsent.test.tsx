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
});
