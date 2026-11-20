import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ techId: "tech-1" }),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) =>
		next(),
}));
vi.mock("../../controllers/jobsController.js", () => ({
	techOnJob: vi.fn(),
	techOnVisit: vi.fn(async () => false),
	techOnNote: vi.fn(),
}));
vi.mock("../../controllers/jobVisitsController.js", () => ({
	getAllJobVisits: vi.fn(),
	getMyJobsForPurchase: vi.fn(),
	getJobVisitById: vi.fn(),
	getJobVisitsByDateRange: vi.fn(),
	insertJobVisit: vi.fn(),
	updateJobVisit: vi.fn(),
	assignTechniciansToVisit: vi.fn(),
	acceptJobVisit: vi.fn(),
	cancelJobVisit: vi.fn(),
	deleteJobVisit: vi.fn(),
	applyVisitTransition: vi.fn(),
	LIFECYCLE_TRANSITIONS: {},
	getRecentStatusEvents: vi.fn(),
}));
vi.mock("../../controllers/visitTimeEntriesController.js", () => ({
	clockInVisit: vi.fn(),
	clockOutVisit: vi.fn(),
}));
vi.mock("../../controllers/vehiclesController.js", () => ({
	addPartsUsed: vi.fn(),
	updatePartsUsedQty: vi.fn(),
}));

import jobVisitsRouter from "../jobVisits.js";
import { techOnVisit } from "../../controllers/jobsController.js";
import * as visits from "../../controllers/jobVisitsController.js";
import {
	clockInVisit,
	clockOutVisit,
} from "../../controllers/visitTimeEntriesController.js";
import {
	addPartsUsed,
	updatePartsUsedQty,
} from "../../controllers/vehiclesController.js";
import { callRoute } from "./harness.js";
import { getUserContext } from "../../lib/context.js";

const tech = {
	uid: "tech-1",
	role: "technician",
	permissions: [
		"view_assigned_jobs",
		"update_visit_status",
		"check_in",
		"check_out",
		"use_inventory",
	],
};
const dispatcher = {
	uid: "disp-1",
	role: "dispatcher",
	permissions: ["view_jobs", "edit_jobs"],
};

const routes = [
	["get", "/:id", visits.getJobVisitById],
	["post", "/:id/clock-in", clockInVisit],
	["post", "/:id/clock-out", clockOutVisit],
	["post", "/:id/start", visits.applyVisitTransition],
	["post", "/:id/pause", visits.applyVisitTransition],
	["post", "/:id/resume", visits.applyVisitTransition],
	["post", "/:id/complete", visits.applyVisitTransition],
	["post", "/:id/delay", visits.applyVisitTransition],
	["post", "/:id/parts-used", addPartsUsed],
	["patch", "/:id/parts-used/:lineItemId", updatePartsUsedQty],
	["post", "/:id/transition", visits.applyVisitTransition],
] as const;

beforeEach(() => vi.clearAllMocks());

// Dispatcher-only: a technician is refused by the permission gate before the assignment check.
const dispatcherOnly = [
	["put", "/:id", visits.updateJobVisit],
	["post", "/:id/cancel", visits.cancelJobVisit],
] as const;

describe("job-visit routes — dispatcher-only writes", () => {
	it.each(dispatcherOnly)("%s %s returns 403 for any tech", async (method, path, handler) => {
		const r = await callRoute(jobVisitsRouter, method, path, { user: tech, params: { id: "v1" } });

		expect(r.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("job-visit routes — technicians only act on visits they're assigned to", () => {
	it.each(routes)(
		"%s %s returns 403 for an unassigned tech",
		async (method, path, handler) => {
			const r = await callRoute(jobVisitsRouter, method, path, {
				user: tech,
				params: { id: "v1", lineItemId: "li1" },
			});

			expect(r.status).toBe(403);
			expect(r.body.error.message).toBe(
				"You're not assigned to this visit",
			);
			expect(techOnVisit).toHaveBeenCalledWith("org-1", "tech-1", "v1");
			expect(handler).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s %s skips the check for a dispatcher",
		async (method, path) => {
			await callRoute(jobVisitsRouter, method, path, {
				user: dispatcher,
				params: { id: "v1", lineItemId: "li1" },
			}).catch(() => undefined);

			expect(techOnVisit).not.toHaveBeenCalled();
		},
	);
});

describe("job-visit list routes — assignment filter", () => {
	beforeEach(() => {
		vi.mocked(visits.getAllJobVisits).mockResolvedValue([]);
		vi.mocked(visits.getJobVisitsByDateRange).mockResolvedValue([]);
		vi.mocked(visits.getRecentStatusEvents).mockResolvedValue([]);
	});

	const call = (user: object) =>
		Promise.all([
			callRoute(jobVisitsRouter, "get", "/", { user }),
			callRoute(
				jobVisitsRouter,
				"get",
				"/date-range/:startDate/:endDate",
				{
					user,
					params: { startDate: "2026-11-01", endDate: "2026-11-30" },
				},
			),
			callRoute(jobVisitsRouter, "get", "/recent-status-events", {
				user,
			}),
		]);

	it("filters to the tech's visits when they can only see assigned jobs", async () => {
		await call(tech);
		expect(visits.getAllJobVisits).toHaveBeenCalledWith("org-1", {
			techId: "tech-1",
		});
		expect(visits.getJobVisitsByDateRange).toHaveBeenCalledWith(
			expect.any(Date),
			expect.any(Date),
			"org-1",
			"tech-1",
		);
		expect(visits.getRecentStatusEvents).toHaveBeenCalledWith(
			"org-1",
			"tech-1",
		);
	});

	it.each([["view_jobs"], ["view_visits"]])(
		"returns every visit with %s",
		async (perm) => {
			await call({
				uid: "u1",
				role: "technician",
				permissions: ["view_assigned_jobs", perm],
			});
			expect(visits.getAllJobVisits).toHaveBeenCalledWith("org-1", {
				techId: undefined,
			});
			expect(visits.getJobVisitsByDateRange).toHaveBeenCalledWith(
				expect.any(Date),
				expect.any(Date),
				"org-1",
				undefined,
			);
			expect(visits.getRecentStatusEvents).toHaveBeenCalledWith(
				"org-1",
				undefined,
			);
		},
	);
});

describe("job-visit routes — technicians only accept and clock for themselves", () => {
	const admin = { uid: "admin-1", role: "admin", permissions: null };

	it("refuses a tech accepting a visit for another tech", async () => {
		const r = await callRoute(jobVisitsRouter, "post", "/:id/accept", {
			user: tech,
			params: { id: "v1" },
			body: { tech_id: "tech-2" },
		});
		expect(r.status).toBe(403);
		expect(r.body.error.message).toBe("Technicians can only act as themselves.");
		expect(visits.acceptJobVisit).not.toHaveBeenCalled();
	});

	it("lets an admin accept a visit for any tech", async () => {
		vi.mocked(getUserContext).mockReturnValueOnce({ dispatcherId: "admin-1" });
		vi.mocked(visits.acceptJobVisit).mockResolvedValueOnce({ err: "", item: {} } as never);
		const r = await callRoute(jobVisitsRouter, "post", "/:id/accept", {
			user: admin,
			params: { id: "v1" },
			body: { tech_id: "tech-2" },
		});
		expect(r.status).toBe(200);
		expect(visits.acceptJobVisit).toHaveBeenCalledWith("v1", "tech-2", "org-1", { dispatcherId: "admin-1" });
	});

	it.each([
		["/:id/clock-in", clockInVisit, "Technicians can only act as themselves."],
		["/:id/clock-out", clockOutVisit, "Technicians can only act as themselves."],
	] as const)("%s refuses a tech clocking a teammate", async (path, handler, message) => {
		vi.mocked(techOnVisit).mockResolvedValueOnce(true);
		const r = await callRoute(jobVisitsRouter, "post", path, {
			user: tech,
			params: { id: "v1" },
			body: { tech_id: "tech-2" },
		});
		expect(r.status).toBe(403);
		expect(r.body.error.message).toBe(message);
		expect(handler).not.toHaveBeenCalled();
	});
});
