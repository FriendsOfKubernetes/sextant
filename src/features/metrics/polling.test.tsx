import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS, resetMetricsCache, usePolled } from "./hooks";

afterEach(() => {
  vi.useRealTimers();
  resetMetricsCache();
});

describe("a shared poller", () => {
  it("skips a tick while the previous load is still in flight: rounds never overlap", async () => {
    vi.useFakeTimers();
    // A slow source: each answer takes three intervals.
    let started = 0;
    const fetch = vi.fn(() => {
      started += 1;
      return new Promise<number>((resolve) => setTimeout(() => resolve(started), POLL_INTERVAL_MS * 3));
    });
    const { result, unmount } = renderHook(() => usePolled("slow|c1", fetch));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    });
    // Two ticks passed while the first load was running: nothing more was asked.
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(result.current.data).toBe(1);
    // The next tick after the answer asks again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("asks again after a failed load", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => Promise.reject(new Error("down")));
    const { result, unmount } = renderHook(() => usePolled("failing|c1", fetch));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.current.error).not.toBeNull();
    unmount();
  });
});
