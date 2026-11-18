import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, notifyJob, notifyDone, state } = vi.hoisted(() => {
	const state = {
		// What the transaction sees for the job's visits after this change.
		visits: [] as { status: string; total: number }[],
		// The visit as re-read at the end of the transaction.
		row: {} as Record<string, unknown>,
		visitUpdates: [] as unknown[],
	};
	const tx = new Proxy(
		{},
		{
			get: (_t, model: string) =>
				new Proxy(
					{},
					{
						get: (_m, method: string) =>
							vi.fn(async (args?: unknown) => {
								if (
									model === "job_visit" &&
									method === "update"
								)
									state.visitUpdates.push(args);
								return model === "job_visit" &&
									method === "findMany"
									? state.visits
									: method === "findMany"
										? []
										: state.row;
							}),
					},
				),
		},
	);
	const sdb = {
		job_visit: { findFirst: vi.fn() },
		invoice_schedule: { findFirst: vi.fn(async () => null) },
		$transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
	};
	return {
		sdb,
		notifyJob: vi.fn(async () => undefined),
		notifyDone: vi.fn(async () => undefined),
		state,
	};
});

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: notifyJob,
	notifyVisitCompleted: notifyDone,
	notifyTechOnTheWay: vi.fn(async () => undefined),
}));
vi.mock("../../db.js", () => ({
	db: { organization: { findUniqueOrThrow: vi.fn() } },
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn().mockResolvedValue(true),
}));
vi.mock("../notificationsController.js", () => ({
	createNotification: vi.fn(),
	notifyDispatchers: vi.fn(async () => undefined),
}));
vi.mock("../../services/followupTriggers.js", () => ({
	onVisitScheduled: vi.fn().mockResolvedValue(undefined),
	onVisitRescheduled: vi.fn().mockResolvedValue(undefined),
	onVisitCancelled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));
vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(
		(before: Record<string, unknown>, after: Record<string, unknown>) =>
			after.status && after.status !== before.status
				? { status: { old: before.status, new: after.status } }
				: {},
	),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cancelJobVisit, updateJobVisit } from "../jobVisitsController.js";

const visit = (status: string, jobStatus = "InProgress") => ({
	id: "v1",
	job_id: "j1",
	status,
	scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
	job: {
		id: "j1",
		status: jobStatus,
		job_number: "J-1",
		recurring_plan_id: null,
		client: { name: "Acme" },
	},
	line_items: [],
	visit_techs: [{ tech_id: "t1" }],
});

function seed(status: string, jobStatus = "InProgress") {
	const v = visit(status, jobStatus);
	sdb.job_visit.findFirst.mockResolvedValue(v);
	state.row = v;
}

const editStatus = (status: string) =>
	updateJobVisit(
		{ params: { id: "v1" }, body: { status } } as never,
		"org1",
		{ dispatcherId: "d1" } as never,
	);

beforeEach(() => vi.clearAllMocks());

describe("review request on job completion", () => {
	it("a dispatcher setting the last open visit to Completed queues the review request", async () => {
		seed("InProgress");
		state.visits = [
			{ status: "Completed", total: 100 },
			{ status: "Completed", total: 50 },
		];
		const res = await editStatus("Completed");
		expect(res.err).toBe("");
		expect(notifyJob).toHaveBeenCalledWith("j1", "org1");
	});

	it("a visit edit that leaves the job open, or a job already Completed, queues nothing", async () => {
		seed("InProgress");
		state.visits = [
			{ status: "Completed", total: 100 },
			{ status: "Scheduled", total: 50 },
		];
		await editStatus("Completed");
		seed("Completed", "Completed");
		state.visits = [{ status: "Completed", total: 100 }];
		await editStatus("Completed");
		expect(notifyJob).not.toHaveBeenCalled();
	});

	it("cancelling the last open visit when the rest are Completed queues the review request", async () => {
		seed("Scheduled");
		state.visits = [
			{ status: "Completed", total: 100 },
			{ status: "Cancelled", total: 0 },
		];
		await cancelJobVisit("v1", "not needed", "org1");
		expect(notifyJob).toHaveBeenCalledWith("j1", "org1");
	});

	it("cancelling every visit (job Cancelled) queues nothing", async () => {
		seed("Scheduled", "Scheduled");
		state.visits = [{ status: "Cancelled", total: 0 }];
		await cancelJobVisit("v1", "not needed", "org1");
		expect(notifyJob).not.toHaveBeenCalled();
	});
});

describe("completion summary on visit completion", () => {
	it("a dispatcher setting a visit to Completed queues the summary once; Cancelled or already Completed queues none", async () => {
		seed("InProgress");
		state.visits = [
			{ status: "Completed", total: 100 },
			{ status: "Scheduled", total: 50 },
		];
		await editStatus("Completed");
		expect(notifyDone).toHaveBeenCalledWith("v1", "org1");
		notifyDone.mockClear();

		seed("Completed");
		await editStatus("Completed");
		seed("InProgress");
		await editStatus("Cancelled");
		expect(notifyDone).not.toHaveBeenCalled();
	});
});

describe("completing a visit by status edit", () => {
	const scalarUpdate = () =>
		(state.visitUpdates[0] as { data: Record<string, unknown> }).data;

	it("stamps actual_end_at (and a missing actual_start_at) like the complete action", async () => {
		state.visitUpdates = [];
		seed("InProgress");
		state.visits = [{ status: "Completed", total: 100 }];
		const before = Date.now();
		await editStatus("Completed");
		const data = scalarUpdate();
		expect(data.status).toBe("Completed");
		expect((data.actual_end_at as Date).getTime()).toBeGreaterThanOrEqual(
			before,
		);
		expect(data.actual_start_at).toBeInstanceOf(Date);
	});

	it("keeps an existing actual_end_at and stamps nothing for other statuses", async () => {
		state.visitUpdates = [];
		const ended = new Date("2026-11-18T15:00:00Z");
		seed("InProgress");
		sdb.job_visit.findFirst.mockResolvedValue({
			...visit("InProgress"),
			actual_start_at: ended,
			actual_end_at: ended,
		});
		state.visits = [{ status: "Completed", total: 100 }];
		await editStatus("Completed");
		expect(scalarUpdate()).not.toHaveProperty("actual_end_at");
		expect(scalarUpdate()).not.toHaveProperty("actual_start_at");

		state.visitUpdates = [];
		seed("Scheduled");
		await editStatus("OnSite");
		expect(scalarUpdate()).not.toHaveProperty("actual_end_at");
	});
});
