/**
 * Controller-level guards from the final review wave: visit delete re-derives
 * its job, PUT can't cancel, technicians are refused even when a caller skips
 * the route, accept 404s and locks, and a closed visit gets no secondary
 * drive/arrive. The lifecycle service is faked; its own suites cover it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, life } = vi.hoisted(() => {
	const sdb = {
		job_visit: { findFirst: vi.fn(), findUnique: vi.fn(), delete: vi.fn() },
		job_note_photo: { findMany: vi.fn(async () => []) },
		job_visit_technician: {
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			deleteMany: vi.fn(),
			createMany: vi.fn(),
			update: vi.fn(),
		},
		technician: {
			findFirst: vi.fn(),
			findMany: vi.fn(async () => []),
			update: vi.fn(),
		},
		visit_tech_time_entry: { findFirst: vi.fn(async () => null) },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
	};
	class LifecycleRefusal extends Error {
		constructor(
			public code: string,
			message: string,
		) {
			super(message);
			this.name = "LifecycleRefusal";
		}
	}
	const life = {
		LifecycleRefusal,
		applyStatusChange: vi.fn(),
		runPostCommit: vi.fn(async () => undefined),
		runJobChangePostCommit: vi.fn(async () => undefined),
		syncJobFromVisits: vi.fn(),
	};
	return { sdb, life };
});

vi.mock("../../services/visitLifecycle/index.js", () => life);
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../db.js", () => ({ db: sdb }));
vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
}));
vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn(),
	notifyDispatchers: vi.fn(async () => undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn(),
	onVisitRescheduled: vi.fn(),
}));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));

import {
	acceptJobVisit,
	applyVisitTransition,
	deleteJobVisit,
	updateJobVisit,
} from "../jobVisitsController.js";
import { emitToOrg } from "../../services/socketService.js";
import type { Request } from "express";

const visitRow = (status: string) => ({
	id: "v1",
	job_id: "j1",
	name: "Visit",
	description: null,
	status,
	scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
	scheduled_end_at: new Date("2026-11-18T15:00:00Z"),
	updated_at: new Date("2026-11-18T10:00:00Z"),
	job: { id: "j1", status: "InProgress", client: { name: "Acme" } },
	visit_techs: [
		{ tech_id: "t1", tech_status: "Assigned", tech: { name: "Ann" } },
	],
	line_items: [],
});

beforeEach(() => {
	vi.clearAllMocks();
	sdb.$transaction.mockImplementation(async (arg: unknown) =>
		typeof arg === "function" ? (arg as (tx: unknown) => unknown)(sdb) : [],
	);
});

describe("deleteJobVisit", () => {
	it("re-derives the job in the delete's transaction and runs its post-commit after", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Scheduled"));
		const change = { from: "InProgress", to: "Completed" };
		const order: string[] = [];
		sdb.job_visit.delete.mockImplementation(async () =>
			order.push("delete"),
		);
		life.syncJobFromVisits.mockImplementation(async () => {
			order.push("sync");
			return change;
		});
		life.runJobChangePostCommit.mockImplementation(async () => {
			order.push("postCommit");
		});

		const res = await deleteJobVisit("v1", "org1", { dispatcherId: "d1" });

		expect(res.err).toBe("");
		expect(order).toEqual(["delete", "sync", "postCommit"]);
		expect(life.syncJobFromVisits).toHaveBeenCalledWith(sdb, "org1", "j1", {
			context: { dispatcherId: "d1" },
		});
		expect(life.runJobChangePostCommit).toHaveBeenCalledWith(
			{ orgId: "org1", jobId: "j1", change },
			{ dispatcherId: "d1" },
		);
		// The visit's lock comes before any of its rows are touched.
		expect(sdb.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			sdb.job_visit_technician.deleteMany.mock.invocationCallOrder[0],
		);
	});

	it("no job change, no job post-commit", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Scheduled"));
		life.syncJobFromVisits.mockResolvedValue(null);
		const res = await deleteJobVisit("v1", "org1", { dispatcherId: "d1" });
		expect(res.err).toBe("");
		expect(life.runJobChangePostCommit).not.toHaveBeenCalled();
		expect(emitToOrg).toHaveBeenCalledWith(
			"org1",
			"job_visit:deleted",
			expect.anything(),
		);
	});
});

describe("updateJobVisit", () => {
	const req = (body: unknown) =>
		({ params: { id: "v1" }, body }) as unknown as Request;

	it("refuses a technician context with FORBIDDEN, before reading the visit", async () => {
		const res = await updateJobVisit(req({ name: "x" }), "org1", {
			techId: "t1",
		});
		expect(res).toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
		expect(sdb.job_visit.findFirst).not.toHaveBeenCalled();
	});

	it("a PUT that moves a visit to Cancelled is WRONG_STATE, pointing at the cancel endpoint", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Scheduled"));
		const res = await updateJobVisit(req({ status: "Cancelled" }), "org1", {
			dispatcherId: "d1",
		});
		expect(res).toEqual(
			expect.objectContaining({
				code: "WRONG_STATE",
				err: "Use POST /job-visits/:id/cancel to cancel a visit.",
			}),
		);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});
});

describe("acceptJobVisit", () => {
	it("an unknown visit is NOT_FOUND", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(null);
		const res = await acceptJobVisit("v1", "t1", "org1", { techId: "t1" });
		expect(res).toEqual(expect.objectContaining({ code: "NOT_FOUND" }));
	});

	it("a deactivated technician is not found", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Scheduled"));
		sdb.technician.findFirst.mockResolvedValue(null);
		const res = await acceptJobVisit("v1", "t1", "org1", { techId: "t1" });
		expect(res).toEqual(expect.objectContaining({ code: "NOT_FOUND" }));
		expect(sdb.technician.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "t1", deactivated_at: null },
			}),
		);
	});

	it("locks the visit first and refuses one that closed after the unlocked read", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Scheduled"));
		sdb.technician.findFirst.mockResolvedValue({ id: "t1" });
		sdb.job_visit_technician.findFirst.mockResolvedValue(null);
		sdb.$queryRaw.mockResolvedValue([{ status: "Cancelled" }]);
		const res = await acceptJobVisit("v1", "t1", "org1", { techId: "t1" });
		expect(res).toEqual(expect.objectContaining({ code: "WRONG_STATE" }));
		expect(sdb.job_visit_technician.createMany).not.toHaveBeenCalled();
	});
});

describe("applyVisitTransition on a closed visit", () => {
	it.each(["drive", "arrive"] as const)(
		"a tech's %s on a Completed visit is WRONG_STATE and writes nothing",
		async (action) => {
			sdb.job_visit.findFirst.mockResolvedValue(visitRow("Completed"));
			const res = await applyVisitTransition("v1", action, "org1", {
				techId: "t1",
			});
			expect(res).toEqual(
				expect.objectContaining({ code: "WRONG_STATE" }),
			);
			expect(sdb.job_visit_technician.update).not.toHaveBeenCalled();
			expect(sdb.technician.update).not.toHaveBeenCalled();
			expect(life.applyStatusChange).not.toHaveBeenCalled();
		},
	);

	it("a second complete goes to the service, whose refusal comes back with its code", async () => {
		sdb.job_visit.findFirst.mockResolvedValue(visitRow("Completed"));
		life.applyStatusChange.mockRejectedValue(
			new life.LifecycleRefusal(
				"WRONG_STATE",
				"This visit is already Completed.",
			),
		);
		const res = await applyVisitTransition("v1", "complete", "org1", {
			techId: "t1",
		});
		expect(life.applyStatusChange).toHaveBeenCalled();
		expect(res).toEqual(expect.objectContaining({ code: "WRONG_STATE" }));
	});
});
