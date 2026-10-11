import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api";
import { Age, ageParts } from "./Age";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorState } from "./ErrorState";

describe("ConfirmDialog", () => {
  it("does nothing until confirmed; cancel and Escape only cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="Delete 2 pods?" danger confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel}>
        web-1, web-2
      </ConfirmDialog>,
    );
    expect(screen.getByRole("dialog", { name: "Delete 2 pods?" })).toHaveTextContent("web-1, web-2");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when closed", () => {
    render(<ConfirmDialog open={false} title="x" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("ErrorState", () => {
  it("shows the translated text for the code and the original message", () => {
    render(<ErrorState error={new ApiError("unreachable", "dial tcp: connection refused")} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The cluster cannot be reached.");
    expect(alert).toHaveTextContent("dial tcp: connection refused");
  });
});

describe("Age", () => {
  it("uses the largest whole unit like kubectl", () => {
    expect(ageParts(45_000)).toEqual({ unit: "seconds", count: 45 });
    expect(ageParts(3 * 60_000 + 5_000)).toEqual({ unit: "minutes", count: 3 });
    expect(ageParts(5 * 3_600_000)).toEqual({ unit: "hours", count: 5 });
    expect(ageParts(12 * 86_400_000)).toEqual({ unit: "days", count: 12 });
    expect(ageParts(800 * 86_400_000)).toEqual({ unit: "years", count: 2 });
  });

  it("renders an age from a timestamp", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    render(<Age timestamp="2026-10-11T09:00:00Z" now={now} />);
    expect(screen.getByText("3h")).toBeInTheDocument();
  });
});
