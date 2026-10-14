import { describe, it, expect } from "vitest";
import {
	arrivalDueAt,
	classifyDelay,
	decideAlert,
	forecastRoute,
	type ForecastStop,
} from "../arrivalForecast.js";

const NOW = new Date("2026-10-01T19:00:00Z"); // 2:00 PM CDT
const min = (n: number) => n * 60_000;
const at = (offsetMin: number) => new Date(NOW.getTime() + min(offsetMin));
const leg = (minutes: number, typicalMinutes: number | null = null) => ({
	durationSeconds: minutes * 60,
	typicalSeconds: typicalMinutes === null ? null : typicalMinutes * 60,
	distanceMeters: 10_000,
});
const stop = (over: Partial<ForecastStop> = {}): ForecastStop => ({
	visitId: "v1",
	dueAt: at(60),
	enRoute: false,
	scheduledStartAt: at(60),
	plannedMs: min(60),
	hasCoords: true,
	...over,
});

describe("arrivalDueAt", () => {
	const base = { arrival_time: null, arrival_window_end: null, scheduled_start_at: new Date("2026-10-01T18:00:00Z") };

	it("uses the promised time for 'at'", () => {
		const due = arrivalDueAt({ ...base, arrival_constraint: "at", arrival_time: "14:30" }, "America/Chicago");
		expect(due.toISOString()).toBe("2026-10-01T19:30:00.000Z");
	});

	it("uses the window end for 'between' and 'by'", () => {
		const due = arrivalDueAt({ ...base, arrival_constraint: "between", arrival_window_end: "15:00" }, "America/Chicago");
		expect(due.toISOString()).toBe("2026-10-01T20:00:00.000Z");
	});

	it("falls back to the scheduled start for 'anytime'", () => {
		expect(arrivalDueAt({ ...base, arrival_constraint: "anytime" }, "America/Chicago")).toEqual(base.scheduled_start_at);
	});
});

describe("classifyDelay", () => {
	it("splits on the grace and at-risk bands", () => {
		expect(classifyDelay(-min(30))).toBe("on_time");
		expect(classifyDelay(-min(10))).toBe("on_time");
		expect(classifyDelay(-min(9))).toBe("at_risk");
		expect(classifyDelay(min(5))).toBe("at_risk");
		expect(classifyDelay(min(6))).toBe("late");
	});
});

describe("forecastRoute", () => {
	it("projects a not-yet-departed tech as leaving now", () => {
		const [f] = forecastRoute({ now: NOW, availableAt: NOW, legs: [leg(30, 22)], stops: [stop()], enRouteMeasuredAt: null });
		expect(f.etaAt).toEqual(at(30));
		expect(f.leaveByAt).toEqual(at(30));
		expect(f.delaySeconds).toBe(-30 * 60);
		expect(f.status).toBe("on_time");
		expect(f.trafficDelaySeconds).toBe(8 * 60);
	});

	it("measures an en-route tech from when the route was taken", () => {
		const [f] = forecastRoute({
			now: NOW,
			availableAt: NOW,
			legs: [leg(40)],
			stops: [stop({ enRoute: true, dueAt: at(30) })],
			enRouteMeasuredAt: at(-2),
		});
		expect(f.etaAt).toEqual(at(38));
		expect(f.leaveByAt).toBeNull();
		expect(f.status).toBe("late");
	});

	it("chains later stops through the planned duration of earlier ones", () => {
		const out = forecastRoute({
			now: NOW,
			availableAt: at(30), // finishing the current job
			legs: [leg(20), leg(15)],
			stops: [
				stop({ visitId: "a", dueAt: at(60), scheduledStartAt: at(60), plannedMs: min(90) }),
				stop({ visitId: "b", dueAt: at(150) }),
			],
			enRouteMeasuredAt: null,
		});
		expect(out[0].etaAt).toEqual(at(50));
		// waits for the 3:00 start, works 90 min, drives 15
		expect(out[1].etaAt).toEqual(at(60 + 90 + 15));
		expect(out[1].status).toBe("late");
		expect(out[1].stopIndex).toBe(1);
	});

	it("reports an overdue stop with no route as late by elapsed time", () => {
		const out = forecastRoute({
			now: NOW,
			availableAt: NOW,
			legs: [null, null],
			stops: [stop({ visitId: "a", dueAt: at(-20) }), stop({ visitId: "b", dueAt: at(30) })],
			enRouteMeasuredAt: null,
		});
		expect(out[0]).toMatchObject({ status: "late", basis: "elapsed", delaySeconds: 20 * 60 });
		expect(out[1]).toMatchObject({ status: "unknown", basis: "no_location", etaAt: null });
	});
});

describe("decideAlert", () => {
	const f = (status: "on_time" | "at_risk" | "late", delayMin: number, stopIndex = 0) => ({
		status,
		delaySeconds: delayMin * 60,
		stopIndex,
	});

	it("alerts the first time a stop goes late", () => {
		expect(decideAlert(f("late", 8), null)).toBe("late");
	});

	it("escalates only after a further 15 minutes of slip", () => {
		expect(decideAlert(f("late", 20), 8)).toBeNull();
		expect(decideAlert(f("late", 23), 8)).toBe("worse");
	});

	it("gives the all-clear once projected on time, not at the grace edge", () => {
		expect(decideAlert(f("at_risk", 3), 8)).toBeNull();
		expect(decideAlert(f("at_risk", 0), 8)).toBe("recovered");
		expect(decideAlert(f("on_time", -12), null)).toBeNull();
	});

	it("holds downstream stops to a higher bar", () => {
		expect(decideAlert(f("late", 10, 1), null)).toBeNull();
		expect(decideAlert(f("late", 15, 1), null)).toBe("late");
	});
});
