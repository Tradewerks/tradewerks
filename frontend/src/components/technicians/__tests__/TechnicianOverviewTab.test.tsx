import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TechnicianOverviewTab from "../detail/TechnicianOverviewTab";
import type { Technician } from "../../../types/technicians";

const perms = vi.hoisted(() => ({ current: {} as Record<string, boolean> }));
const sheets = vi.hoisted(() => ({ current: [] as unknown[], isError: false }));
const queue = vi.hoisted(() => ({
	totals: {} as Record<string, number>,
	isError: false,
	calls: [] as Record<string, unknown>[],
}));

vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => perms.current[p] ?? true,
	useAnyPermission: (ps: string[]) => ps.some((p) => perms.current[p] ?? true),
}));
vi.mock("../../../hooks/useReports", () => ({
	useTimesheetsReportQuery: () =>
		sheets.isError
			? { data: undefined, isLoading: false, isError: true }
			: { data: sheets.current, isLoading: false, isError: false },
}));
vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchaseQueue: (params: Record<string, unknown>) => {
		queue.calls.push(params);
		return queue.isError
			? { data: undefined, isLoading: false, isError: true }
			: {
					data: {
						items: [],
						total: queue.totals[String(params.status)] ?? 0,
					},
					isLoading: false,
					isError: false,
				};
	},
}));
const vehicles = vi.hoisted(() => ({ record: null as unknown }));
vi.mock("../../../hooks/useVehicles", () => ({
	useVehicleRecord: (id: unknown) => (id ? vehicles.record : null),
}));
// The location card reads the socket-fed list; an empty list falls back to the fetched tech.
vi.mock("../../../hooks/useTechnicianMarkers", () => ({
	useLiveTechnicians: () => ({ technicians: [], isLoading: false }),
}));
vi.mock("../../ui/maps/DynamicMap", () => ({ default: () => <div data-testid="map" /> }));
// BalancedOverviewGrid measures with ResizeObserver; jsdom lacks it.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;

const BASE = {
	id: "t1",
	name: "Maria Rodriguez",
	status: "Available",
	email: "maria@example.com",
	phone: "6082550102",
	hire_date: "2020-06-30T12:00:00",
	last_login: null,
	description: null,
	coords: null,
	current_vehicle: null,
	visit_techs: [],
	organization_role: { id: "r1", name: "Senior", permissions: [] },
};

const renderTab = (over: Record<string, unknown> = {}) =>
	render(
		<MemoryRouter>
			<TechnicianOverviewTab
				technician={{ ...BASE, ...over } as unknown as Technician}
			/>
		</MemoryRouter>
	);

beforeEach(() => {
	vehicles.record = null;
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-25T12:00:00"));
	perms.current = {};
	sheets.current = [];
	sheets.isError = false;
	queue.totals = {};
	queue.isError = false;
	queue.calls = [];
});
afterEach(() => vi.useRealTimers());

describe("TechnicianOverviewTab", () => {
	it("omits gated tiles rather than showing zero", () => {
		perms.current = { view_reports: false, view_field_purchases: false };
		renderTab();
		expect(screen.queryByText("This Week")).toBeNull();
		expect(screen.queryByText("Purchases in Review")).toBeNull();
		expect(screen.getByText("Today")).toBeTruthy();
		expect(screen.getByText("Last Active")).toBeTruthy();
	});

	it("sums payable hours for this technician only", () => {
		sheets.current = [
			{ technicianId: "t1", payableHours: 7.5 },
			{ technicianId: "t1", payableHours: 8 },
			{ technicianId: "other", payableHours: 40 },
		];
		renderTab();
		expect(screen.getByText("15.5")).toBeTruthy();
	});

	it("formats phone as a tel link", () => {
		renderTab();
		const tel = screen.getByRole("link", { name: "(608) 255-0102" });
		expect(tel.getAttribute("href")).toBe("tel:6082550102");
	});

	it("dials digits only when the stored phone is formatted", () => {
		renderTab({ phone: "(608) 255-0102" });
		const tel = screen.getByRole("link", { name: "(608) 255-0102" });
		expect(tel.getAttribute("href")).toBe("tel:6082550102");
	});

	it("sums server totals across the in-review statuses for this technician", () => {
		queue.totals = { open: 51, queried: 2 };
		renderTab();
		expect(screen.getByText("53")).toBeTruthy();
		expect(queue.calls.every((c) => c.technician_id === "t1")).toBe(true);
		expect(new Set(queue.calls.map((c) => c.status))).toEqual(
			new Set(["open", "queried"])
		);
	});

	it("shows a dash, not zero, when a tile's fetch fails", () => {
		sheets.isError = true;
		queue.isError = true;
		renderTab();
		expect(screen.getAllByText("—")).toHaveLength(3);
		expect(screen.queryByText("0")).toBeNull();
	});

	it("links the vehicle to its stock page, or to the Vehicle tab without inventory access", () => {
		const vehicle = { current_vehicle: { id: "v1", name: "Van 3" } };
		const { unmount } = renderTab(vehicle);
		expect(screen.getByRole("link", { name: /Van 3/ }).getAttribute("href")).toBe(
			"/dispatch/vehicles/v1/stock"
		);
		unmount();
		perms.current = { view_inventory: false, manage_technicians: false };
		renderTab(vehicle);
		expect(screen.getByRole("link", { name: /Van 3/ }).getAttribute("href")).toBe(
			"/dispatch/technicians/t1?tab=vehicle"
		);
	});

	it("shows the hire date in the short form", () => {
		renderTab();
		expect(screen.getByText(/Jun 30, 2020/)).toBeTruthy();
	});

	it("reads legacy lng coords", () => {
		renderTab({ coords: { lat: 43.8, lng: -91.2 } });
		expect(screen.getByTestId("map")).toBeTruthy();
	});

	it("fills the vehicle card with spec, plate, odometer and a shared marker", () => {
		vehicles.record = {
			id: "v1",
			type: "van",
			year: 2021,
			make: "Ford",
			model: "Transit",
			license_plate: "FLT-3",
			current_odometer_mi: 42_000,
			current_technicians: [
				{ id: "t1", name: "Maria Rodriguez" },
				{ id: "t2", name: "Dana Kim" },
			],
		};
		renderTab({ current_vehicle: { id: "v1", name: "Van 3", type: "van" } });
		const link = screen.getByRole("link", { name: /Van 3/ });
		expect(link.textContent).toContain("2021 Ford Transit");
		expect(link.textContent).toContain("FLT-3 · 42,000 mi");
		expect(link.textContent).toContain("Shared with Dana Kim");
	});

	it("shows empty states for a tech with no vehicle, coords or visits", () => {
		renderTab();
		expect(screen.getByText("No location reported yet.")).toBeTruthy();
		expect(screen.getByText("No vehicle assigned")).toBeTruthy();
		expect(screen.getByText("Not on a visit")).toBeTruthy();
	});

	it("links the Purchases in Review tile to the field purchases queue", () => {
		renderTab();
		const link = screen.getByRole("link", { name: /Open Queue/ });
		expect(link.getAttribute("href")).toBe("/dispatch/purchases?tab=field_purchases");
	});
});
