import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakeDb, techOnJob, getEntityHistory } = vi.hoisted(() => ({
	fakeDb: {
		job: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
		job_visit: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
	},
	techOnJob: vi.fn(),
	getEntityHistory: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => fakeDb) }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../controllers/jobsController.js", () => ({ techOnJob }));
vi.mock("../../controllers/logsController.js", () => ({
	DEFAULT_HISTORY_LIMIT: 25,
	MAX_HISTORY_LIMIT: 100,
	getEntityHistory,
}));

import { executeTool } from "../execute.js";
import { READ_ONLY_POLICY } from "../policy.js";
import "../tools/records.js";
import "../tools/history.js";
import type { AgentContext } from "../types.js";

const ctxWith = (...permissions: string[]): AgentContext => ({
	userId: "tech-1",
	role: "technician",
	organizationId: "org-1",
	permissions,
	actorType: "technician",
	surface: "assistant",
});
// The default Technician role's job/visit permissions.
const tech = ctxWith("view_assigned_jobs", "view_visits", "view_clients");
const ID = "11111111-1111-4111-8111-111111111111";
const onTech = { visit_techs: { some: { tech_id: "tech-1" } } };

beforeEach(() => {
	vi.clearAllMocks();
	fakeDb.job.findMany.mockResolvedValue([]);
	fakeDb.job.count.mockResolvedValue(0);
	fakeDb.job_visit.findMany.mockResolvedValue([]);
	fakeDb.job_visit.count.mockResolvedValue(0);
	getEntityHistory.mockResolvedValue({ err: "", rows: [], total: 0, hasMore: false });
});

describe("assistant reads for a view_assigned_jobs-only caller", () => {
	it("assistant get_record for an unassigned job is not found for an assigned-only caller", async () => {
		fakeDb.job.findFirst.mockResolvedValue(null);
		const r = await executeTool("get_record", { type: "job", id: ID }, tech, READ_ONLY_POLICY);

		expect(r).toMatchObject({ ok: true, data: { found: false } });
		const args = fakeDb.job.findFirst.mock.calls[0][0];
		expect(args.where).toMatchObject({ id: ID, visits: { some: onTech } });
		expect(args.select.visits.where).toEqual(onTech);
	});

	it("assistant get_record for a visit adds the caller's predicate", async () => {
		fakeDb.job_visit.findFirst.mockResolvedValue(null);
		await executeTool("get_record", { type: "visit", id: ID }, tech, READ_ONLY_POLICY);
		expect(fakeDb.job_visit.findFirst.mock.calls[0][0].where).toMatchObject({ id: ID, ...onTech });
	});

	it("assistant list_records jobs returns only assigned jobs", async () => {
		await executeTool("list_records", { type: "job" }, tech, READ_ONLY_POLICY);
		expect(fakeDb.job.findMany.mock.calls[0][0].where).toMatchObject({ visits: { some: onTech } });
		expect(fakeDb.job.count.mock.calls[0][0].where).toMatchObject({ visits: { some: onTech } });

		await executeTool("list_records", { type: "visit" }, tech, READ_ONLY_POLICY);
		expect(fakeDb.job_visit.findMany.mock.calls[0][0].where).toMatchObject(onTech);
	});

	it("a view_jobs caller's assistant reads are not filtered", async () => {
		await executeTool("list_records", { type: "job" }, ctxWith("view_jobs"), READ_ONLY_POLICY);
		expect(fakeDb.job.findMany.mock.calls[0][0].where).not.toHaveProperty("visits");
	});

	it("assistant history for an unassigned job is not found", async () => {
		techOnJob.mockResolvedValue(false);
		const r = await executeTool("get_entity_history", { type: "job", id: ID }, tech, READ_ONLY_POLICY);

		expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(techOnJob).toHaveBeenCalledWith("org-1", "tech-1", ID);
		expect(getEntityHistory).not.toHaveBeenCalled();
	});

	it("assistant history for an assigned job is returned", async () => {
		techOnJob.mockResolvedValue(true);
		const r = await executeTool("get_entity_history", { type: "job", id: ID }, tech, READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: true });
	});

	it("assistant client history is not found for an assigned-only caller", async () => {
		const r = await executeTool("get_entity_history", { type: "client", id: ID }, tech, READ_ONLY_POLICY);
		expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		expect(getEntityHistory).not.toHaveBeenCalled();
	});
});
