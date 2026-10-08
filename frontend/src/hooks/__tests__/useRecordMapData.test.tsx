import { renderHook } from "@testing-library/react";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { Technician } from "../../types/technicians";

const live = vi.hoisted(() => ({ technicians: [] as unknown[], isLoading: false }));
const org = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const useTechRoutes = vi.hoisted(() =>
	vi.fn((_techs: unknown, _scope?: ReadonlySet<string>) => []),
);

vi.mock("../useTechnicianMarkers", () => ({ useLiveTechnicians: () => live }));
vi.mock("../useOrg", () => ({ useOrgSettings: () => org }));
vi.mock("../useTechRoutes", () => ({ useTechRoutes }));

import { useActiveTechCount, useRecordMapData } from "../useRecordMapData";

const ana = {
	id: "t1",
	name: "Ana",
	coords: { lat: 43.8, lon: -91.2 },
	status: "OnSite",
	visit_techs: [{ visit_id: "v1", tech_id: "t1", tech_status: "OnSite", visit: { id: "v1" } }],
} as unknown as Technician;

beforeEach(() => {
	live.technicians = [ana];
	org.data = { name: "HQ", coords: { lat: 44.5, lon: -90.1 } };
	org.isLoading = false;
	useTechRoutes.mockClear();
});

describe("useRecordMapData", () => {
	test("legacy lng site coords still produce a site marker", () => {
		const { result } = renderHook(() =>
			useRecordMapData({
				site: { coords: { lat: 43.9, lng: -91.3 }, label: "Acme" },
				techIds: ["t1"],
				focusVisitIds: ["v1"],
			}),
		);
		expect(result.current.siteCoords).toEqual({ lat: 43.9, lon: -91.3 });
		expect(result.current.markers.some((m) => m.id === "site")).toBe(true);
	});

	test("routes are fetched only for the scoped techs", () => {
		renderHook(() =>
			useRecordMapData({
				site: { coords: null, label: "x" },
				techIds: ["t1"],
				focusVisitIds: ["v1"],
			}),
		);
		const scope = useTechRoutes.mock.calls[0][1] as ReadonlySet<string>;
		expect([...scope]).toEqual(["t1"]);
	});

	test("hidden techs fetch no routes", () => {
		renderHook(() =>
			useRecordMapData({
				site: { coords: null, label: "x" },
				techIds: ["t1"],
				focusVisitIds: ["v1"],
				hideTechs: true,
			}),
		);
		const scope = useTechRoutes.mock.calls[0][1] as ReadonlySet<string>;
		expect(scope.size).toBe(0);
	});

	test("org still loading is not reported missing", () => {
		org.data = undefined;
		org.isLoading = true;
		const { result } = renderHook(() =>
			useRecordMapData({ site: { coords: null, label: "x" }, techIds: [], focusVisitIds: [] }),
		);
		expect(result.current.orgMissing).toBe(false);
	});
});

describe("useRecordMapData stability", () => {
	test("fresh-but-equal techIds arrays yield the same Set instance", () => {
		const { rerender } = renderHook(() =>
			useRecordMapData({
				site: { coords: null, label: "x" },
				techIds: ["t1"],
				focusVisitIds: ["v1"],
			}),
		);
		rerender();
		const [first, second] = useTechRoutes.mock.calls.slice(-2);
		expect(second[1]).toBe(first[1]);
	});
});

describe("useActiveTechCount", () => {
	test("counts techs EnRoute/OnSite on the given visits", () => {
		const { result } = renderHook(() => useActiveTechCount(["v1"]));
		expect(result.current).toBe(1);
	});

	test("zero for other visits", () => {
		const { result } = renderHook(() => useActiveTechCount(["v2"]));
		expect(result.current).toBe(0);
	});
});
