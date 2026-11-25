/**
 * GET /job-visits (paged): real route + controller against the fake client.
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

const fakeDb = db as unknown as {
	job_visit: {
		findMany: ReturnType<typeof vi.fn>;
		count: ReturnType<typeof vi.fn>;
	};
};

const list = (query: Record<string, string>, user: object = dispatcher) =>
	callRoute(jobVisitsRouter, "get", "/", { user, query });

const findArgs = () => fakeDb.job_visit.findMany.mock.calls[0][0];

beforeEach(() => {
	vi.clearAllMocks();
	fakeDb.job_visit.findMany.mockResolvedValue([]);
	fakeDb.job_visit.count.mockResolvedValue(0);
});

describe("GET /job-visits paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const rows = [{ id: "v1" }, { id: "v2" }];
		fakeDb.job_visit.findMany.mockResolvedValue(rows);
		fakeDb.job_visit.count.mockResolvedValue(57);

		const r = await list({ page: "2", limit: "2" });

		expect(r.status).toBe(200);
		expect(r.body.data).toEqual(rows);
		expect(r.body.meta).toMatchObject({ count: 57, page: 2, limit: 2 });
		expect(findArgs()).toMatchObject({ skip: 2, take: 2 });
	});

	it("q filters on name, job number and client name", async () => {
		await list({ page: "1", q: "furnace" });

		const where = JSON.stringify(findArgs().where);
		for (const clause of [
			{ name: { contains: "furnace", mode: "insensitive" } },
			{ job: { job_number: { contains: "furnace", mode: "insensitive" } } },
			{
				job: {
					client: { name: { contains: "furnace", mode: "insensitive" } },
				},
			},
		])
			expect(where).toContain(JSON.stringify(clause));
		expect(fakeDb.job_visit.count.mock.calls[0][0].where).toEqual(
			findArgs().where,
		);
	});

	it("status filter accepts multiple values", async () => {
		const r = await list({ page: "1", status: "Scheduled,InProgress" });

		expect(r.status).toBe(200);
		expect(JSON.stringify(findArgs().where)).toContain(
			JSON.stringify({ in: ["Scheduled", "InProgress"] }),
		);
		const bad = await list({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		fakeDb.job_visit.findMany.mockResolvedValue([{ id: "v1" }]);

		const r = await list({});

		expect(r.status).toBe(200);
		expect(r.body.data).toEqual([{ id: "v1" }]);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		expect(findArgs().include).toBeDefined();
	});

	it("legacy call with stray sort and limit still returns the array", async () => {
		fakeDb.job_visit.findMany.mockResolvedValue([{ id: "v1" }]);

		const r = await list({ clientId: "c-1", limit: "500", sort: "desc" });

		expect(r.status).toBe(200);
		expect(r.body.data).toEqual([{ id: "v1" }]);
	});

	it("slim select omits line items, time entries and notes", async () => {
		await list({ page: "1" });

		const args = findArgs();
		expect(args.include).toBeUndefined();
		expect(args.select.id).toBe(true);
		expect(args.select.line_items).toBeUndefined();
		expect(args.select.time_entries).toBeUndefined();
		expect(args.select.notes).toBeUndefined();
		expect(args.select._count).toBeDefined();
	});

	it("from/to use the overlap predicate with an exclusive to", async () => {
		await list({ page: "1", from: "2026-11-10", to: "2026-11-12" });

		const where = JSON.stringify(findArgs().where);
		expect(where).toContain(
			JSON.stringify({ scheduled_start_at: { lt: "2026-11-13T00:00:00.000Z" } }),
		);
		expect(where).toContain(
			JSON.stringify({ scheduled_end_at: { gt: "2026-11-10T00:00:00.000Z" } }),
		);
	});

	it("keeps the clientId filter and the assigned-only scope", async () => {
		await list({ page: "1", clientId: "c-1" }, tech);

		const where = JSON.stringify(findArgs().where);
		expect(where).toContain(JSON.stringify({ job: { client_id: "c-1" } }));
		expect(where).toContain(
			JSON.stringify({ visit_techs: { some: { tech_id: "tech-1" } } }),
		);
	});

	it("sorts by an allowed column with an id tiebreak and refuses others", async () => {
		await list({ page: "1", sort: "status", dir: "desc" });

		expect(findArgs().orderBy).toEqual([{ status: "desc" }, { id: "asc" }]);
		const bad = await list({ page: "1", sort: "notes" });
		expect(bad.status).toBe(400);
	});

	it("multi-word q needs every word to match somewhere", async () => {
		await list({ page: "1", q: "furnace acme" });

		const outer = findArgs().where.AND.find((c: { AND?: unknown[] }) => c.AND?.length === 6).AND;
		const and = outer.find((c: { AND?: unknown[] }) => c.AND?.length === 2).AND;
		expect(and).toHaveLength(2);
		expect(JSON.stringify(and[1])).toContain("acme");
		expect(and[1].OR).toHaveLength(3);
	});

	it("accepts client_id as the client filter", async () => {
		await list({ page: "1", client_id: "c-2" });

		expect(JSON.stringify(findArgs().where)).toContain(
			JSON.stringify({ job: { client_id: "c-2" } }),
		);
	});

	it("legacy call with a repeated clientId takes the first value, not a 400", async () => {
		fakeDb.job_visit.findMany.mockResolvedValue([{ id: "v1" }]);

		const r = await list({ clientId: ["a", "b"] } as unknown as Record<string, string>);

		expect(r.status).toBe(200);
		expect(r.body.data).toEqual([{ id: "v1" }]);
		expect(JSON.stringify(findArgs().where)).toContain("\"client_id\":\"a\"");
	});

	it("a paged call with a repeated client filter is a 400", async () => {
		const r = await list({ page: "1", client_id: ["a", "b"] } as unknown as Record<string, string>);

		expect(r.status).toBe(400);
	});
});
