import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../reportsController.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../reportsController.js")>();
	return { ...actual, getPageSummary: vi.fn(), getPageSnapshot: vi.fn() };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import reportsRouter from "../../routes/reports.js";
import { getPageSnapshot, getPageSummary } from "../reportsController.js";

const mockGetPageSummary = vi.mocked(getPageSummary);
const mockGetPageSnapshot = vi.mocked(getPageSnapshot);

// ── Harness — same shape as routes/__tests__/org.test.ts: pull the handler
// chain off the Router's stack and dispatch it like Express would. ───────────

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function getHandlers(method: "get", path: string): Handler[] {
	const stack = (reportsRouter as unknown as {
		stack: Array<{
			route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
		}>;
	}).stack;
	const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
	if (!layer?.route) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
	return layer.route.stack.map((s) => s.handle);
}

function makeReq(query: Record<string, unknown>): Request {
	return {
		user: { organization_id: "org-1", role: "admin", permissions: ["view_reports"] },
		query,
		body: {},
	} as unknown as Request;
}

function makeRes() {
	const res: Partial<Response> & { json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> } = {
		status: vi.fn(),
		json: vi.fn(),
	};
	res.status = vi.fn().mockReturnValue(res as Response);
	res.json = vi.fn().mockReturnValue(res as Response);
	return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

function dispatch(handlers: Handler[], req: Request, res: Response, i: number): Promise<void> {
	if (i >= handlers.length) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		let nextCalled = false;
		const next: NextFunction = ((err?: unknown) => {
			nextCalled = true;
			if (err) return reject(err);
			dispatch(handlers, req, res, i + 1).then(resolve, reject);
		}) as NextFunction;
		Promise.resolve(handlers[i](req, res, next))
			.then(() => {
				if (!nextCalled) resolve();
			})
			.catch(reject);
	});
}

const run = async (query: Record<string, unknown>) => {
	const res = makeRes();
	await dispatch(getHandlers("get", "/page-summary"), makeReq(query), res, 0);
	return res;
};

const errorCode = (res: ReturnType<typeof makeRes>) =>
	(res.json.mock.calls[0][0] as { error: { code: string } }).error.code;

beforeEach(() => {
	vi.clearAllMocks();
	mockGetPageSummary.mockResolvedValue({ page: "jobs", stats: [], breakdown: [], breakdownLabel: "" });
});

// Review 02-F6 / P2-11: the route passed req.query straight through, so a bad
// page or date surfaced as a 500 from the controller/Prisma.
describe("GET /reports/page-summary validation", () => {
	it("passes a valid query through to the controller", async () => {
		const res = await run({
			page: "invoices",
			startDate: "2026-08-01T06:00:00.000Z",
			endDate: "2026-09-01T05:59:59.999Z",
			groupBy: "qb_sync",
		});
		expect(res.status).not.toHaveBeenCalledWith(400);
		expect(mockGetPageSummary).toHaveBeenCalledWith(
			"org-1",
			"invoices",
			"2026-08-01T06:00:00.000Z",
			"2026-09-01T05:59:59.999Z",
			"qb_sync",
		);
	});

	it("accepts bare YYYY-MM-DD bounds and omitted dates", async () => {
		let res = await run({ page: "jobs", startDate: "2026-08-01", endDate: "2026-08-31" });
		expect(res.status).not.toHaveBeenCalledWith(400);
		res = await run({ page: "jobs" });
		expect(res.status).not.toHaveBeenCalledWith(400);
		expect(mockGetPageSummary).toHaveBeenLastCalledWith("org-1", "jobs", undefined, undefined, undefined);
	});

	it("400s on an unknown page without reaching the controller", async () => {
		const res = await run({ page: "payroll" });
		expect(res.status).toHaveBeenCalledWith(400);
		expect(errorCode(res)).toBe("VALIDATION_ERROR");
		expect(mockGetPageSummary).not.toHaveBeenCalled();
	});

	it("400s when page is missing", async () => {
		const res = await run({});
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mockGetPageSummary).not.toHaveBeenCalled();
	});

	it("400s on an unparseable date", async () => {
		const res = await run({ page: "jobs", startDate: "last tuesday" });
		expect(res.status).toHaveBeenCalledWith(400);
		expect(errorCode(res)).toBe("VALIDATION_ERROR");
		expect(mockGetPageSummary).not.toHaveBeenCalled();
	});

	it("400s on a groupBy that no page defines", async () => {
		const res = await run({ page: "jobs", groupBy: "drop table" });
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mockGetPageSummary).not.toHaveBeenCalled();
	});

	it("still passes a groupBy that another page defines (controller falls back per page)", async () => {
		const res = await run({ page: "jobs", groupBy: "qb_sync" });
		expect(res.status).not.toHaveBeenCalledWith(400);
		expect(mockGetPageSummary).toHaveBeenCalledWith("org-1", "jobs", undefined, undefined, "qb_sync");
	});

	it("is gated on view_reports", async () => {
		const res = makeRes();
		const req = {
			user: { organization_id: "org-1", role: "dispatcher", permissions: [] },
			query: { page: "jobs" },
			body: {},
		} as unknown as Request;
		await dispatch(getHandlers("get", "/page-summary"), req, res, 0);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(mockGetPageSummary).not.toHaveBeenCalled();
	});
});

describe("GET /reports/page-snapshot", () => {
	const snap = async (query: Record<string, unknown>, permissions = ["view_reports"]) => {
		const res = makeRes();
		const req = {
			user: { organization_id: "org-1", role: "dispatcher", permissions },
			query,
			body: {},
		} as unknown as Request;
		await dispatch(getHandlers("get", "/page-snapshot"), req, res, 0);
		return res;
	};
	beforeEach(() => mockGetPageSnapshot.mockResolvedValue({ page: "jobs", stats: [] }));

	it("passes the page through, never dates", async () => {
		const res = await snap({ page: "invoices", startDate: "2026-08-01" });
		expect(res.status).not.toHaveBeenCalledWith(400);
		expect(mockGetPageSnapshot).toHaveBeenCalledWith("org-1", "invoices");
	});

	it("400s on an unknown page without reaching the controller", async () => {
		const res = await snap({ page: "payroll" });
		expect(res.status).toHaveBeenCalledWith(400);
		expect(mockGetPageSnapshot).not.toHaveBeenCalled();
	});

	it("is gated on view_reports", async () => {
		const res = await snap({ page: "jobs" }, []);
		expect(res.status).toHaveBeenCalledWith(403);
		expect(mockGetPageSnapshot).not.toHaveBeenCalled();
	});
});
