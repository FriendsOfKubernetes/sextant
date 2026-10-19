// Screen reader announcements (#158): log views are not read line by line; the new-line count is said sparingly and
// only while the focus is in the log tab.
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANNOUNCE_EVERY_MS, ANNOUNCE_GAP_MS, LogAnnouncer } from "../features/logs/LogAnnouncer";

afterEach(() => vi.useRealTimers());

function View({ total }: { total: number }) {
  return (
    <div className="logs">
      <button>follow</button>
      <LogAnnouncer total={total} />
    </div>
  );
}

describe("log announcements", () => {
  it("say how many lines came, at most once per period, only while the focus is in the log tab", () => {
    vi.useFakeTimers();
    const { rerender } = render(<View total={10} />);
    const live = screen.getByTestId("logs-announce");
    expect(live).toHaveAttribute("aria-live", "polite");

    rerender(<View total={25} />);
    act(() => void vi.advanceTimersByTime(ANNOUNCE_EVERY_MS));
    // The focus is elsewhere: nothing is said, and those lines are not said later either.
    expect(live).toHaveTextContent("");

    screen.getByRole("button", { name: "follow" }).focus();
    rerender(<View total={26} />);
    act(() => void vi.advanceTimersByTime(ANNOUNCE_EVERY_MS - 1));
    expect(live).toHaveTextContent("");
    act(() => void vi.advanceTimersByTime(1));
    expect(live).toHaveTextContent("");
    act(() => void vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(live).toHaveTextContent("1 new line");

    // The same count again is read again: the region is emptied before it.
    rerender(<View total={27} />);
    act(() => void vi.advanceTimersByTime(ANNOUNCE_EVERY_MS - ANNOUNCE_GAP_MS));
    expect(live).toHaveTextContent("");
    act(() => void vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(live).toHaveTextContent("1 new line");

    rerender(<View total={40} />);
    act(() => void vi.advanceTimersByTime(ANNOUNCE_EVERY_MS));
    expect(live).toHaveTextContent("13 new lines");
    act(() => void vi.advanceTimersByTime(ANNOUNCE_EVERY_MS));
    expect(live).toHaveTextContent("");
  });
});
