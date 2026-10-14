import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DOUBLE_TAP_SCALE, MAX_SCALE, useImagePanZoom } from "../useImagePanZoom";

describe("useImagePanZoom", () => {
	it("starts at fit-width", () => {
		const { result } = renderHook(() => useImagePanZoom("a.jpg"));
		expect(result.current.scale).toBe(1);
	});

	it("clamps zoomTo into range", () => {
		const { result } = renderHook(() => useImagePanZoom("a.jpg"));
		act(() => result.current.zoomTo(99));
		expect(result.current.scale).toBe(MAX_SCALE);
		act(() => result.current.zoomTo(0.1));
		expect(result.current.scale).toBe(1);
	});

	it("steps through the stops and stops at the ends", () => {
		const { result } = renderHook(() => useImagePanZoom("a.jpg"));
		act(() => result.current.stepZoom(1));
		expect(result.current.scale).toBeGreaterThan(1);
		act(() => result.current.stepZoom(-1));
		expect(result.current.scale).toBe(1);
		act(() => result.current.stepZoom(-1));
		expect(result.current.scale).toBe(1);
	});

	// A new receipt is a new document; carrying the last one's zoom hides its top.
	it("resets to fit-width when the key changes", () => {
		const { result, rerender } = renderHook(({ k }) => useImagePanZoom(k), {
			initialProps: { k: "a.jpg" },
		});
		act(() => result.current.zoomTo(DOUBLE_TAP_SCALE));
		expect(result.current.scale).toBe(DOUBLE_TAP_SCALE);
		rerender({ k: "b.jpg" });
		expect(result.current.scale).toBe(1);
	});
});
