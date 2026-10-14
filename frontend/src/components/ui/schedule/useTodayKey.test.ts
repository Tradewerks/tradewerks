import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTodayKey } from "./useTodayKey";

describe("useTodayKey", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 0));
	});
	afterEach(() => vi.useRealTimers());

	it("rolls over at local midnight, then again a day later", () => {
		const { result } = renderHook(() => useTodayKey());
		expect(result.current).toBe("2026-09-29");
		act(() => vi.advanceTimersByTime(59_000));
		expect(result.current).toBe("2026-09-29");
		act(() => vi.advanceTimersByTime(2_000));
		expect(result.current).toBe("2026-09-30");
		act(() => vi.advanceTimersByTime(24 * 3_600_000));
		expect(result.current).toBe("2026-10-01");
	});

	it("catches up when the tab becomes visible after the timer was missed", () => {
		const { result } = renderHook(() => useTodayKey());
		// Clock jumps without timers firing, as after a laptop sleep.
		vi.setSystemTime(new Date(2026, 9, 2, 8, 0, 0));
		act(() => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(result.current).toBe("2026-10-02");
	});

	it("clears its timer on unmount", () => {
		const { unmount } = renderHook(() => useTodayKey());
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
