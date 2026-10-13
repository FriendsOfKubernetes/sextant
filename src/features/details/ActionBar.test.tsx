import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KubeObject } from "../../api";
import "../../resources";
import { registerAction, resetActions } from "../actions/registry";
import { ActionBar } from "./ActionBar";
import podJson from "./fixtures/pod.json";

const POD = { group: "", version: "v1", kind: "Pod" };
const pod = podJson as KubeObject;

beforeEach(() => resetActions());

describe("ActionBar", () => {
  it("shows each action as a standard button with its icon and its label; a glyph still works", async () => {
    const logs = vi.fn();
    registerAction("logs", { labelKey: "Logs", icon: "logs", appliesTo: () => true, run: logs });
    registerAction("delete", { labelKey: "Delete", icon: "×", danger: true, appliesTo: () => true, run: vi.fn() });
    render(<ActionBar clusterId="c1" kind={POD} obj={pod} />);

    const bar = screen.getByRole("toolbar");
    const logsButton = within(bar).getByRole("button", { name: "Logs" });
    expect(logsButton).toHaveClass("btn");
    expect(logsButton).not.toHaveClass("btn--small");
    expect(logsButton).not.toHaveClass("btn--compact");
    expect(logsButton.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(logsButton).toHaveTextContent(/^Logs$/);

    const deleteButton = within(bar).getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveClass("btn", "btn--danger");
    expect(deleteButton.querySelector("svg")).toBeNull();
    expect(deleteButton).toHaveTextContent("×Delete");

    fireEvent.click(logsButton);
    await waitFor(() => expect(logs).toHaveBeenCalledTimes(1));
  });
});
