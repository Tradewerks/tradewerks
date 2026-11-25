/** GET /jobs: paged list (real route + controller against the fake client). */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../services/emailService.js", () => ({}));
vi.mock("../../services/lowStockAlerts.js", () => ({ fireLowStockAlerts: vi.fn() }));
vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/context.js")>()),
	getUserContext: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));

import jobsRouter from "../jobs.js";
import { db } from "../../db.js";
import { callRoute, type FakeDb } from "./harness.js";

const fake = db as unknown as FakeDb;
const dispatcher = { uid: "d1", role: "dispatcher", permissions: ["view_jobs"] };
const tech = { uid: "t1", role: "technician", permissions: ["view_assigned_jobs"] };

const row = (n: number) => ({
	id: `j${n}`,
	job_number: `J-${n}`,
	name: `Job ${n}`,
	status: "Scheduled",
	priority: "Medium",
	created_at: new Date("2026-06-01"),
	client: { id: "c1", name: "Acme" },
	project: null,
	_count: { visits: 1 },
	visits: [],
});

// The scoped client wraps the caller's where as AND [where, { organization_id }].
const userWhere = (args: { where: { AND: unknown[] } }) => args.where.AND[0] as any;

const call = (query: Record<string, unknown>, user = dispatcher) =>
	callRoute(jobsRouter, "get", "/", { user, query });

beforeEach(() => {
	fake.job.findMany.mockReset().mockResolvedValue([row(1), row(2)]);
	fake.job.count.mockReset().mockResolvedValue(120);
});

describe("GET /jobs paged", () => {
	it("paged list returns limit rows and meta.count = total", async () => {
		const r = await call({ page: "2", limit: "2" });
		expect(r.status).toBe(200);
		expect(r.body.data).toHaveLength(2);
		expect(r.body.meta).toMatchObject({ count: 120, page: 2, limit: 2 });
		const args = fake.job.findMany.mock.calls[0][0];
		expect(args.skip).toBe(2);
		expect(args.take).toBe(2);
		expect(args.orderBy).toEqual([{ status: "asc" }, { created_at: "desc" }, { id: "asc" }]);
	});

	it("q filters on job number, name, client name and address, ANDing each word", async () => {
		await call({ page: "1", q: "acme main" });
		const args = fake.job.findMany.mock.calls[0][0];
		const text = JSON.stringify(userWhere(args));
		for (const term of ["acme", "main"]) {
			expect(text).toContain(`"job_number":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"name":{"contains":"${term}","mode":"insensitive"}`);
			expect(text).toContain(`"client":{"name":{"contains":"${term}","mode":"insensitive"}}`);
			expect(text).toContain(`"address":{"contains":"${term}","mode":"insensitive"}`);
		}
		expect(userWhere(args).AND.filter((c: any) => c.OR).length).toBe(2);
		expect(fake.job.count.mock.calls[0][0].where).toEqual(args.where);
	});

	it("status filter accepts multiple values", async () => {
		await call({ page: "1", status: "Scheduled,InProgress" });
		const args = fake.job.findMany.mock.calls[0][0];
		expect(JSON.stringify(userWhere(args))).toContain('"status":{"in":["Scheduled","InProgress"]}');
		const bad = await call({ page: "1", status: "Nope" });
		expect(bad.status).toBe(400);
		expect(bad.body.error.field).toBe("status");
	});

	it("legacy call returns the old array and a Deprecation header", async () => {
		const r = await call({ sort: "nope", limit: "500" });
		expect(r.status).toBe(200);
		expect(Array.isArray(r.body.data)).toBe(true);
		expect(r.res.setHeader).toHaveBeenCalledWith("Deprecation", "true");
		const args = fake.job.findMany.mock.calls[0][0];
		expect(args.take).toBeUndefined();
		expect(args.include).toBeDefined();
	});

	it("slim select omits visit techs, visit line items, plan rules and line items", async () => {
		await call({ page: "1" });
		const args = fake.job.findMany.mock.calls[0][0];
		expect(args.include).toBeUndefined();
		expect(Object.keys(args.select).sort()).toEqual(
			[
				"_count",
				"actual_total",
				"address",
				"client",
				"client_id",
				"completed_at",
				"created_at",
				"estimated_total",
				"id",
				"job_number",
				"name",
				"priority",
				"project",
				"recurring_plan_id",
				"status",
				"visits",
			].sort(),
		);
		expect(args.select.line_items).toBeUndefined();
		expect(args.select.recurring_plan).toBeUndefined();
		expect(args.select._count).toEqual({ select: { visits: true } });
		expect(args.select.visits.take).toBe(1);
		expect(args.select.visits.orderBy).toEqual({ scheduled_start_at: "asc" });
		expect(Object.keys(args.select.visits.select).sort()).toEqual(
			["id", "scheduled_start_at", "status"].sort(),
		);
	});

	it("an explicit sort replaces the default; client and total map to their columns", async () => {
		await call({ page: "1", sort: "client", dir: "asc" });
		expect(fake.job.findMany.mock.calls[0][0].orderBy).toEqual([
			{ client: { name: "asc" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "total" });
		expect(fake.job.findMany.mock.calls[1][0].orderBy).toEqual([
			{ estimated_total: { sort: "desc", nulls: "last" } },
			{ id: "asc" },
		]);
		await call({ page: "1", sort: "job_number", dir: "asc" });
		expect(fake.job.findMany.mock.calls[2][0].orderBy).toEqual([
			{ job_number: "asc" },
			{ id: "asc" },
		]);
		expect((await call({ page: "1", sort: "next_visit_at" })).status).toBe(400);
	});

	it("priority, client_id, unattached and view=templates narrow the list", async () => {
		await call({
			page: "1",
			priority: "High,Urgent",
			client_id: "c9",
			unattached: "true",
			view: "templates",
		});
		const where = userWhere(fake.job.findMany.mock.calls[0][0]);
		expect(where.priority).toEqual({ in: ["High", "Urgent"] });
		expect(where.client_id).toBe("c9");
		expect(where.project_id).toBeNull();
		expect(where.recurring_plan_id).toEqual({ not: null });
		expect((await call({ page: "1", priority: "Huge" })).status).toBe(400);
	});

	it("from and to keep jobs with a visit overlapping the range", async () => {
		await call({ page: "1", from: "2026-06-01", to: "2026-07-01T00:00:00.000Z" });
		const s = JSON.stringify(userWhere(fake.job.findMany.mock.calls[0][0]));
		expect(s).toContain('"scheduled_start_at":{"lt":"2026-07-01T00:00:00.000Z"}');
		expect(s).toContain('"scheduled_end_at":{"gt":"2026-06-01T00:00:00.000Z"}');
	});

	it("the date overlap ignores cancelled visits and, for an assigned-only caller, other techs' visits", async () => {
		await call({ page: "1", from: "2026-06-01" });
		const some = (args: any) =>
			userWhere(args).AND.find((c: any) => c.visits?.some?.scheduled_end_at).visits.some;
		const open = some(fake.job.findMany.mock.calls[0][0]);
		expect(open.status).toEqual({ not: "Cancelled" });
		expect(open.visit_techs).toBeUndefined();

		await call({ page: "1", from: "2026-06-01" }, tech);
		expect(some(fake.job.findMany.mock.calls[1][0]).visit_techs).toEqual({
			some: { tech_id: "t1" },
		});
	});

	it("legacy call with client_id narrows to that client and keeps the tech scope", async () => {
		await call({ client_id: "c9" }, tech);
		const args = fake.job.findMany.mock.calls[0][0];
		const text = JSON.stringify(args.where);
		expect(text).toContain('"client_id":"c9"');
		expect(text).toContain('"tech_id":"t1"');
	});

	it("an assigned-only caller keeps the assigned scope on the page and its visit subselect", async () => {
		await call({ page: "1", q: "x" }, tech);
		const args = fake.job.findMany.mock.calls[0][0];
		const scope = { visits: { some: { visit_techs: { some: { tech_id: "t1" } } } } };
		expect(userWhere(args).AND).toContainEqual(scope);
		expect(userWhere(fake.job.count.mock.calls[0][0]).AND).toContainEqual(scope);
		expect(args.select.visits.where.visit_techs).toEqual({ some: { tech_id: "t1" } });
		expect(args.select._count).toEqual({
			select: { visits: { where: { visit_techs: { some: { tech_id: "t1" } } } } },
		});

		await call({ page: "1" });
		const open = fake.job.findMany.mock.calls[1][0];
		expect(userWhere(open).AND).not.toContainEqual(scope);
		expect(open.select.visits.where.visit_techs).toBeUndefined();
		expect(open.select._count).toEqual({ select: { visits: true } });
	});
});
