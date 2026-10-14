import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useMinuteClock } from "./useMinuteClock";

describe("useMinuteClock", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 8, 29, 10, 15, 30));
	});
	afterEach(() => vi.useRealTimers());

	it("ticks on the next minute boundary, then every minute", () => {
		const { result } = renderHook(() => useMinuteClock(true));
		const start = result.current;
		act(() => vi.advanceTimersByTime(29_000));
		expect(result.current).toBe(start);
		act(() => vi.advanceTimersByTime(1_000));
		expect(new Date(result.current).getMinutes()).toBe(16);
		act(() => vi.advanceTimersByTime(60_000));
		expect(new Date(result.current).getMinutes()).toBe(17);
	});

	it("schedules nothing while disabled", () => {
		renderHook(() => useMinuteClock(false));
		expect(vi.getTimerCount()).toBe(0);
	});
});
