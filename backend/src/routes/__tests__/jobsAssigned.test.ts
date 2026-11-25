import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ techId: "tech-1" }),
}));
vi.mock("../../controllers/jobsController.js", () => ({
	getAllJobs: vi.fn(),
	getJobsPage: vi.fn(),
	parseJobListExtras: vi.fn(),
	JOB_LIST_SPEC: { sortable: ["created_at"], defaultSort: "created_at", defaultDir: "desc" },
	getJobById: vi.fn(async () => ({ id: "j1" })),
	insertJob: vi.fn(),
	updateJob: vi.fn(),
	deleteJob: vi.fn(),
	techOnJob: vi.fn(),
	techOnVisit: vi.fn(),
	techOnNote: vi.fn(),
}));
vi.mock("../../controllers/jobNotesController.js", () => ({
	getJobNotes: vi.fn(async () => []),
	getJobNotesByVisitId: vi.fn(async () => []),
	insertJobNote: vi.fn(async () => ({ err: "", item: { id: "n1" } })),
	updateJobNote: vi.fn(async () => ({ err: "", item: { id: "n1" } })),
	deleteJobNote: vi.fn(),
}));
vi.mock("../../controllers/jobVisitsController.js", () => ({
	getJobVisitsByJobId: vi.fn(async () => []),
}));
vi.mock("../../controllers/invoicesController.js", () => ({}));
vi.mock("../../controllers/recurringPlansController.js", () => ({}));
vi.mock("../../controllers/recurringPlanNotesController.js", () => ({}));
vi.mock("../../controllers/logsController.js", () => ({
	getEntityHistory: vi.fn(),
	parseHistoryLimit: vi.fn(),
	INVALID_HISTORY_LIMIT: Symbol("INVALID_HISTORY_LIMIT"),
}));
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
import {
	getAllJobs,
	getJobById,
	techOnJob,
	techOnVisit,
	techOnNote,
} from "../../controllers/jobsController.js";
import { getJobNotes } from "../../controllers/jobNotesController.js";
import { callRoute } from "./harness.js";

const tech = {
	uid: "tech-1",
	role: "technician",
	permissions: ["view_assigned_jobs", "add_job_notes"],
};
const dispatcher = {
	uid: "disp-1",
	role: "dispatcher",
	permissions: ["view_jobs", "edit_jobs"],
};

const routes = [
	["get", "/:id", { id: "j1" }, techOnJob, ["org-1", "tech-1", "j1"]],
	[
		"get",
		"/:jobId/visits",
		{ jobId: "j1" },
		techOnJob,
		["org-1", "tech-1", "j1"],
	],
	[
		"get",
		"/:jobId/notes",
		{ jobId: "j1" },
		techOnJob,
		["org-1", "tech-1", "j1"],
	],
	[
		"get",
		"/:jobId/visits/:visitId/notes",
		{ jobId: "j1", visitId: "v1" },
		techOnVisit,
		["org-1", "tech-1", "v1"],
	],
	[
		"post",
		"/:jobId/notes",
		{ jobId: "j1" },
		techOnJob,
		["org-1", "tech-1", "j1"],
	],
	[
		"put",
		"/:jobId/notes/:noteId",
		{ jobId: "j1", noteId: "n1" },
		techOnNote,
		["org-1", "tech-1", "n1"],
	],
] as const;

beforeEach(() => vi.clearAllMocks());

describe("job routes — technicians only reach what they're assigned to", () => {
	// Reads answer 404 so an id can't be probed; writes keep the 403.
	it.each(routes)(
		"%s %s refuses an unassigned tech",
		async (method, path, params, check, args) => {
			vi.mocked(check).mockResolvedValue(false);
			const r = await callRoute(jobsRouter, method, path, {
				user: tech,
				params,
				body: { content: "x" },
			});

			const read = method === "get";
			expect(r.status).toBe(read ? 404 : 403);
			expect(r.body.error.code).toBe(read ? "NOT_FOUND" : "FORBIDDEN");
			expect(check).toHaveBeenCalledWith(...args);
		},
	);

	it.each(routes)(
		"%s %s lets an assigned tech through",
		async (method, path, params, check) => {
			vi.mocked(check).mockResolvedValue(true);
			const r = await callRoute(jobsRouter, method, path, {
				user: tech,
				params,
				body: { content: "x" },
			});

			expect(r.status).toBeLessThan(300);
		},
	);

	it.each(routes)(
		"%s %s skips the check for a dispatcher who sees every job",
		async (method, path, params, check) => {
			const r = await callRoute(jobsRouter, method, path, {
				user: dispatcher,
				params,
				body: { content: "x" },
			});

			expect(r.status).toBeLessThan(300);
			expect(check).not.toHaveBeenCalled();
		},
	);

	it("doesn't load the job for an unassigned tech", async () => {
		vi.mocked(techOnJob).mockResolvedValue(false);
		await callRoute(jobsRouter, "get", "/:id", {
			user: tech,
			params: { id: "j1" },
		});

		expect(getJobById).not.toHaveBeenCalled();
	});

	it.each([
		[false, 403],
		[true, 201],
	])("POST note on a body visit_id: assigned=%s gives %i", async (onVisit, status) => {
		vi.mocked(techOnJob).mockResolvedValue(true);
		vi.mocked(techOnVisit).mockResolvedValue(onVisit);
		const r = await callRoute(jobsRouter, "post", "/:jobId/notes", {
			user: tech,
			params: { jobId: "j1" },
			body: { content: "x", visit_id: "v2" },
		});

		expect(r.status).toBe(status);
		expect(techOnVisit).toHaveBeenCalledWith("org-1", "tech-1", "v2");
	});
});

describe("GET /jobs — assignment filter", () => {
	beforeEach(() => vi.mocked(getAllJobs).mockResolvedValue([]));

	it("filters to the tech's jobs when they can only see assigned jobs", async () => {
		await callRoute(jobsRouter, "get", "/", { user: tech });
		expect(getAllJobs).toHaveBeenCalledWith("org-1", "tech-1");
	});

	it.each([["view_jobs"], ["view_all_jobs"]])(
		"returns every job with %s",
		async (perm) => {
			await callRoute(jobsRouter, "get", "/", {
				user: {
					uid: "u1",
					role: "technician",
					permissions: ["view_assigned_jobs", perm],
				},
			});
			expect(getAllJobs).toHaveBeenCalledWith("org-1", undefined);
		},
	);
});

describe("GET /jobs/:jobId/notes — note rule", () => {
	it("an assigned tech gets only job-level notes and notes on their visits", async () => {
		vi.mocked(techOnJob).mockResolvedValue(true);
		await callRoute(jobsRouter, "get", "/:jobId/notes", { user: tech, params: { jobId: "j1" } });
		expect(getJobNotes).toHaveBeenCalledWith("j1", "org-1", "tech-1");
	});

	it("a dispatcher's notes are unfiltered", async () => {
		await callRoute(jobsRouter, "get", "/:jobId/notes", { user: dispatcher, params: { jobId: "j1" } });
		expect(getJobNotes).toHaveBeenCalledWith("j1", "org-1", undefined);
	});
});
