import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fillCoords } from "../geocode.js";

const mockFetch = (features: unknown[]) =>
	vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ features }) })));

describe("fillCoords", () => {
	beforeEach(() => vi.stubEnv("MAPBOX_TOKEN", "test"));
	afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

	it("fills coords from the address, flipping Mapbox's [lon, lat]", async () => {
		mockFetch([{ center: [-91.23, 43.79] }]);
		const parsed: { address: string; coords?: unknown } = { address: "3003 Losey Blvd S" };
		expect(await fillCoords(parsed, true)).toBeNull();
		expect(parsed.coords).toEqual({ lat: 43.79, lon: -91.23 });
	});

	it("leaves caller-supplied coords alone", async () => {
		mockFetch([{ center: [0, 0] }]);
		const parsed = { address: "x", coords: { lat: 1, lon: 2 } };
		await fillCoords(parsed, true);
		expect(parsed.coords).toEqual({ lat: 1, lon: 2 });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("errors only when coords are required and the address can't be found", async () => {
		mockFetch([]);
		expect(await fillCoords({ address: "nowhere" }, true)).toMatch(/^Validation failed/);
		expect(await fillCoords({ address: "nowhere" }, false)).toBeNull();
	});
});
