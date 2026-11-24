/**
 * view_assigned_jobs: the real routes + controllers against the fake client, so
 * the tests pin the predicate that reaches Prisma rather than a mocked call.
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
vi.mock("../../lib/entitlements/ownership.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../lib/entitlements/ownership.js")>()),
	namesWithModuleOn: vi.fn(async (_org: string, names: string[]) => names),
}));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn().mockReturnValue(null),
	emitToOrg: vi.fn(),
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	createNotification: vi.fn().mockResolvedValue(undefined),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../services/emailService.js", () => ({}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn(),
}));
vi.mock("../../controllers/inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn(),
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
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(),
	onVisitRescheduled: vi.fn(),
	onVisitCancelled: vi.fn(),
}));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({}));
vi.mock("../../controllers/vehiclesController.js", () => ({}));
vi.mock("../../controllers/visitFieldLinesController.js", () => ({}));
vi.mock("../../controllers/invoicesController.js", () => ({}));
vi.mock("../../controllers/recurringPlansController.js", () => ({}));
vi.mock("../../controllers/recurringPlanNotesController.js", () => ({}));
vi.mock("../../lib/upload.js", () => ({
	imageUpload: {
		single: () => (_req: unknown, _res: unknown, next: () => void) =>
			next(),
	},
}));
vi.mock("../../services/wasabiService.js", () => ({
	uploadFile: vi.fn(),
	signImageUrl: vi.fn(),
	isOwnBucketUrl: vi.fn(() => true),
	deleteFiles: vi.fn(),
}));

import jobsRouter from "../jobs.js";
import jobVisitsRouter from "../jobVisits.js";
import searchRouter from "../search.js";
import { db } from "../../db.js";
import { callRoute, clausesWith, leaves } from "./harness.js";

const fakeDb = db as unknown as Record<
	string,
	Record<string, ReturnType<typeof vi.fn>>
>;

// The default Technician role: view_visits reaches the Visits tab, it does not
// widen which visits.
const tech = {
	uid: "tech-1",
	role: "technician",
	permissions: ["view_assigned_jobs", "view_visits", "update_visit_status"],
};
const dispatcher = {
	uid: "disp-1",
	role: "dispatcher",
	permissions: ["view_jobs"],
};

const onTech = (uid: string) => ({ visit_techs: { some: { tech_id: uid } } });
const techPredicates = (where: unknown) =>
	clausesWith(where, ["visit_techs"]).map((c) => c.visit_techs);
// The flattened where (getScopedDb ANDs the org filter in), as one object.
const flat = (where: unknown) => Object.assign({}, ...leaves(where)) as Record<string, unknown>;
const mentions = (value: unknown, needle: string) =>
	JSON.stringify(value ?? null).includes(needle);

beforeEach(() => {
	vi.clearAllMocks();
	for (const model of Object.values(fakeDb)) {
		if (model && typeof model === "object") {
			for (const fn of Object.values(model)) {
				if (typeof fn?.mockReset === "function") fn.mockReset();
			}
		}
	}
	fakeDb.job.findMany.mockResolvedValue([]);
	fakeDb.job_visit.findMany.mockResolvedValue([]);
});

describe("view_assigned_jobs scopes reads to the caller", () => {
	it("GET /jobs for an assigned-only caller adds the visit_techs predicate", async () => {
		const r = await callRoute(jobsRouter, "get", "/", { user: tech });

		expect(r.status).toBe(200);
		const args = fakeDb.job.findMany.mock.calls[0][0];
		expect(clausesWith(args.where, ["visits"])).toContainEqual({
			visits: { some: onTech("tech-1") },
		});
		// Other techs' visits on a shared job carry their line items.
		expect(args.include.visits.where).toEqual(onTech("tech-1"));
	});

	it("GET /jobs/:id for an unassigned job returns 404 to an assigned-only caller", async () => {
		fakeDb.job.findFirst.mockResolvedValue(null);

		const r = await callRoute(jobsRouter, "get", "/:id", {
			user: tech,
			params: { id: "j1" },
		});

		expect(r.status).toBe(404);
		expect(r.body.error.code).toBe("NOT_FOUND");
		expect(r.body.error.message).toBe("Job not found");
	});

	it("GET /jobs/:id for an assigned job returns only the caller's visits", async () => {
		fakeDb.job.findFirst.mockResolvedValue({ id: "j1" });

		const r = await callRoute(jobsRouter, "get", "/:id", {
			user: tech,
			params: { id: "j1" },
		});

		expect(r.status).toBe(200);
		const detail = fakeDb.job.findFirst.mock.calls.find(
			([a]) => a?.include,
		)![0];
		expect(detail.include.visits.where).toEqual(onTech("tech-1"));
		expect(mentions(detail.include.notes.where, "tech-1")).toBe(true);
	});

	it("GET /job-visits/:id for an unassigned visit returns 404 to an assigned-only caller", async () => {
		fakeDb.job_visit.findFirst.mockResolvedValue(null);

		const r = await callRoute(jobVisitsRouter, "get", "/:id", {
			user: tech,
			params: { id: "v1" },
		});

		expect(r.status).toBe(404);
		expect(r.body.error.code).toBe("NOT_FOUND");
		const args = fakeDb.job_visit.findFirst.mock.calls[0][0];
		expect(techPredicates(args.where)).toContainEqual({
			some: { tech_id: "tech-1" },
		});
	});

	it("claimable visit detail has no pricing for an assigned-only caller", async () => {
		const pool = { id: "v1", status: "Scheduled", visit_techs: [] };
		// Not the caller's: the full read misses, the pool read finds it.
		fakeDb.job_visit.findFirst.mockImplementation(async (args) =>
			flat(args.where).status === "Scheduled" ? pool : null,
		);

		const r = await callRoute(jobVisitsRouter, "get", "/:id", {
			user: tech,
			params: { id: "v1" },
		});

		expect(r.status).toBe(200);
		const [full, claim] = fakeDb.job_visit.findFirst.mock.calls.map(([a]) => a);
		expect(techPredicates(full.where)).toContainEqual({ some: { tech_id: "tech-1" } });
		expect(claim.include).toBeUndefined();
		for (const key of ["line_items", "notes", "time_entries", "invoice_visits"]) {
			expect(claim.select).not.toHaveProperty(key);
		}
		expect(claim.select.job.select).not.toHaveProperty("quote");
	});

	it("an in-progress visit with no techs is not claimable", async () => {
		const rows = [{ id: "v1", status: "InProgress", visit_techs: [] }];
		const statusMatches = (cond: unknown, status: string) =>
			cond === undefined ||
			cond === status ||
			(typeof cond === "object" &&
				!!(cond as { notIn?: string[] }).notIn &&
				!(cond as { notIn: string[] }).notIn.includes(status));
		const matches = (raw: unknown) => {
			const where = flat(raw);
			return (
				rows.find(
				(row) =>
					row.id === (where.id ?? row.id) &&
					statusMatches(where.status, row.status) &&
					!("some" in ((where.visit_techs as object) ?? {})),
				) ?? null
			);
		};
		fakeDb.job_visit.findFirst.mockImplementation(async (args) => matches(args.where));

		const r = await callRoute(jobVisitsRouter, "get", "/:id", {
			user: tech,
			params: { id: "v1" },
		});
		expect(r.status).toBe(404);

		await callRoute(jobVisitsRouter, "get", "/assigned", { user: tech });
		const pool = fakeDb.job_visit.findMany.mock.calls
			.map(([a]) => a)
			.find((a) => !mentions(a.where, "tech-1"))!;
		expect(flat(pool.where)).toMatchObject({ status: "Scheduled", visit_techs: { none: {} } });
	});

	it("a caller with view_jobs is not filtered", async () => {
		fakeDb.job_visit.findFirst.mockResolvedValue({ id: "v1" });
		fakeDb.job.findFirst.mockResolvedValue({ id: "j1" });

		await callRoute(jobsRouter, "get", "/", { user: dispatcher });
		const visit = await callRoute(jobVisitsRouter, "get", "/:id", {
			user: dispatcher,
			params: { id: "v1" },
		});
		const job = await callRoute(jobsRouter, "get", "/:id", {
			user: dispatcher,
			params: { id: "j1" },
		});
		await callRoute(jobVisitsRouter, "get", "/", { user: dispatcher });

		expect(visit.status).toBe(200);
		expect(job.status).toBe(200);
		const list = fakeDb.job.findMany.mock.calls[0][0];
		expect(mentions(list.where, "disp-1")).toBe(false);
		expect(list.include.visits.where).toBeUndefined();
		expect(
			mentions(fakeDb.job_visit.findFirst.mock.calls[0][0].where, "disp-1"),
		).toBe(false);
		expect(
			mentions(fakeDb.job_visit.findMany.mock.calls[0][0].where, "disp-1"),
		).toBe(false);
	});

	it("search omits jobs not assigned to the caller", async () => {
		const r = await callRoute(searchRouter, "get", "/", {
			user: tech,
			query: { q: "acme", types: "job,visit" },
		});

		expect(r.status).toBe(200);
		const jobArgs = fakeDb.job.findMany.mock.calls[0][0];
		expect(
			clausesWith(jobArgs.where, ["visits"]).map((c) => c.visits),
		).toContainEqual({ some: onTech("tech-1") });
		const visitArgs = fakeDb.job_visit.findMany.mock.calls[0][0];
		expect(techPredicates(visitArgs.where)).toContainEqual({
			some: { tech_id: "tech-1" },
		});
	});

	it("search by a view_jobs caller is not filtered", async () => {
		await callRoute(searchRouter, "get", "/", {
			user: dispatcher,
			query: { q: "acme", types: "job" },
		});
		expect(
			mentions(fakeDb.job.findMany.mock.calls[0][0].where, "disp-1"),
		).toBe(false);
	});

	it("GET /job-visits/assigned ignores a techId query param", async () => {
		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { techId: "tech-2" },
		});

		expect(r.status).toBe(200);
		const calls = fakeDb.job_visit.findMany.mock.calls.map(([a]) => a);
		expect(calls.length).toBeGreaterThan(0);
		for (const args of calls) expect(mentions(args, "tech-2")).toBe(false);
		const own = calls.find((a) => mentions(a.where, "tech-1"))!;
		expect(techPredicates(own.where)).toContainEqual({
			some: { tech_id: "tech-1" },
		});
	});

	it("GET /job-visits/assigned sends pricing for the caller's visits only", async () => {
		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
		});

		expect(r.status).toBe(200);
		const calls = fakeDb.job_visit.findMany.mock.calls.map(([a]) => a);
		for (const args of calls) {
			const mine = mentions(args.where, "tech-1");
			expect("line_items" in args.select).toBe(mine);
			expect("notes" in args.select).toBe(mine);
		}
	});

	it("GET /job-visits/assigned defaults to yesterday through 14 days out", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
		try {
			await callRoute(jobVisitsRouter, "get", "/assigned", { user: tech });
		} finally {
			vi.useRealTimers();
		}

		const args = fakeDb.job_visit.findMany.mock.calls[0][0];
		const [lower] = clausesWith(args.where, ["scheduled_end_at"]);
		const [upper] = clausesWith(args.where, ["scheduled_start_at"]);
		expect(lower.scheduled_end_at).toEqual({
			gt: new Date("2026-11-19T00:00:00Z"),
		});
		expect(upper.scheduled_start_at).toEqual({
			lt: new Date("2026-12-05T00:00:00Z"),
		});
	});

	it("GET /job-visits/assigned refuses a range over 62 days", async () => {
		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { from: "2026-01-01T00:00:00Z", to: "2026-04-01T00:00:00Z" },
		});
		expect(r.status).toBe(400);
	});
});

// Evaluates the past scope's status/end-time rule (the OR that mentions
// status) against a visit, so tests pin behaviour rather than clause shape.
type PastProbe = { status: string; scheduled_end_at: Date };
const matchBranch = (cond: Record<string, any>, v: PastProbe) =>
	Object.entries(cond).every(([k, c]) => {
		if (k === "status") {
			if (c.in) return c.in.includes(v.status);
			if (c.notIn) return !c.notIn.includes(v.status);
			return c === v.status;
		}
		if (k === "scheduled_end_at") {
			return (
				(c.lt === undefined || v.scheduled_end_at < c.lt) &&
				(c.lte === undefined || v.scheduled_end_at <= c.lte) &&
				(c.gt === undefined || v.scheduled_end_at > c.gt)
			);
		}
		throw new Error(`unexpected past-rule key ${k}`);
	});
const pastRule = (where: unknown) => {
	const rules = clausesWith(where, ["OR"]).filter((c) => mentions(c.OR, "status"));
	expect(rules).toHaveLength(1);
	const branches = rules[0].OR as Record<string, any>[];
	return (v: PastProbe) => branches.some((b) => matchBranch(b, v));
};
const pastWhereAt = async (now: string) => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(now));
	try {
		await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1" },
		});
	} finally {
		vi.useRealTimers();
	}
	return fakeDb.job_visit.findMany.mock.calls[0][0].where;
};

describe("GET /job-visits/assigned?scope=past", () => {
	beforeEach(() => {
		fakeDb.job_visit.count.mockResolvedValue(0);
	});

	it("past scope returns only the caller's visits newest first", async () => {
		const rows = [{ id: "v2" }, { id: "v1" }];
		fakeDb.job_visit.findMany.mockResolvedValue(rows);
		fakeDb.job_visit.count.mockResolvedValue(2);

		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1" },
		});

		expect(r.status).toBe(200);
		expect(r.body.data).toEqual(rows);
		expect(fakeDb.job_visit.findMany).toHaveBeenCalledTimes(1);
		const args = fakeDb.job_visit.findMany.mock.calls[0][0];
		expect(techPredicates(args.where)).toContainEqual({
			some: { tech_id: "tech-1" },
		});
		const isPast = pastRule(args.where);
		const longAgo = new Date("2020-01-01T00:00:00Z");
		expect(isPast({ status: "Completed", scheduled_end_at: longAgo })).toBe(true);
		expect(isPast({ status: "Cancelled", scheduled_end_at: longAgo })).toBe(true);
		expect(args.orderBy).toEqual([
			{ scheduled_start_at: "desc" },
			{ id: "desc" },
		]);
		// Own visits: the same pricing-bearing select as the windowed list.
		expect("line_items" in args.select).toBe(true);
		// The total counts the same rows the page reads.
		expect(fakeDb.job_visit.count.mock.calls[0][0].where).toEqual(
			args.where,
		);
	});

	it("past scope pages with meta.count", async () => {
		fakeDb.job_visit.findMany.mockResolvedValue([{ id: "v41" }]);
		fakeDb.job_visit.count.mockResolvedValue(213);

		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "3" },
		});

		expect(r.status).toBe(200);
		const args = fakeDb.job_visit.findMany.mock.calls[0][0];
		// 20 a page unless asked otherwise.
		expect(args.skip).toBe(40);
		expect(args.take).toBe(20);
		expect(r.body.meta).toMatchObject({ count: 213, page: 3, limit: 20 });

		const big = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1", limit: "500" },
		});
		expect(big.status).toBe(400);
		expect(big.body.error.code).toBe("INVALID_INPUT");
	});

	it("past scope ignores techId and never returns claimable visits", async () => {
		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1", techId: "tech-2" },
		});

		expect(r.status).toBe(200);
		// The caller can accept, yet no pool read happens.
		expect(fakeDb.job_visit.findMany).toHaveBeenCalledTimes(1);
		const args = fakeDb.job_visit.findMany.mock.calls[0][0];
		expect(mentions(args, "tech-2")).toBe(false);
		expect(mentions(args.where, "none")).toBe(false);
		expect(techPredicates(args.where)).toEqual([
			{ some: { tech_id: "tech-1" } },
		]);
	});

	it("past scope is not limited to the default window", async () => {
		await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1" },
		});

		const args = fakeDb.job_visit.findMany.mock.calls[0][0];
		// No lower bound anywhere: only the open-visit branch has an end-time cap.
		for (const c of clausesWith(args.where, ["scheduled_end_at"])) {
			expect(c.scheduled_end_at).not.toHaveProperty("gt");
		}
		expect(clausesWith(args.where, ["scheduled_start_at"])).toEqual([]);
		const isPast = pastRule(args.where);
		expect(
			isPast({
				status: "Completed",
				scheduled_end_at: new Date("2019-06-01T00:00:00Z"),
			}),
		).toBe(true);
	});

	// Clock 2026-11-20T15Z, org in UTC: the Mine window starts 2026-11-19T00Z.
	it("an open visit that ended before the window appears in past", async () => {
		const isPast = pastRule(await pastWhereAt("2026-11-20T15:00:00Z"));
		for (const status of ["Scheduled", "InProgress", "Delayed", "Paused"]) {
			expect(
				isPast({
					status,
					scheduled_end_at: new Date("2026-11-18T23:00:00Z"),
				}),
			).toBe(true);
		}
	});

	it("an open visit inside the window is not in past", async () => {
		const isPast = pastRule(await pastWhereAt("2026-11-20T15:00:00Z"));
		// Ended 1 ms into the window, and an hour ago: both still on Mine.
		for (const end of ["2026-11-19T00:00:00.001Z", "2026-11-20T14:00:00Z"]) {
			expect(
				isPast({ status: "Scheduled", scheduled_end_at: new Date(end) }),
			).toBe(false);
		}
		expect(
			isPast({
				status: "Delayed",
				scheduled_end_at: new Date("2026-11-19T10:00:00Z"),
			}),
		).toBe(false);
	});

	// Mine's overlap is end > start, so an end exactly at the start belongs here.
	it("an open visit ending exactly at the window start is in past", async () => {
		const isPast = pastRule(await pastWhereAt("2026-11-20T15:00:00Z"));
		expect(
			isPast({
				status: "Scheduled",
				scheduled_end_at: new Date("2026-11-19T00:00:00Z"),
			}),
		).toBe(true);
	});

	it("past scope only sorts newest first", async () => {
		const asc = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1", dir: "asc" },
		});
		expect(asc.status).toBe(400);
		expect(asc.body.error.code).toBe("INVALID_INPUT");
		expect(fakeDb.job_visit.findMany).not.toHaveBeenCalled();

		const desc = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "past", page: "1", dir: "desc" },
		});
		expect(desc.status).toBe(200);
	});

	it("an unknown scope is refused", async () => {
		const r = await callRoute(jobVisitsRouter, "get", "/assigned", {
			user: tech,
			query: { scope: "everything" },
		});
		expect(r.status).toBe(400);
		expect(fakeDb.job_visit.findMany).not.toHaveBeenCalled();
	});
});
