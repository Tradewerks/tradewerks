import { describe, expect, test } from "vitest";
import { buildTechMarker, formatEtaShort, hasValidCoords } from "../mapMarkers";
import type { Technician } from "../../types/technicians";
import type { TechRouteData } from "../../types/location";

const tech = { id: "t1", name: "Ana", coords: { lat: 1, lon: 2 }, status: "EnRoute" } as Technician;
const route: TechRouteData = {
	techId: "t1",
	techName: "Ana",
	visitId: "v1",
	jobId: "j1",
	color: "var(--color-tech-1)",
	current: { lat: 1.5, lon: 2.5 },
	destination: { lat: 3, lon: 4 },
	destinationLabel: "Client",
	routeGeoJSON: null,
	etaSeconds: 300,
	distanceMeters: 3218,
};

describe("formatEtaShort", () => {
	test.each([
		[null, ""],
		[30, "~1m"],
		[300, "~5m"],
		[3600, "~1h"],
		[3900, "~1h5m"],
	])("%s → %s", (input, out) => expect(formatEtaShort(input)).toBe(out));
});

describe("hasValidCoords", () => {
	test("rejects null, NaN and the 0,0 placeholder", () => {
		expect(hasValidCoords(null)).toBe(false);
		expect(hasValidCoords({ lat: Number.NaN, lon: 1 })).toBe(false);
		expect(hasValidCoords({ lat: 0, lon: 0 })).toBe(false);
		expect(hasValidCoords({ lat: 43.8, lon: -91.2 })).toBe(true);
	});
});

describe("buildTechMarker", () => {
	test("a driving tech sits at the route's position with an ETA and its route color", () => {
		const m = buildTechMarker(tech, { route, showEta: true });
		expect(m).toMatchObject({
			id: "tech-t1",
			type: "TECHNICIAN",
			coords: route.current,
			label: "Ana · ~5m",
			color: route.color,
			variant: "default",
		});
	});

	test("showEta false drops the suffix", () => {
		expect(buildTechMarker(tech, { route, showEta: false }).label).toBe("Ana");
	});

	test("a route without an ETA yet has no suffix", () => {
		const m = buildTechMarker(tech, { route: { ...route, etaSeconds: null }, showEta: true });
		expect(m.label).toBe("Ana");
	});

	test("an idle tech is dimmed at its own coords with no color", () => {
		const m = buildTechMarker(tech, { route: null, showEta: true });
		expect(m).toMatchObject({ coords: tech.coords, variant: "dimmed", label: "Ana" });
		expect(m.color).toBeUndefined();
	});

	test("a note replaces the ETA suffix", () => {
		const m = buildTechMarker(tech, { route: null, showEta: true, note: "En route elsewhere" });
		expect(m.label).toBe("Ana · En route elsewhere");
	});
});
