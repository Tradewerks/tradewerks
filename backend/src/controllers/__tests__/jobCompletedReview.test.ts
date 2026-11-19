import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, notifyJob, notifyDone, state, applyStatusChange } = vi.hoisted(() => {
	const state = {
		// The job status change the lifecycle service reports for this transition.
		jobChange: null as { from: string; to: string } | null,
		// The visit as re-read at the end of the transaction.
		row: {} as Record<string, unknown>,
		visitUpdates: [] as unknown[],
	};
	const TO: Record<string, string> = {
		complete: "Completed",
		record_complete: "Completed",
		cancel: "Cancelled",
	};
	// The real service needs Postgres; its pg tests cover the job derivation.
	// The real runPostCommit runs, so the controller → notice wiring is tested.
	const applyStatusChange = vi.fn(
		async (
			_tx: unknown,
			args: { orgId: string; visitId: string; action: string },
		) => ({
			orgId: args.orgId,
			visitId: args.visitId,
			jobId: "j1",
			action: args.action,
			from: (state.row as { status: string }).status,
			to: TO[args.action] ?? "InProgress",
			at: new Date(),
			jobChange: state.jobChange,
			lowStockItemIds: [],
			autoInvoicePlanId: null,
			wrappingUpTechIds: [],
			activatedTechIds: [],
			cancelledTechIds: [],
			suppressCustomerNotice: false,
			cancellationReason: null,
		}),
	);
	const tx = new Proxy(
		{},
		{
			get: (_t, model: string) =>
				model.startsWith("$")
					? vi.fn(async () => [])
					: new Proxy(
					{},
					{
						get: (_m, method: string) =>
							vi.fn(async (args?: unknown) => {
								if (
									model === "job_visit" &&
									method === "update"
								)
									state.visitUpdates.push(args);
								return method === "findMany" ? [] : state.row;
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
		applyStatusChange,
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
	notifyJobCancelled: vi.fn(async () => undefined),
	skipVisitReminders: vi.fn(async () => undefined),
}));
vi.mock("../../services/visitLifecycle/applyStatusChange.js", () => ({
	LifecycleRefusal: class extends Error {},
	syncJobFromVisits: vi.fn(),
	applyStatusChange,
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
		state.jobChange = { from: "InProgress", to: "Completed" };
		const res = await editStatus("Completed");
		expect(res.err).toBe("");
		expect(notifyJob).toHaveBeenCalledTimes(1);
		expect(notifyJob).toHaveBeenCalledWith("j1", "org1");
	});

	it("a visit edit that leaves the job open, or a job already Completed, queues nothing", async () => {
		seed("InProgress");
		state.jobChange = null;
		await editStatus("Completed");
		seed("Completed", "Completed");
		await editStatus("Completed");
		expect(notifyJob).not.toHaveBeenCalled();
	});

	it("cancelling the last open visit when the rest are Completed queues the review request", async () => {
		seed("Scheduled");
		state.jobChange = { from: "Scheduled", to: "Completed" };
		await cancelJobVisit("v1", "not needed", "org1");
		expect(notifyJob).toHaveBeenCalledTimes(1);
		expect(notifyJob).toHaveBeenCalledWith("j1", "org1");
	});

	it("cancelling every visit (job Cancelled) queues nothing", async () => {
		seed("Scheduled", "Scheduled");
		state.jobChange = { from: "Scheduled", to: "Cancelled" };
		await cancelJobVisit("v1", "not needed", "org1");
		expect(notifyJob).not.toHaveBeenCalled();
	});
});

describe("completion summary on visit completion", () => {
	it("a dispatcher setting a visit to Completed queues the summary once; Cancelled or already Completed queues none", async () => {
		seed("InProgress");
		state.jobChange = null;
		await editStatus("Completed");
		expect(notifyDone).toHaveBeenCalledTimes(1);
		expect(notifyDone).toHaveBeenCalledWith("v1", "org1");
		notifyDone.mockClear();

		seed("Completed");
		await editStatus("Completed");
		seed("InProgress");
		await editStatus("Cancelled");
		expect(notifyDone).not.toHaveBeenCalled();
	});
});

describe("changing status by edit", () => {
	const scalarUpdate = () =>
		(state.visitUpdates[0] as { data: Record<string, unknown> }).data;

	it("hands the transition to the lifecycle service, which owns status and stamps", async () => {
		state.visitUpdates = [];
		seed("InProgress");
		state.jobChange = null;
		await editStatus("Completed");
		expect(applyStatusChange).toHaveBeenCalledTimes(1);
		expect(applyStatusChange.mock.calls[0][1]).toMatchObject({
			orgId: "org1",
			visitId: "v1",
			action: "complete",
		});
		expect(scalarUpdate()).not.toHaveProperty("status");
		expect(scalarUpdate()).not.toHaveProperty("actual_end_at");
	});

	it("an unchanged status is not a transition, and a move with no edge is refused before any write", async () => {
		seed("Completed");
		await editStatus("Completed");
		expect(applyStatusChange).not.toHaveBeenCalled();

		seed("Scheduled");
		const res = await editStatus("OnSite");
		expect(res).toMatchObject({
			err: "Can't move a visit from Scheduled to OnSite.",
			code: "WRONG_STATE",
		});
		expect(sdb.$transaction).toHaveBeenCalledTimes(1);
	});
});
