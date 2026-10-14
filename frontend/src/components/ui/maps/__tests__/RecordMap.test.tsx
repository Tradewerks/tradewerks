import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test, vi, beforeEach } from "vitest";
import type { RecordMapModel, RecordMapTechRow } from "../../../../lib/recordMap";
import type { MapViewRequest } from "../../../../types/location";

const mapProps = vi.hoisted(() => ({
	current: null as null | { viewRequest?: MapViewRequest | null },
}));
const model = vi.hoisted(() => ({ current: null as unknown }));
const perms = vi.hoisted(() => ({ manage: false }));

vi.mock("../DynamicMap", () => ({
	default: (p: { viewRequest?: MapViewRequest | null }) => {
		mapProps.current = p;
		return <div data-testid="map" />;
	},
}));
vi.mock("../../../../hooks/useRecordMapData", () => ({
	useRecordMapData: () => model.current,
}));
vi.mock("../../../../hooks/usePermission", () => ({
	usePermission: () => perms.manage,
}));

import RecordMap from "../RecordMap";

function row(over: Partial<RecordMapTechRow> = {}): RecordMapTechRow {
	return {
		techId: "t1",
		name: "Ana",
		status: "EnRoute",
		visitId: "v1",
		visitTechStatus: "EnRoute",
		activeHere: true,
		drivingElsewhere: false,
		etaSeconds: 300,
		distanceMeters: 3218.7,
		coords: { lat: 43.85, lon: -91.25 },
		color: "var(--color-tech-1)",
		positionHidden: false,
		...over,
	};
}

function setModel(over: Partial<RecordMapModel & { isLoading: boolean }> = {}) {
	model.current = {
		markers: [],
		routes: [],
		techRows: [row()],
		siteCoords: { lat: 43.9, lon: -91.3 },
		orgCoords: { lat: 44.5, lon: -90.1 },
		orgName: "HQ",
		siteMissing: false,
		orgMissing: false,
		activeCount: 1,
		isLoading: false,
		...over,
	};
}

function renderMap(extra: Partial<React.ComponentProps<typeof RecordMap>> = {}) {
	return render(
		<MemoryRouter>
			<RecordMap
				site={{ coords: { lat: 43.9, lon: -91.3 }, label: "Acme" }}
				address="123 Main St"
				techIds={["t1"]}
				focusVisitIds={["v1"]}
				{...extra}
			/>
		</MemoryRouter>,
	);
}

beforeEach(() => {
	perms.manage = false;
	mapProps.current = null;
	setModel();
});

describe("RecordMap", () => {
	test("has no 'Map' card title — the tab already says Map", () => {
		renderMap();
		expect(screen.queryByRole("heading", { name: "Map" })).toBeNull();
	});

	test("Locate flies to the tech; the Recenter overlay fits", async () => {
		renderMap();
		await userEvent.click(screen.getByRole("button", { name: "Show Ana on map" }));
		expect(mapProps.current?.viewRequest?.target).toEqual({ lat: 43.85, lon: -91.25 });
		await userEvent.click(screen.getByRole("button", { name: "Recenter" }));
		expect(mapProps.current?.viewRequest?.target).toBe("fit");
	});

	test("office Locate flies to the office", async () => {
		renderMap();
		await userEvent.click(screen.getByRole("button", { name: "Show HQ on map" }));
		expect(mapProps.current?.viewRequest?.target).toEqual({ lat: 44.5, lon: -90.1 });
	});

	test("site without coords: empty state, no map, no Recenter", () => {
		setModel({ siteMissing: true, siteCoords: null });
		renderMap();
		expect(screen.getByText("This job's address has no map location.")).toBeInTheDocument();
		expect(screen.queryByTestId("map")).toBeNull();
		expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();
	});

	test("while loading there is no Recenter over the skeleton", () => {
		setModel({ isLoading: true, techRows: [] });
		renderMap();
		expect(screen.queryByRole("button", { name: "Recenter" })).toBeNull();
	});

	test("visit-page mode shows the Crew zone and the hidden note", () => {
		renderMap({ hideTechs: true, hiddenNote: "Visit closed — live positions hidden." });
		expect(screen.getByRole("region", { name: "Crew" })).toBeInTheDocument();
		expect(screen.getByText("Visit closed — live positions hidden.")).toBeInTheDocument();
	});

	test("job mode passes visits through and reports toggles", async () => {
		const onToggleVisit = vi.fn();
		renderMap({
			visits: [
				{
					id: "v1",
					name: "Repair",
					startAt: "2026-10-01T15:00:00Z",
					status: "Scheduled",
					selected: true,
				},
			],
			onToggleVisit,
			tz: "America/Chicago",
		});
		await userEvent.click(screen.getByRole("checkbox", { name: /Repair/ }));
		expect(onToggleVisit).toHaveBeenCalledWith("v1");
	});

	test("changing the selected visits reframes the map once", () => {
		const ui = (ids: string[]) => (
			<MemoryRouter>
				<RecordMap
					site={{ coords: { lat: 43.9, lon: -91.3 }, label: "Acme" }}
					address="123 Main St"
					techIds={["t1"]}
					focusVisitIds={ids}
				/>
			</MemoryRouter>
		);
		const { rerender } = render(ui(["v1"]));
		expect(mapProps.current?.viewRequest ?? null).toBeNull();

		rerender(ui(["v1", "v2"]));
		expect(mapProps.current?.viewRequest).toMatchObject({ id: 1, target: "fit" });

		rerender(ui(["v2", "v1"]));
		expect(mapProps.current?.viewRequest?.id).toBe(1);
	});
});
