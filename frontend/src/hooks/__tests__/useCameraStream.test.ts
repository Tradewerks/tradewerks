import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCameraStream } from "../useCameraStream";

function fakeMediaDevices() {
	const trackStop = vi.fn();
	const track = {
		stop: trackStop,
		addEventListener: vi.fn(),
		applyConstraints: vi.fn(() => Promise.resolve()),
		getSettings: () => ({}),
	};
	const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
	const getUserMedia = vi.fn(() => Promise.resolve(stream));
	Object.defineProperty(navigator, "mediaDevices", {
		configurable: true,
		value: { getUserMedia },
	});
	HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
	return { getUserMedia, trackStop };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useCameraStream active gating", () => {
	let getUserMedia: ReturnType<typeof fakeMediaDevices>["getUserMedia"];
	let trackStop: ReturnType<typeof fakeMediaDevices>["trackStop"];

	beforeEach(() => {
		({ getUserMedia, trackStop } = fakeMediaDevices());
	});

	it("stops the tracks when it goes inactive", async () => {
		const { rerender } = renderHook(({ active }) => useCameraStream({ active }), {
			initialProps: { active: true },
		});
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		act(() => rerender({ active: false }));
		await waitFor(() => expect(trackStop).toHaveBeenCalled());
	});

	it("does not ask for the camera at all while inactive", async () => {
		renderHook(() => useCameraStream({ active: false }));
		await waitFor(() => expect(getUserMedia).not.toHaveBeenCalled());
	});

	it("starts again when it comes back, so a retake has a preview", async () => {
		const { rerender } = renderHook(({ active }) => useCameraStream({ active }), {
			initialProps: { active: true },
		});
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
		act(() => rerender({ active: false }));
		act(() => rerender({ active: true }));
		await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
	});
});
