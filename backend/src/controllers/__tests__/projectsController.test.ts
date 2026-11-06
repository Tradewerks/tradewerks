import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", () => ({
	db: {},
	generateProjectNumber: vi.fn().mockResolvedValue("P-0001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn(),
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

// clientsController pulls these in; neither is exercised by the deleteClient guard.
vi.mock("../../services/quickbooksService.js", () => ({
	getOrgRealmId: vi.fn().mockResolvedValue(null),
}));
vi.mock("../contactsController.js", () => ({
	insertContact: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import {
	insertProject,
	updateProject,
	deleteProject,
	attachJob,
} from "../projectsController.js";
import { deleteClient } from "../clientsController.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../../services/appLogger.js";
import { Prisma } from "../../../generated/prisma/client.js";

const mockGetScopedDb = vi.mocked(getScopedDb);

// ── IDs ───────────────────────────────────────────────────────────────────────

const ORG_ID = "org-1";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const FOREIGN_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const DISPATCHER_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT_ID = "66666666-6666-4666-8666-666666666666";

// ── Factories ─────────────────────────────────────────────────────────────────

function makeProject(overrides: Record<string, unknown> = {}) {
	return {
		id: PROJECT_ID,
		organization_id: ORG_ID,
		project_number: "P-0001",
		name: "Rooftop replacement",
		description: "Scope",
		status: "Active",
		priority: "Medium",
		address: "1 Main St",
		coords: null,
		manager_dispatcher_id: DISPATCHER_ID,
		client_id: CLIENT_ID,
		budget: null,
		starts_at: null,
		target_end_at: null,
		created_at: new Date("2026-01-01T00:00:00Z"),
		updated_at: new Date("2026-01-01T00:00:00Z"),
		completed_at: null,
		cancelled_at: null,
		cancellation_reason: null,
		...overrides,
	};
}

function makeJob(overrides: Record<string, unknown> = {}) {
	return {
		id: JOB_ID,
		job_number: "J-0001",
		project_id: null,
		...overrides,
	};
}

/** Scoped-db mock whose $transaction runs the callback inline against `tx`. */
function makeSdb(opts: {
	existingProject?: unknown;
	txClient?: unknown;
	txJob?: unknown;
	dispatcher?: unknown;
} = {}) {
	const existing = "existingProject" in opts ? opts.existingProject : makeProject();
	const tx = {
		client: { findFirst: vi.fn().mockResolvedValue("txClient" in opts ? opts.txClient : { id: CLIENT_ID }) },
		dispatcher: { findFirst: vi.fn().mockResolvedValue({ id: DISPATCHER_ID }) },
		job: {
			findFirst: vi.fn().mockResolvedValue("txJob" in opts ? opts.txJob : makeJob()),
			update: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn(),
		},
		project: {
			findFirst: vi.fn().mockResolvedValue(existing),
			create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
				makeProject({ ...data, id: PROJECT_ID }),
			),
			update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
				makeProject({ ...(existing as object), ...data }),
			),
			delete: vi.fn().mockResolvedValue(undefined),
		},
	};
	const sdb = {
		project: { findFirst: vi.fn().mockResolvedValue(existing) },
		dispatcher: {
			findFirst: vi.fn().mockResolvedValue("dispatcher" in opts ? opts.dispatcher : { id: DISPATCHER_ID }),
		},
		$transaction: vi.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
		_tx: tx,
	};
	mockGetScopedDb.mockReturnValue(sdb as unknown as ReturnType<typeof getScopedDb>);
	return sdb;
}

function makeReq(overrides: Partial<Request> = {}): Request {
	return {
		user: { organization_id: ORG_ID, role: "admin", permissions: [], uid: DISPATCHER_ID, email: "a@x.test" },
		params: { id: PROJECT_ID },
		body: {},
		...overrides,
	} as unknown as Request;
}

function updateDataFromLastCall(sdb: ReturnType<typeof makeSdb>) {
	const calls = sdb._tx.project.update.mock.calls;
	const call = calls[calls.length - 1];
	return call ? (call[0] as { data: Record<string, unknown> }).data : undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("updateProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a client_id that is not visible in the caller's org", async () => {
		const sdb = makeSdb({ txClient: null });
		const result = await updateProject(makeReq({ body: { client_id: FOREIGN_CLIENT_ID } }));

		expect(result.err).toBe("Client not found");
		expect(result.project).toBeUndefined();
		expect(sdb._tx.client.findFirst).toHaveBeenCalledWith({ where: { id: FOREIGN_CLIENT_ID } });
		expect(sdb._tx.project.update).not.toHaveBeenCalled();
	});

	it("does not look up a client when client_id is not part of the update", async () => {
		const sdb = makeSdb({ txClient: null });
		const result = await updateProject(makeReq({ body: { name: "Renamed" } }));

		expect(result.err).toBe("");
		expect(sdb._tx.client.findFirst).not.toHaveBeenCalled();
		expect(sdb._tx.project.update).toHaveBeenCalled();
	});

	it("writes manager_dispatcher_id: null so the manager can be cleared", async () => {
		const sdb = makeSdb();
		const result = await updateProject(makeReq({ body: { manager_dispatcher_id: null } }));

		expect(result.err).toBe("");
		expect(updateDataFromLastCall(sdb)?.manager_dispatcher_id).toBeNull();
	});

	it("persists description: '' and maps address: '' to null", async () => {
		const sdb = makeSdb();
		const result = await updateProject(makeReq({ body: { description: "", address: "" } }));

		expect(result.err).toBe("");
		const data = updateDataFromLastCall(sdb);
		expect(data?.description).toBe("");
		expect(data?.address).toBeNull();
	});

	it("returns 'Project not found' for an unknown id", async () => {
		const sdb = makeSdb({ existingProject: null });
		const result = await updateProject(makeReq({ body: { name: "x" } }));

		expect(result.err).toBe("Project not found");
		expect(sdb._tx.project.update).not.toHaveBeenCalled();
	});

	it("returns a validation error for a bad status and does not touch the db", async () => {
		const sdb = makeSdb();
		const result = await updateProject(makeReq({ body: { status: "Bogus" } }));

		expect(result.err).toMatch(/^Validation failed/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("stamps completed_at when status moves to Completed", async () => {
		const sdb = makeSdb();
		const result = await updateProject(makeReq({ body: { status: "Completed" } }));

		expect(result.err).toBe("");
		const data = updateDataFromLastCall(sdb);
		expect(data?.completed_at).toBeInstanceOf(Date);
		expect(data?.cancelled_at).toBeUndefined();
	});

	it("stamps cancelled_at and clears completed_at when Completed → Cancelled", async () => {
		const sdb = makeSdb({
			existingProject: makeProject({ status: "Completed", completed_at: new Date() }),
		});
		await updateProject(makeReq({ body: { status: "Cancelled" } }));

		const data = updateDataFromLastCall(sdb);
		expect(data?.cancelled_at).toBeInstanceOf(Date);
		expect(data?.completed_at).toBeNull();
	});

	it("clears completed_at when leaving Completed for a non-terminal status", async () => {
		const sdb = makeSdb({
			existingProject: makeProject({ status: "Completed", completed_at: new Date() }),
		});
		await updateProject(makeReq({ body: { status: "Active" } }));

		const data = updateDataFromLastCall(sdb);
		expect(data?.completed_at).toBeNull();
		expect(data?.cancelled_at).toBeUndefined();
	});

	it("leaves the timestamps alone when the status does not change", async () => {
		const sdb = makeSdb({ existingProject: makeProject({ status: "Completed" }) });
		await updateProject(makeReq({ body: { status: "Completed", name: "Same status" } }));

		const data = updateDataFromLastCall(sdb);
		expect(data?.completed_at).toBeUndefined();
		expect(data?.cancelled_at).toBeUndefined();
	});

	it("hides unexpected errors behind a generic message and logs them", async () => {
		const sdb = makeSdb();
		sdb.project.findFirst.mockRejectedValue(new Error("connection reset by peer"));
		const result = await updateProject(makeReq({ body: { name: "x" } }));

		expect(result.err).toBe("Failed to update project");
		expect(log.error).toHaveBeenCalled();
	});
});

describe("insertProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("retries once on a P2002 project_number collision and succeeds", async () => {
		const sdb = makeSdb();
		const collision = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
			code: "P2002",
			clientVersion: "test",
		});
		const tx = sdb._tx;
		sdb.$transaction
			.mockImplementationOnce(async () => {
				throw collision;
			})
			.mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => fn(tx));

		const result = await insertProject(makeReq({ body: { name: "New", client_id: CLIENT_ID } }));

		expect(result.err).toBe("");
		expect(result.project?.id).toBe(PROJECT_ID);
		expect(sdb.$transaction).toHaveBeenCalledTimes(2);
	});

	it("rejects a client the org cannot see", async () => {
		const sdb = makeSdb({ txClient: null });
		const result = await insertProject(makeReq({ body: { name: "New", client_id: FOREIGN_CLIENT_ID } }));

		expect(result.err).toBe("Client not found");
		expect(sdb._tx.project.create).not.toHaveBeenCalled();
	});
});

describe("attachJob", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("reads the job id from the URL, not the body", async () => {
		const sdb = makeSdb();
		const result = await attachJob(makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID }, body: {} }));

		expect(result.err).toBe("");
		expect(sdb._tx.job.findFirst).toHaveBeenCalledWith({ where: { id: JOB_ID } });
		expect(sdb._tx.job.update).toHaveBeenCalledWith({
			where: { id: JOB_ID },
			data: { project_id: PROJECT_ID },
		});
	});

	it("rejects a body jobId that disagrees with the URL", async () => {
		const sdb = makeSdb();
		const result = await attachJob(
			makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID }, body: { jobId: OTHER_PROJECT_ID } }),
		);

		expect(result.err).toMatch(/^Validation failed/);
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});

	it("returns a conflict message when the job is attached to another project", async () => {
		const sdb = makeSdb({ txJob: makeJob({ project_id: OTHER_PROJECT_ID }) });
		const result = await attachJob(makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID } }));

		expect(result.err).toBe("Job is already attached to another project");
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});

	it("treats a job from another org (invisible through the scoped db) as not found", async () => {
		const sdb = makeSdb({ txJob: null });
		const result = await attachJob(makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID } }));

		expect(result.err).toBe("Job not found");
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});

	it("is a no-op when the job is already on this project", async () => {
		const sdb = makeSdb({ txJob: makeJob({ project_id: PROJECT_ID }) });
		const result = await attachJob(makeReq({ params: { id: PROJECT_ID, jobId: JOB_ID } }));

		expect(result.err).toBe("");
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});
});

describe("deleteProject", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("deletes the project row and relies on FK SetNull to detach jobs", async () => {
		const sdb = makeSdb();
		const result = await deleteProject(ORG_ID, PROJECT_ID);

		expect(result.err).toBe("");
		expect(sdb._tx.project.delete).toHaveBeenCalledWith({ where: { id: PROJECT_ID } });
		expect(sdb._tx.job.delete).not.toHaveBeenCalled();
		expect(sdb._tx.job.update).not.toHaveBeenCalled();
	});

	it("returns 'Project not found' for an unknown id", async () => {
		const sdb = makeSdb({ existingProject: null });
		const result = await deleteProject(ORG_ID, PROJECT_ID);

		expect(result.err).toBe("Project not found");
		expect(sdb._tx.project.delete).not.toHaveBeenCalled();
	});
});

describe("deleteClient — project guard", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function makeClientSdb(projects: { id: string }[]) {
		const tx = { client: { delete: vi.fn().mockResolvedValue(undefined) } };
		const sdb = {
			client: {
				findFirst: vi.fn().mockResolvedValue({
					id: CLIENT_ID,
					name: "Acme",
					jobs: [],
					recurring_plans: [],
					requests: [],
					quotes: [],
					projects,
				}),
			},
			$transaction: vi.fn().mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx)),
			_tx: tx,
		};
		mockGetScopedDb.mockReturnValue(sdb as unknown as ReturnType<typeof getScopedDb>);
		return sdb;
	}

	it("refuses to delete a client that still owns projects", async () => {
		const sdb = makeClientSdb([{ id: PROJECT_ID }]);
		const result = await deleteClient(CLIENT_ID, ORG_ID);

		expect(result.err).toBe("Cannot delete client with existing projects");
		expect(sdb._tx.client.delete).not.toHaveBeenCalled();
	});

	it("deletes a client with no dependants", async () => {
		const sdb = makeClientSdb([]);
		const result = await deleteClient(CLIENT_ID, ORG_ID);

		expect(result.err).toBe("");
		expect(sdb._tx.client.delete).toHaveBeenCalledWith({ where: { id: CLIENT_ID } });
	});
});
