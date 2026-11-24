/**
 * GET /job-visits/board: the real route + controller against the fake client.
 * The fake findMany applies the date bounds it is handed to an in-memory set,
 * so the tests pin the overlap semantics rather than one query shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) =>
		next(),
}));
vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/context.js")>()),
	getUserContext: vi.fn().mockReturnValue({}),
}));
vi.mock("../../controllers/jobsController.js", () => ({
	techOnJob: vi.fn(),
	techOnVisit: vi.fn(async () => true),
	techOnNote: vi.fn(),
}));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(),
	notifyVisitRescheduled: vi.fn(),
	notifyVisitCancelled: vi.fn(),
	retimeVisitReminders: vi.fn(),
	notifyJobCompleted: vi.fn(),
	notifyVisitCompleted: vi.fn(),
	notifyTechOnTheWay: vi.fn(),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn(),
}));
vi.mock("../../controllers/inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn(),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn(),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(),
	onVisitRescheduled: vi.fn(),
	onVisitCancelled: vi.fn(),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	createNotification: vi.fn().mockResolvedValue(undefined),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({}));
vi.mock("../../controllers/vehiclesController.js", () => ({}));
vi.mock("../../controllers/visitFieldLinesController.js", () => ({}));

import jobVisitsRouter from "../jobVisits.js";
import { db } from "../../db.js";
import { callRoute, leaves } from "./harness.js";

const dispatcher = {
	uid: "disp-1",
	role: "dispatcher",
	permissions: ["view_jobs"],
};
const tech = {
	uid: "tech-1",
	role: "technician",
	permissions: ["view_assigned_jobs"],
};

type Row = { id: string; scheduled_start_at: Date; scheduled_end_at: Date };

const ops: Record<string, (a: Date, b: Date) => boolean> = {
	lt: (a, b) => a < b,
	lte: (a, b) => a <= b,
	gt: (a, b) => a > b,
	gte: (a, b) => a >= b,
};

// Applies every scheduled_start_at / scheduled_end_at bound in the where (AND).
const inRange = (where: unknown) => (row: Row) =>
	leaves(where).every((leaf) => {
		const [field, cond] = Object.entries(leaf)[0];
		if (field !== "scheduled_start_at" && field !== "scheduled_end_at")
			return true;
		return Object.entries(cond as Record<string, Date>).every(
			([op, v]) => ops[op]?.(row[field], v) ?? true,
		);
	});

const visit = (id: string, start: string, end: string): Row => ({
	id,
	scheduled_start_at: new Date(start),
	scheduled_end_at: new Date(end),
});

const fakeDb = db as unknown as {
	job_visit: { findMany: ReturnType<typeof vi.fn> };
	job: { findMany: ReturnType<typeof vi.fn> };
	recurring_occurrence: { findMany: ReturnType<typeof vi.fn> };
};

type Occ = { id: string; occurrence_start_at: Date };
let occs: Occ[] = [];

let rows: Row[] = [];

beforeEach(() => {
	vi.clearAllMocks();
	rows = [];
	fakeDb.job_visit.findMany.mockImplementation(
		async (args: { where?: unknown }) => rows.filter(inRange(args.where)),
	);
	fakeDb.job.findMany.mockResolvedValue([]);
	occs = [];
	fakeDb.recurring_occurrence.findMany.mockImplementation(
		async (args: { where?: unknown }) =>
			occs.filter((o) =>
				leaves(args.where).every((leaf) => {
					const [field, cond] = Object.entries(leaf)[0];
					if (field !== "occurrence_start_at") return true;
					return Object.entries(cond as Record<string, Date>).every(
						([op, v]) => ops[op]?.(o.occurrence_start_at, v) ?? true,
					);
				}),
			),
	);
});

const board = (query: Record<string, string>, user: object = dispatcher) =>
	callRoute(jobVisitsRouter, "get", "/board", { user, query });

const lastVisitArgs = () => {
	const calls = fakeDb.job_visit.findMany.mock.calls;
	return calls[calls.length - 1][0];
};

describe("GET /job-visits/board", () => {
	it("returns a visit that spans the whole range", async () => {
		rows = [
			visit("long", "2026-11-01T08:00:00Z", "2026-11-20T17:00:00Z"),
			visit("before", "2026-11-01T08:00:00Z", "2026-11-02T17:00:00Z"),
		];

		const r = await board({
			from: "2026-11-10T00:00:00Z",
			to: "2026-11-12T00:00:00Z",
		});

		expect(r.status).toBe(200);
		expect(r.body.data.visits.map((v: Row) => v.id)).toEqual(["long"]);
		expect(r.body.meta.count).toBe(1);
	});

	it("excludes a visit that ends exactly at from", async () => {
		rows = [
			visit("ends-at-from", "2026-11-09T22:00:00Z", "2026-11-10T00:00:00Z"),
			visit("starts-at-to", "2026-11-12T00:00:00Z", "2026-11-12T02:00:00Z"),
			visit("inside", "2026-11-10T09:00:00Z", "2026-11-10T10:00:00Z"),
		];

		const r = await board({
			from: "2026-11-10T00:00:00Z",
			to: "2026-11-12T00:00:00Z",
		});

		expect(r.body.data.visits.map((v: Row) => v.id)).toEqual(["inside"]);
	});

	it("rejects a 90-day span with 400", async () => {
		const r = await board({
			from: "2026-11-01T00:00:00Z",
			to: "2027-01-30T00:00:00Z",
		});

		expect(r.status).toBe(400);
		expect(fakeDb.job_visit.findMany).not.toHaveBeenCalled();
	});

	it("select contains no line_items, notes or time_entries", async () => {
		await board({ from: "2026-11-10T00:00:00Z", to: "2026-11-12T00:00:00Z" });

		const args = lastVisitArgs();
		expect(args.include).toBeUndefined();
		expect(args.select).toBeDefined();
		for (const heavy of [
			"line_items",
			"notes",
			"time_entries",
			"tax_snapshot",
			"subtotal",
			"total",
		]) {
			expect(args.select).not.toHaveProperty(heavy);
		}
		expect(args.select.job.select).not.toHaveProperty("line_items");
		expect(args.select.job.select).not.toHaveProperty("notes");
	});

	it("date-range endpoint now uses the overlap predicate", async () => {
		rows = [
			visit("long", "2026-10-01T08:00:00Z", "2026-12-20T17:00:00Z"),
			visit("ends-at-start", "2026-10-31T22:00:00Z", "2026-11-01T00:00:00Z"),
		];

		const r = await callRoute(
			jobVisitsRouter,
			"get",
			"/date-range/:startDate/:endDate",
			{
				user: dispatcher,
				params: { startDate: "2026-11-01", endDate: "2026-11-30" },
			},
		);

		expect(r.body.data.map((v: Row) => v.id)).toEqual(["long"]);
		const where = lastVisitArgs().where;
		expect(leaves(where)).toEqual(
			expect.arrayContaining([
				{ scheduled_start_at: { lt: new Date("2026-11-30") } },
				{ scheduled_end_at: { gt: new Date("2026-11-01") } },
			]),
		);
	});

	it("limits an assigned-only caller to their own visits", async () => {
		await board(
			{ from: "2026-11-10T00:00:00Z", to: "2026-11-12T00:00:00Z" },
			tech,
		);

		expect(leaves(lastVisitArgs().where)).toEqual(
			expect.arrayContaining([
				{ visit_techs: { some: { tech_id: "tech-1" } } },
			]),
		);
	});

	it("filters by techId and returns the unscheduled rail on request", async () => {
		fakeDb.job.findMany.mockResolvedValue([
			{ id: "j1", job_number: "J-1", name: "Rail", client: { id: "c1", name: "C" } },
		]);

		const r = await board({
			from: "2026-11-10T00:00:00Z",
			to: "2026-11-12T00:00:00Z",
			techId: "8a6f3c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b",
			includeUnscheduled: "1",
		});

		expect(leaves(lastVisitArgs().where)).toEqual(
			expect.arrayContaining([
				{
					visit_techs: {
						some: { tech_id: "8a6f3c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b" },
					},
				},
			]),
		);
		expect(r.body.data.unscheduledJobs).toHaveLength(1);
		const jobArgs = fakeDb.job.findMany.mock.calls[0][0];
		expect(jobArgs.take).toBe(200);
		expect(leaves(jobArgs.where)).toEqual(
			expect.arrayContaining([
				{ status: "Unscheduled" },
				{ visits: { none: {} } },
			]),
		);
	});

	it("includeUnscheduled is empty for a view_visits-only caller", async () => {
		fakeDb.job.findMany.mockResolvedValue([
			{ id: "j1", job_number: "J-1", name: "Rail", client: { id: "c1", name: "C" } },
		]);

		const r = await board(
			{
				from: "2026-11-10T00:00:00Z",
				to: "2026-11-12T00:00:00Z",
				includeUnscheduled: "1",
			},
			{ uid: "u1", role: "dispatcher", permissions: ["view_visits"] },
		);

		expect(r.status).toBe(200);
		expect(r.body.data.unscheduledJobs).toEqual([]);
		expect(fakeDb.job.findMany).not.toHaveBeenCalled();
	});

	it("an assigned-only caller with another techId and includeUnscheduled gets only their own visits and an empty rail", async () => {
		const other = "8a6f3c1e-2b4d-4e5f-9a7b-1c2d3e4f5a6b";
		fakeDb.job.findMany.mockResolvedValue([
			{ id: "j1", job_number: "J-1", name: "Rail", client: { id: "c1", name: "C" } },
		]);

		const r = await board(
			{
				from: "2026-11-10T00:00:00Z",
				to: "2026-11-12T00:00:00Z",
				techId: other,
				includeUnscheduled: "1",
			},
			tech,
		);

		expect(r.status).toBe(200);
		// Both filters are ANDed, so the other tech's id can only narrow the
		// caller's own visits, never widen past them.
		const where = lastVisitArgs().where;
		expect(leaves(where)).toEqual(
			expect.arrayContaining([
				{ visit_techs: { some: { tech_id: "tech-1" } } },
				{ visit_techs: { some: { tech_id: other } } },
			]),
		);
		expect(JSON.stringify(where)).not.toContain('"OR"');
		expect(r.body.data.unscheduledJobs).toEqual([]);
		expect(fakeDb.job.findMany).not.toHaveBeenCalled();
	});

	it("omits the unscheduled rail unless asked", async () => {
		const r = await board({
			from: "2026-11-10T00:00:00Z",
			to: "2026-11-12T00:00:00Z",
		});

		expect(r.body.data).not.toHaveProperty("unscheduledJobs");
		expect(fakeDb.job.findMany).not.toHaveBeenCalled();
	});

	it("returns planned occurrences inside the range only", async () => {
		occs = [
			{ id: "in", occurrence_start_at: new Date("2026-11-11T15:00:00Z") },
			{ id: "at-to", occurrence_start_at: new Date("2026-11-12T00:00:00Z") },
			{ id: "before", occurrence_start_at: new Date("2026-11-09T15:00:00Z") },
		];

		const r = await board({
			from: "2026-11-10T00:00:00Z",
			to: "2026-11-12T00:00:00Z",
		});

		expect(r.body.data.occurrences.map((o: Occ) => o.id)).toEqual(["in"]);
		const args = fakeDb.recurring_occurrence.findMany.mock.calls[0][0];
		expect(leaves(args.where)).toEqual(
			expect.arrayContaining([
				{ status: "planned" },
				{ job_visit_id: null },
			]),
		);
		expect(args.select.recurring_plan.select).not.toHaveProperty("line_items");
		expect(args.select.recurring_plan.select).not.toHaveProperty("rules");
	});

	it("occurrences are empty without view_jobs", async () => {
		occs = [{ id: "in", occurrence_start_at: new Date("2026-11-11T15:00:00Z") }];

		for (const user of [
			tech,
			{ uid: "u1", role: "dispatcher", permissions: ["view_visits"] },
		]) {
			const r = await board(
				{ from: "2026-11-10T00:00:00Z", to: "2026-11-12T00:00:00Z" },
				user,
			);
			expect(r.body.data.occurrences).toEqual([]);
		}
		expect(fakeDb.recurring_occurrence.findMany).not.toHaveBeenCalled();
	});
});
