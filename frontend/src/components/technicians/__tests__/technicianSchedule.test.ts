import { describe, it, expect } from "vitest";
import { countActiveVisits, lowStockRows, partitionVisits, weekRange } from "../technicianSchedule";
import type { JobVisit } from "../../../types/jobs";
import type { VehicleStockItem } from "../../../types/vehicles";

const NOW = new Date("2026-09-25T12:00:00"); // Friday, local

const v = (id: string, start: string, status: string): JobVisit =>
	({ id, scheduled_start_at: start, scheduled_end_at: start, status }) as unknown as JobVisit;

describe("partitionVisits", () => {
	const visits = [
		v("late-tonight", "2026-09-25T23:30:00", "Scheduled"),
		v("this-morning", "2026-09-25T08:00:00", "Completed"),
		v("tomorrow", "2026-09-26T09:00:00", "Scheduled"),
		v("next-week", "2026-10-01T09:00:00", "Scheduled"),
		v("cancelled-future", "2026-09-28T09:00:00", "Cancelled"),
		v("cancelled-today", "2026-09-25T15:00:00", "Cancelled"),
		v("yesterday", "2026-09-24T09:00:00", "Completed"),
		v("last-month", "2026-08-20T09:00:00", "Completed"),
		v("ran-past-midnight", "2026-09-24T22:00:00", "InProgress"),
	];
	const p = partitionVisits(visits, NOW);
	const ids = (xs: JobVisit[]) => xs.map((x) => x.id);

	it("keeps a late-evening visit in today (local day, not UTC)", () => {
		expect(ids(p.today)).toContain("late-tonight");
	});
	it("keeps an active visit from yesterday in today", () => {
		expect(ids(p.today)).toContain("ran-past-midnight");
	});
	it("orders today ascending", () => {
		expect(ids(p.today)).toEqual(["ran-past-midnight", "this-morning", "late-tonight"]);
	});
	it("excludes cancelled from upcoming", () => {
		expect(ids(p.upcoming)).toEqual(["tomorrow", "next-week"]);
	});
	it("orders past newest first and includes future cancellations", () => {
		expect(ids(p.past)).toEqual([
			"cancelled-future",
			"cancelled-today",
			"yesterday",
			"last-month",
		]);
	});
	it("routes a cancelled visit scheduled for today to past, not today", () => {
		expect(ids(p.today)).not.toContain("cancelled-today");
		expect(ids(p.past)).toContain("cancelled-today");
	});
	it("places every visit exactly once", () => {
		const all = [...p.today, ...p.upcoming, ...p.past].map((x) => x.id).sort();
		expect(all).toEqual(visits.map((x) => x.id).sort());
	});
});

describe("weekRange", () => {
	it("runs local Monday to next Monday", () => {
		const { start, end } = weekRange(NOW);
		expect(new Date(start)).toEqual(new Date("2026-09-21T00:00:00"));
		expect(new Date(end)).toEqual(new Date("2026-09-28T00:00:00"));
	});
	it("treats Sunday as the end of the week, not the start", () => {
		const { start } = weekRange(new Date("2026-09-27T20:00:00"));
		expect(new Date(start)).toEqual(new Date("2026-09-21T00:00:00"));
	});
});

describe("lowStockRows", () => {
	const s = (id: string, on: number, min: number) =>
		({ id, qty_on_hand: on, qty_min: min }) as VehicleStockItem;
	it("keeps rows under minimum, worst first, capped", () => {
		const rows = lowStockRows(
			[s("ok", 5, 2), s("a", 1, 2), s("b", 0, 6), s("eq", 2, 2)],
			8
		);
		expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
		expect(
			lowStockRows(Array.from({ length: 12 }, (_, i) => s(`x${i}`, 0, 1))).length
		).toBe(8);
		expect(
			lowStockRows(
				Array.from({ length: 12 }, (_, i) => s(`x${i}`, 0, 1)),
				Infinity
			).length
		).toBe(12);
	});
});

describe("countActiveVisits", () => {
	it("counts scheduled and in-flight, not done", () => {
		const vts = [
			"Scheduled",
			"Driving",
			"OnSite",
			"InProgress",
			"Paused",
			"Delayed",
			"Completed",
			"Cancelled",
		].map((status) => ({ visit: { status } }));
		expect(countActiveVisits(vts)).toBe(6);
	});
});
