import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => ({
	db: {},
	generateProjectNumber: vi.fn().mockResolvedValue("P-0001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({ emit: vi.fn() })),
	emitToOrg: vi.fn(),
}));

vi.mock("../../controllers/logsController.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../controllers/logsController.js")>();
	return {
		...actual,
		getEntityHistory: vi.fn().mockResolvedValue({ err: "", rows: [], hasMore: false, total: 0 }),
	};
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import projectsRouter from "../projects.js";
import { getScopedDb } from "../../lib/context.js";
import { getEntityHistory } from "../../controllers/logsController.js";

const mockGetScopedDb = vi.mocked(getScopedDb);
const mockGetEntityHistory = vi.mocked(getEntityHistory);

// ── Test harness — route handlers are inline in projects.ts, so pull them
// straight off the Router's internal stack (router-level middleware such as
// denyTechnicians included) rather than duplicating them here. ───────────────

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

type Layer = {
	handle: Handler;
	route?: {
		path: string;
		methods: Record<string, boolean>;
		stack: Array<{ handle: Handler }>;
	};
};

function getHandlers(method: "get" | "post" | "put" | "delete", path: string): Handler[] {
	const stack = (projectsRouter as unknown as { stack: Layer[] }).stack;
	const index = stack.findIndex((l) => l.route?.path === path && l.route.methods[method]);
	if (index === -1) throw new Error(`route ${method.toUpperCase()} ${path} not found`);
	const middleware = stack.slice(0, index).filter((l) => !l.route).map((l) => l.handle);
	return [...middleware, ...stack[index].route!.stack.map((s) => s.handle)];
}

function makeReq(overrides: Partial<Request> = {}): Request {
	return {
		user: { organization_id: "org-1", role: "admin", permissions: [], uid: "disp-1", email: "a@x.test" },
		params: {},
		query: {},
		body: {},
		headers: {},
		...overrides,
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

async function runChain(handlers: Handler[], req: Request, res: Response) {
	await dispatch(handlers, req, res, 0);
}

// ── Scoped db fixture ─────────────────────────────────────────────────────────

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT_ID = "66666666-6666-4666-8666-666666666666";

const baseProject = {
	id: PROJECT_ID,
	organization_id: "org-1",
	project_number: "P-0001",
	name: "Rooftop replacement",
	description: "",
	status: "Active",
	priority: "Medium",
	address: null,
	coords: null,
	manager_dispatcher_id: null,
	client_id: CLIENT_ID,
	budget: null,
	starts_at: null,
	target_end_at: null,
	created_at: new Date("2026-01-01T00:00:00Z"),
	updated_at: new Date("2026-01-01T00:00:00Z"),
	completed_at: null,
	cancelled_at: null,
	cancellation_reason: null,
};

function makeSdb(opts: { existingProject?: unknown; txJob?: unknown } = {}) {
	const existing = "existingProject" in opts ? opts.existingProject : baseProject;
	const tx = {
		client: { findFirst: vi.fn().mockResolvedValue({ id: CLIENT_ID }) },
		dispatcher: { findFirst: vi.fn().mockResolvedValue(null) },
		job: {
			findFirst: vi.fn().mockResolvedValue(
				"txJob" in opts ? opts.txJob : { id: JOB_ID, job_number: "J-1", project_id: null },
			),
			update: vi.fn().mockResolvedValue(undefined),
		},
		project: {
			findFirst: vi.fn().mockResolvedValue(existing),
			create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
				...baseProject,
				...data,
			})),
			update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
				...baseProject,
				...data,
			})),
			delete: vi.fn().mockResolvedValue(undefined),
		},
	};
	const sdb = {
		project: { findFirst: vi.fn().mockResolvedValue(existing) },
		dispatcher: { findFirst: vi.fn().mockResolvedValue(null) },
		$transaction: vi.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
		_tx: tx,
	};
	mockGetScopedDb.mockReturnValue(sdb as unknown as ReturnType<typeof getScopedDb>);
	return sdb;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("projects routes — status mapping", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetEntityHistory.mockResolvedValue({ err: "", rows: [], hasMore: false, total: 0 } as never);
	});

	it("POST / with an invalid body responds 400 VALIDATION_ERROR", async () => {
		const sdb = makeSdb();
		const req = makeReq({ body: { client_id: CLIENT_ID } }); // name missing
		const res = makeRes();
		await runChain(getHandlers("post", "/"), req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
			}),
		);
		expect(sdb._tx.project.create).not.toHaveBeenCalled();
	});

	it("POST / returns 201 with the project entity as data", async () => {
		makeSdb();
		const req = makeReq({ body: { name: "New", client_id: CLIENT_ID } });
		const res = makeRes();
		await runChain(getHandlers("post", "/"), req, res);

		expect(res.status).toHaveBeenCalledWith(201);
		const payload = res.json.mock.calls[0][0];
		expect(payload.success).toBe(true);
		expect(payload.data).toEqual(expect.objectContaining({ id: PROJECT_ID, name: "New" }));
		expect(payload.data).not.toHaveProperty("err");
	});

	it("PUT /:id for an unknown project responds 404 NOT_FOUND", async () => {
		makeSdb({ existingProject: null });
		const req = makeReq({ params: { id: PROJECT_ID }, body: { name: "x" } });
		const res = makeRes();
		await runChain(getHandlers("put", "/:id"), req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({
				success: false,
				error: expect.objectContaining({ code: "NOT_FOUND", message: "Project not found" }),
			}),
		);
	});

	it("PUT /:id with a foreign client_id responds 404 and writes nothing", async () => {
		const sdb = makeSdb();
		sdb._tx.client.findFirst.mockResolvedValue(null);
		const req = makeReq({ params: { id: PROJECT_ID }, body: { client_id: OTHER_PROJECT_ID } });
		const res = makeRes();
		await runChain(getHandlers("put", "/:id"), req, res);

		expect(res.status).toHaveBeenCalledWith(404);
		expect(sdb._tx.project.update).not.toHaveBeenCalled();
	});

	it("PUT /:id returns 200 with the updated entity as data", async () => {
		makeSdb();
		const req = makeReq({ params: { id: PROJECT_ID }, body: { name: "Renamed" } });
		const res = makeRes();
		await runChain(getHandlers("put", "/:id"), req, res);

		expect(res.status).not.toHaveBeenCalled();
		const payload = res.json.mock.calls[0][0];
		expect(payload.success).toBe(true);
		expect(payload.data).toEqual(expect.objectContaining({ id: PROJECT_ID, name: "Renamed" }));
		expect(payload.data).not.toHaveProperty("err");
	});

	it("DELETE /:id for an unknown project responds 404", async () => {
		makeSdb({ existingProject: null });
		const req = makeReq({ params: { id: PROJECT_ID } });
		const res = makeRes();
		await runChain(getHandlers("delete", "/:id"), req, res);

		expect(res.status).toHaveBeenCalledWith(404);
	});

	it("DELETE /:id returns the deleted id on success", async () => {
		makeSdb();
		const req = makeReq({ params: { id: PROJECT_ID } });
		const res = makeRes();
		await runChain(getHandlers("delete", "/:id"), req, res);

		expect(res.status).not.toHaveBeenCalled();
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ success: true, data: { id: PROJECT_ID } }),
		);
	});

	it("rejects technicians with 403 before reaching the controller", async () => {
		const sdb = makeSdb();
		const req = makeReq({
			user: {
				organization_id: "org-1",
				role: "technician",
				permissions: ["edit_projects"],
				uid: "tech-1",
				email: "t@x.test",
			},
			params: { id: PROJECT_ID },
			body: { name: "x" },
		});
		const res = makeRes();
		await runChain(getHandlers("put", "/:id"), req, res);

		expect(res.status).toHaveBeenCalledWith(403);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("rejects a dispatcher without edit_projects with 403", async () => {
		makeSdb();
		const req = makeReq({
			user: {
				organization_id: "org-1",
				role: "dispatcher",
				permissions: ["view_projects"],
				uid: "d-2",
				email: "d@x.test",
			},
			params: { id: PROJECT_ID },
			body: { name: "x" },
		});
		const res = makeRes();
		await runChain(getHandlers("put", "/:id"), req, res);

		expect(res.status).toHaveBeenCalledWith(403);
	});
});

describe("projects routes — attach job", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("POST /:id/jobs/:jobId attaches the job named in the path (no body needed)", async () => {
		const sdb = makeSdb();
		const req = makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID }, body: {} });
		const res = makeRes();
		await runChain(getHandlers("post", "/:id/jobs/:jobId"), req, res);

		expect(res.status).not.toHaveBeenCalled();
		expect(sdb._tx.job.update).toHaveBeenCalledWith({
			where: { id: JOB_ID },
			data: { project_id: PROJECT_ID },
		});
		const payload = res.json.mock.calls[0][0];
		expect(payload.data).toEqual(expect.objectContaining({ id: PROJECT_ID }));
	});

	it("POST /:id/jobs/:jobId responds 400 when the body jobId disagrees with the path", async () => {
		const sdb = makeSdb();
		const req = makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID }, body: { jobId: OTHER_PROJECT_ID } });
		const res = makeRes();
		await runChain(getHandlers("post", "/:id/jobs/:jobId"), req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});

	it("POST /:id/jobs/:jobId responds 409 when the job belongs to another project", async () => {
		makeSdb({ txJob: { id: JOB_ID, job_number: "J-1", project_id: OTHER_PROJECT_ID } });
		const req = makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID } });
		const res = makeRes();
		await runChain(getHandlers("post", "/:id/jobs/:jobId"), req, res);

		expect(res.status).toHaveBeenCalledWith(409);
		expect(res.json).toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.objectContaining({ code: "CONFLICT" }) }),
		);
	});
});

describe("projects routes — change history limit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetEntityHistory.mockResolvedValue({ err: "", rows: [], hasMore: false, total: 0 } as never);
	});

	it("GET /:id/changes responds 400 for a non-numeric limit", async () => {
		const req = makeReq({ params: { id: PROJECT_ID }, query: { limit: "abc" } });
		const res = makeRes();
		await runChain(getHandlers("get", "/:id/changes"), req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(mockGetEntityHistory).not.toHaveBeenCalled();
	});

	it("GET /:id/changes responds 400 for a negative limit", async () => {
		const req = makeReq({ params: { id: PROJECT_ID }, query: { limit: "-5" } });
		const res = makeRes();
		await runChain(getHandlers("get", "/:id/changes"), req, res);

		expect(res.status).toHaveBeenCalledWith(400);
	});

	it("GET /:id/changes uses the default limit when none is given", async () => {
		const req = makeReq({ params: { id: PROJECT_ID } });
		const res = makeRes();
		await runChain(getHandlers("get", "/:id/changes"), req, res);

		expect(mockGetEntityHistory).toHaveBeenCalledWith("org-1", "project", PROJECT_ID, 20);
		expect(res.status).not.toHaveBeenCalled();
	});
});
