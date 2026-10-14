import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TechnicianVehicleTab from "../detail/TechnicianVehicleTab";
import type { Technician } from "../../../types/technicians";

const perms = vi.hoisted(() => ({ current: {} as Record<string, boolean> }));
const data = vi.hoisted(() => ({
	readiness: null as unknown,
	stock: [] as unknown[],
	reminders: [] as unknown[],
	remindersError: false,
	coDrivers: [] as { id: string; name: string }[],
}));
const calls = vi.hoisted(() => ({
	readiness: [] as unknown[],
	stock: [] as unknown[],
	reminders: [] as unknown[],
	odometer: [] as unknown[],
}));

vi.mock("../../../hooks/usePermission", () => ({
	usePermission: (p: string) => perms.current[p] ?? true,
	useAnyPermission: (ps: string[]) => ps.some((p) => perms.current[p] ?? true),
}));
vi.mock("../../../hooks/useVehicles", () => ({
	useVehicleReadinessQuery: (id: unknown) => {
		calls.readiness.push(id);
		return { data: data.readiness, isLoading: false, isError: false };
	},
	useVehicleMaintenanceReminderQuery: (id: unknown) => {
		calls.reminders.push(id);
		return data.remindersError
			? { data: undefined, isLoading: false, isError: true }
			: { data: data.reminders, isLoading: false, isError: false };
	},
	useVehicleRecord: (id: unknown) => {
		calls.odometer.push(id);
		return id
			? {
					id,
					type: "van",
					year: 2021,
					make: "Ford",
					model: "Transit",
					license_plate: "FLT-3",
					current_odometer_mi: 42_000,
					current_technicians: data.coDrivers,
				}
			: null;
	},
}));
vi.mock("../../../hooks/useVehicleStock", () => ({
	useVehicleStockQuery: (id: unknown) => {
		calls.stock.push(id);
		return { data: data.stock, isLoading: false, isError: false };
	},
}));

const NO_VEHICLE_PERMS = { view_vehicles: false, manage_vehicles: false, use_vehicles: false };
const NO_INVENTORY_PERMS = { view_inventory: false, manage_technicians: false };

const WITH_VEHICLE = {
	id: "t1",
	current_vehicle_id: "v1",
	current_vehicle: { id: "v1", name: "Van 3" },
} as unknown as Technician;

const renderTab = (t: Technician = WITH_VEHICLE) =>
	render(
		<MemoryRouter>
			<TechnicianVehicleTab technician={t} />
		</MemoryRouter>
	);

const stock = (id: string, name: string, on: number, min: number) => ({
	id,
	qty_on_hand: on,
	qty_min: min,
	inventory_item: { name },
});
const reminder = (id: string, title: string, due_at: string) => ({
	id,
	title,
	repeats: false,
	due_at,
	due_odometer_mi: null,
	completed_at: null,
	baseline_at: null,
	baseline_odometer_mi: null,
	interval_miles: null,
	interval_unit: null,
	interval_count: null,
});

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-25T12:00:00"));
	perms.current = {};
	data.coDrivers = [];
	data.readiness = { state: "auto_ready", date: "2026-09-25", gaps: [] };
	data.stock = [];
	data.reminders = [];
	data.remindersError = false;
	calls.readiness = [];
	calls.stock = [];
	calls.reminders = [];
	calls.odometer = [];
});
afterEach(() => vi.useRealTimers());

describe("TechnicianVehicleTab", () => {
	it("shows a panel permission empty state with neither permission group", () => {
		perms.current = { ...NO_INVENTORY_PERMS, ...NO_VEHICLE_PERMS };
		renderTab();
		expect(
			screen.getByText("Needs the View Vehicles or View Inventory permission.")
		).toBeTruthy();
		expect(calls.readiness.every((id) => id === undefined)).toBe(true);
		expect(calls.stock.every((id) => id === undefined)).toBe(true);
		expect(calls.reminders.every((id) => id === undefined)).toBe(true);
		expect(calls.odometer.every((id) => id === undefined)).toBe(true);
	});

	it("gates only the readiness card when inventory permissions are missing", () => {
		perms.current = { ...NO_INVENTORY_PERMS };
		data.stock = [stock("b", "Fuse", 0, 6)];
		renderTab();
		expect(screen.getByText("Needs the View Inventory permission.")).toBeTruthy();
		expect(screen.getAllByTestId("low-stock-name").map((n) => n.textContent)).toEqual([
			"Fuse",
		]);
		expect(screen.getByText("2021 Ford Transit · FLT-3 · 42,000 mi")).toBeTruthy();
		// The stock page is inventory-gated, so its link goes with the permission.
		expect(
			screen.queryByRole("link", {
				name: /Open Vehicle|View Stock|View Maintenance/,
			})
		).toBeNull();
		expect(calls.readiness.every((id) => id === undefined)).toBe(true);
		expect(calls.stock).toContain("v1");
		expect(calls.reminders).toContain("v1");
		expect(calls.odometer).toContain("v1");
	});

	it("gates stock, maintenance and their tiles when vehicle permissions are missing", () => {
		perms.current = { ...NO_VEHICLE_PERMS };
		renderTab();
		expect(screen.getAllByText("Needs the View Vehicles permission.")).toHaveLength(2);
		expect(screen.getByText("Van 3")).toBeTruthy();
		expect(screen.queryByText(/Odometer/)).toBeNull();
		expect(
			screen.queryByRole("link", {
				name: /Open Vehicle|View Stock|View Maintenance/,
			})
		).toBeNull();
		expect(screen.getByText("Ready — stock covers today's visits")).toBeTruthy();
		expect(calls.readiness).toContain("v1");
		expect(calls.stock.every((id) => id === undefined)).toBe(true);
		expect(calls.reminders.every((id) => id === undefined)).toBe(true);
		expect(calls.odometer.every((id) => id === undefined)).toBe(true);
	});

	it("shows an error when reminders fail", () => {
		data.remindersError = true;
		renderTab();
		expect(screen.getByText("Couldn't load maintenance reminders.")).toBeTruthy();
		expect(screen.queryByText("Nothing due.")).toBeNull();
	});

	it("heads the tab with the vehicle name and odometer, no stat row", () => {
		renderTab();
		expect(screen.getByText("Van 3")).toBeTruthy();
		expect(screen.getByText("2021 Ford Transit · FLT-3 · 42,000 mi")).toBeTruthy();
		expect(screen.getAllByText("Low Stock")).toHaveLength(1);
		expect(screen.getAllByText("Maintenance Due")).toHaveLength(1);
	});

	it("lists the other technicians on the vehicle, excluding this one", () => {
		data.coDrivers = [
			{ id: "t1", name: "Self" },
			{ id: "t2", name: "Dana Kim" },
		];
		renderTab();
		expect(screen.getByRole("link", { name: /Dana Kim/ }).getAttribute("href")).toBe(
			"/dispatch/technicians/t2?tab=vehicle"
		);
		expect(screen.queryByText("Self")).toBeNull();
	});

	it("says so when no one else is on the vehicle", () => {
		renderTab();
		expect(screen.getByText("No one else")).toBeTruthy();
	});

	it("links to the vehicle page, its stock tab and its maintenance tab as buttons", () => {
		renderTab();
		const href = (name: RegExp) =>
			screen.getByRole("link", { name }).getAttribute("href");
		expect(href(/Open Vehicle/)).toBe("/dispatch/vehicles/v1/stock");
		expect(href(/View Stock/)).toBe("/dispatch/vehicles/v1/stock?tab=stock");
		expect(href(/View Maintenance/)).toBe(
			"/dispatch/vehicles/v1/stock?tab=maintenance"
		);
	});

	it("admits truncation past eight low-stock rows", () => {
		data.stock = Array.from({ length: 11 }, (_, i) =>
			stock(`s${i}`, `Part ${i}`, 0, 2)
		);
		renderTab();
		expect(screen.getAllByTestId("low-stock-name")).toHaveLength(8);
		expect(screen.getByText("Showing 8 of 11")).toBeTruthy();
	});

	it("shows a no-vehicle empty state", () => {
		renderTab({
			id: "t1",
			current_vehicle_id: null,
			current_vehicle: null,
		} as unknown as Technician);
		expect(screen.getByText("No vehicle assigned")).toBeTruthy();
		expect(screen.getByRole("link", { name: /Vehicles/ }).getAttribute("href")).toBe(
			"/dispatch/vehicles"
		);
	});

	it("drops the vehicles link when the viewer can't open that page", () => {
		perms.current = { ...NO_INVENTORY_PERMS };
		renderTab({
			id: "t1",
			current_vehicle_id: null,
			current_vehicle: null,
		} as unknown as Technician);
		expect(screen.getByText("No vehicle assigned")).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("lists readiness gaps when short", () => {
		data.readiness = {
			state: "needs_action",
			date: "2026-09-25",
			gaps: [
				{
					inventory_item_id: "i1",
					name: "Capacitor 45/5",
					qty_needed: 2,
					qty_on_hand: 0,
					gap: 2,
					visit_ids: [],
				},
			],
		};
		renderTab();
		expect(screen.getByText("Short for today's visits")).toBeTruthy();
		expect(screen.getByText("Capacitor 45/5")).toBeTruthy();
	});

	it("lists only low stock, worst first", () => {
		data.stock = [
			stock("a", "Filter", 1, 2),
			stock("b", "Fuse", 0, 6),
			stock("c", "Tape", 9, 2),
		];
		renderTab();
		const names = screen.getAllByTestId("low-stock-name").map((n) => n.textContent);
		expect(names).toEqual(["Fuse", "Filter"]);
	});

	it("shows only overdue and due-soon reminders", () => {
		data.reminders = [
			reminder("r1", "Oil change", "2026-09-01"),
			reminder("r2", "Registration", "2027-06-01"),
		];
		renderTab();
		expect(screen.getByText("Oil change")).toBeTruthy();
		expect(screen.queryByText("Registration")).toBeNull();
	});
});
