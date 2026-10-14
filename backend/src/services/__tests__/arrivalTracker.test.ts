import { describe, it, expect, vi, beforeEach } from "vitest";
import { runArrivalTick } from "../arrivalTracker.js";

// ── Mocks ────────────────────────────────────────────────────────────────────
const { dbMock, createNotification, notifyDispatchers, fetchTrafficLegs, emitToOrg } = vi.hoisted(() => ({
	dbMock: {
		job_visit_technician: { findMany: vi.fn(), findUnique: vi.fn() },
		visit_tech_arrival: { findMany: vi.fn(), upsert: vi.fn(), update: vi.fn(), delete: vi.fn() },
		visit_tech_drive: { findFirst: vi.fn() },
		visit_tech_time_entry: { findFirst: vi.fn() },
	},
	createNotification: vi.fn(),
	notifyDispatchers: vi.fn(),
	fetchTrafficLegs: vi.fn(),
	emitToOrg: vi.fn(),
}));

vi.mock("../../db.js", () => ({ db: dbMock }));
vi.mock("../../controllers/notificationsController.js", () => ({ createNotification, notifyDispatchers }));
vi.mock("../../lib/mapboxDirections.js", async (orig) => ({
	...(await orig<typeof import("../../lib/mapboxDirections.js")>()),
	fetchTrafficLegs,
}));
vi.mock("../socketService.js", () => ({ emitToOrg }));
vi.mock("../appLogger.js", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const NOW = new Date("2026-10-01T19:00:00Z"); // 2:00 PM CDT
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

function candidate(over: { tech_status?: string; visit?: Record<string, unknown>; tech?: Record<string, unknown> } = {}) {
	return {
		tech_id: "t1",
		tech_status: over.tech_status ?? "Assigned",
		tech: { name: "John Smith", coords: { lat: 43.8, lon: -91.2 }, last_ping_at: at(-1), ...over.tech },
		visit: {
			id: "v1",
			status: "Scheduled",
			arrival_constraint: "at",
			arrival_time: "14:30",
			arrival_window_end: null,
			scheduled_start_at: new Date("2026-10-01T19:30:00Z"),
			scheduled_end_at: new Date("2026-10-01T20:30:00Z"),
			job: {
				id: "j1",
				job_number: "J-0001",
				coords: { lat: 43.07, lon: -89.4 },
				organization_id: "org1",
				organization: { timezone: "America/Chicago" },
				client: { name: "Johnson Residence" },
			},
			...over.visit,
		},
	};
}

function row(over: Record<string, unknown> = {}) {
	return {
		id: "r1",
		organization_id: "org1",
		visit_id: "v1",
		tech_id: "t1",
		status: "on_time",
		basis: "traffic",
		en_route: false,
		stop_index: 0,
		due_at: at(30),
		drive_seconds: 20 * 60,
		traffic_delay_seconds: 0,
		distance_meters: 20_000,
		routed_at: at(-1),
		alerted_late_minutes: null,
		...over,
	};
}

const legs = (minutes: number, typical = minutes) => [
	{ durationSeconds: minutes * 60, typicalSeconds: typical * 60, distanceMeters: 30_000 },
];
const upserted = () => dbMock.visit_tech_arrival.upsert.mock.calls.map((c) => c[0].update);

beforeEach(() => {
	vi.clearAllMocks();
	dbMock.visit_tech_arrival.findMany.mockResolvedValue([]);
	notifyDispatchers.mockResolvedValue([]);
	createNotification.mockResolvedValue({});
});

describe("arrival tracker", () => {
	it("routes a new stop with live traffic and stores the forecast", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate()]);
		fetchTrafficLegs.mockResolvedValue(legs(20, 14));

		await runArrivalTick(NOW);

		expect(fetchTrafficLegs).toHaveBeenCalledWith([
			{ lat: 43.8, lon: -91.2 },
			{ lat: 43.07, lon: -89.4 },
		]);
		expect(upserted()[0]).toMatchObject({
			status: "on_time",
			basis: "traffic",
			eta_at: at(20),
			leave_by_at: at(10),
			delay_seconds: -10 * 60,
			traffic_delay_seconds: 6 * 60,
			routed_at: NOW,
		});
		expect(notifyDispatchers).not.toHaveBeenCalled();
		expect(emitToOrg).toHaveBeenCalledWith("org1", "arrivals:updated", { organizationId: "org1" });
	});

	it("rolls cached legs forward inside the refresh cadence instead of calling Mapbox", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate()]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([row({ routed_at: at(-2) })]);

		await runArrivalTick(NOW);

		expect(fetchTrafficLegs).not.toHaveBeenCalled();
		expect(upserted()[0]).toMatchObject({ eta_at: at(20), routed_at: at(-2) });
	});

	it("re-routes once the tech starts driving", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate({ tech_status: "EnRoute" })]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([row({ routed_at: at(-1) })]);
		fetchTrafficLegs.mockResolvedValue(legs(25));

		await runArrivalTick(NOW);

		expect(fetchTrafficLegs).toHaveBeenCalledTimes(1);
		expect(upserted()[0]).toMatchObject({ en_route: true, eta_at: at(25), leave_by_at: null });
	});

	it("alerts dispatch and the tech when a stop goes late, and records the alert", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate({ tech_status: "EnRoute" })]);
		fetchTrafficLegs.mockResolvedValue(legs(45, 33));

		await runArrivalTick(NOW);

		expect(upserted()[0]).toMatchObject({ status: "late", alerted_late_minutes: 15, alerted_at: NOW });
		expect(notifyDispatchers).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "tech_running_late",
				title: "John Smith running late — Johnson Residence",
				body: expect.stringMatching(
					/^Job J-0001\. ETA 2:45\sPM, due by 2:30\sPM \(~15 min late\)\. Traffic is adding ~12 min\.$/,
				),
				actionUrl: "/dispatch/jobs/j1/visits/v1",
			}),
			"org1",
		);
		expect(createNotification).toHaveBeenCalledWith(
			expect.objectContaining({ technicianId: "t1", title: "You may be late to Johnson Residence" }),
			"org1",
		);
	});

	it("doesn't repeat an alert until the delay grows another 15 minutes", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate({ tech_status: "EnRoute" })]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([
			row({ en_route: true, routed_at: at(-5), status: "late", alerted_late_minutes: 15 }),
		]);

		fetchTrafficLegs.mockResolvedValue(legs(50));
		await runArrivalTick(NOW);
		expect(notifyDispatchers).not.toHaveBeenCalled();

		fetchTrafficLegs.mockResolvedValue(legs(61));
		await runArrivalTick(NOW);
		expect(notifyDispatchers.mock.calls[0][0].title).toBe("John Smith now ~31 min late — Johnson Residence");
		// the tech only hears the first time
		expect(createNotification).not.toHaveBeenCalled();
	});

	it("sends the all-clear when a late tech is back on time", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([candidate({ tech_status: "EnRoute" })]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([
			row({ en_route: true, routed_at: at(-5), status: "late", alerted_late_minutes: 10 }),
		]);
		fetchTrafficLegs.mockResolvedValue(legs(25));

		await runArrivalTick(NOW);

		expect(notifyDispatchers.mock.calls[0][0].title).toBe("John Smith back on track — Johnson Residence");
		expect(upserted()[0]).toMatchObject({ alerted_late_minutes: null });
	});

	it("reports an overdue tech with no recent GPS as late without calling Mapbox", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([
			candidate({ tech: { last_ping_at: at(-90) }, visit: { arrival_time: "13:40" } }),
		]);

		await runArrivalTick(NOW);

		expect(fetchTrafficLegs).not.toHaveBeenCalled();
		expect(upserted()[0]).toMatchObject({ status: "late", basis: "elapsed", delay_seconds: 20 * 60 });
		expect(notifyDispatchers.mock.calls[0][0].body).toMatch(/hasn't arrived \(~20 min late\)/);
	});

	it("routes from the current job, after it's scheduled to finish", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([
			candidate({
				tech_status: "OnSite",
				visit: {
					id: "v0",
					status: "InProgress",
					scheduled_end_at: at(15),
					job: { ...candidate().visit.job, id: "j0", coords: { lat: 43.5, lon: -90 } },
				},
			}),
			candidate(),
		]);
		fetchTrafficLegs.mockResolvedValue(legs(20));

		await runArrivalTick(NOW);

		expect(fetchTrafficLegs.mock.calls[0][0][0]).toEqual({ lat: 43.5, lon: -90 });
		expect(upserted()).toHaveLength(1);
		expect(upserted()[0]).toMatchObject({ eta_at: at(35), status: "at_risk" });
	});

	it("keeps a forgotten overdue visit out of the route so later stops aren't pushed back", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([
			candidate({
				visit: {
					id: "v-old",
					arrival_time: "13:00",
					scheduled_start_at: new Date("2026-10-01T18:00:00Z"),
					scheduled_end_at: new Date("2026-10-01T20:00:00Z"),
				},
			}),
			candidate(),
		]);
		fetchTrafficLegs.mockResolvedValue(legs(20));

		await runArrivalTick(NOW);

		// routed straight from the truck to the upcoming visit
		expect(fetchTrafficLegs.mock.calls[0][0]).toHaveLength(2);
		const byVisit = Object.fromEntries(
			dbMock.visit_tech_arrival.upsert.mock.calls.map((c) => [c[0].create.visit_id, c[0].update]),
		);
		expect(byVisit["v1"]).toMatchObject({ status: "on_time", eta_at: at(20), stop_index: 0 });
		expect(byVisit["v-old"]).toMatchObject({ status: "late", basis: "elapsed", delay_seconds: 60 * 60 });
	});

	it("settles a row as arrived when the drive ends", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([row({ status: "late", alerted_late_minutes: 12 })]);
		dbMock.job_visit_technician.findUnique.mockResolvedValue({ tech_status: "OnSite", visit: { status: "OnSite" } });
		dbMock.visit_tech_drive.findFirst.mockResolvedValue({ ended_at: at(42) });
		dbMock.visit_tech_time_entry.findFirst.mockResolvedValue(null);

		await runArrivalTick(NOW);

		expect(dbMock.visit_tech_arrival.update).toHaveBeenCalledWith({
			where: { id: "r1" },
			data: expect.objectContaining({
				status: "arrived",
				basis: "actual",
				arrived_at: at(42),
				delay_seconds: 12 * 60,
				alerted_late_minutes: null,
			}),
		});
	});

	it("drops the row when the tech is taken off the visit", async () => {
		dbMock.job_visit_technician.findMany.mockResolvedValue([]);
		dbMock.visit_tech_arrival.findMany.mockResolvedValue([row()]);
		dbMock.job_visit_technician.findUnique.mockResolvedValue(null);

		await runArrivalTick(NOW);

		expect(dbMock.visit_tech_arrival.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
	});
});
