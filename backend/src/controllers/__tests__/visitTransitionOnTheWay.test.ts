import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, notifyTech, notifyJob, emitToOrg, state } = vi.hoisted(() => {
	const model = () =>
		new Proxy(
			{},
			{
				get: (_t, method: string) =>
					vi.fn(async () => (method === "findMany" ? [] : {})),
			},
		);
	const sdb = {
		job_visit: { findFirst: vi.fn(), findUnique: vi.fn() },
		job_visit_technician: { findUnique: vi.fn(), update: vi.fn() },
		technician: { findMany: vi.fn(async () => []), update: vi.fn() },
		visit_tech_time_entry: { findFirst: vi.fn(async () => null) },
		visit_tech_drive: { updateMany: vi.fn(), create: vi.fn() },
		$transaction: vi.fn(),
	};
	return {
		sdb,
		model,
		notifyTech: vi.fn(async () => undefined),
		notifyJob: vi.fn(async () => undefined),
		emitToOrg: vi.fn(),
		state: { model },
	};
});

const done = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: notifyJob,
	notifyVisitCompleted: done,
	notifyTechOnTheWay: notifyTech,
}));
vi.mock("../../db.js", () => ({
	db: {
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
			fn(new Proxy({}, { get: () => state.model() })),
		),
	},
}));
// The transition's DB work is the service's (covered by its pg suite); these
// tests drive the real post-commit runner with the effects it would return.
vi.mock("../../services/visitLifecycle/applyStatusChange.js", () => {
	class LifecycleRefusal extends Error {
		constructor(
			public code: string,
			message: string,
		) {
			super(message);
		}
	}
	const TO: Record<string, string> = {
		drive: "Driving",
		arrive: "OnSite",
		complete: "Completed",
		delay: "Delayed",
		recall: "Scheduled",
	};
	return {
		LifecycleRefusal,
		syncJobFromVisits: vi.fn(async () => null),
		applyStatusChange: vi.fn(
			async (
				_tx: unknown,
				args: {
					orgId: string;
					visitId: string;
					action: string;
					actingTechIds?: string[];
				},
			) => ({
				orgId: args.orgId,
				visitId: args.visitId,
				jobId: "j1",
				action: args.action,
				from: "Scheduled",
				to: TO[args.action],
				at: new Date(),
				// The fake job has only this visit, so completing it completes the job.
				jobChange:
					args.action === "complete"
						? { from: "InProgress", to: "Completed" }
						: null,
				lowStockItemIds: [],
				autoInvoicePlanId: null,
				wrappingUpTechIds: [],
				activatedTechIds:
					args.action === "drive" || args.action === "arrive"
						? [...(args.actingTechIds ?? [])]
						: [],
				cancelledTechIds: [],
				suppressCustomerNotice: false,
				cancellationReason: null,
			}),
		),
	};
});
vi.mock("../../services/wrappingUpTimer.js", () => ({
	scheduleWrappingUpClear: vi.fn(),
	cancelWrappingUpTimer: vi.fn(),
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
vi.mock("../../services/socketService.js", () => ({ emitToOrg }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { applyVisitTransition } from "../jobVisitsController.js";

const visit = (status: string) => ({
	id: "v1",
	job_id: "j1",
	name: "Visit",
	scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
	status,
	actual_start_at: null,
	job: {
		id: "j1",
		job_number: 7,
		status: "Scheduled",
		coords: null,
		client: { name: "Acme" },
		quote: null,
	},
	visit_techs: [{ tech_id: "t1", tech: { name: "Ann" } }],
	line_items: [],
	notes: [],
});

function setup(status: string) {
	const v = visit(status);
	sdb.job_visit.findFirst.mockResolvedValue(v);
	sdb.job_visit.findUnique.mockResolvedValue(v);
	sdb.job_visit_technician.findUnique.mockResolvedValue({
		tech_status: "Assigned",
	});
	sdb.technician.findMany.mockResolvedValue([{ id: "t1" }] as never);
	sdb.$transaction.mockImplementation(async (arg: unknown) =>
		typeof arg === "function"
			? (arg as (tx: unknown) => unknown)(
					new Proxy({}, { get: () => state.model() }),
				)
			: [],
	);
}

describe("applyVisitTransition on-the-way hook", () => {
	beforeEach(() => vi.clearAllMocks());

	it("drive queues the notice after the status emit, without waiting for it", async () => {
		setup("Scheduled");
		const res = await applyVisitTransition("v1", "drive", "org1", {
			techId: "t1",
		} as never);
		expect(res.err).toBe("");
		expect(notifyTech).toHaveBeenCalledWith("v1", "t1", "org1");
		expect(emitToOrg.mock.invocationCallOrder[0]).toBeLessThan(
			notifyTech.mock.invocationCallOrder[0],
		);
	});

	it("a dispatcher-initiated drive still queues the notice", async () => {
		setup("Scheduled");
		await applyVisitTransition("v1", "drive", "org1", {
			dispatcherId: "d1",
		} as never);
		expect(notifyTech).toHaveBeenCalledWith("v1", "t1", "org1");
		sdb.technician.findMany.mockResolvedValue([]);
		notifyTech.mockClear();
		await applyVisitTransition("v1", "drive", "org1", {
			dispatcherId: "d1",
		} as never);
		expect(notifyTech).toHaveBeenCalledWith("v1", undefined, "org1");
	});

	it.each([
		["arrive", "Driving"],
		["complete", "InProgress"],
		["delay", "Scheduled"],
	] as const)("%s does not queue the notice", async (action, status) => {
		setup(status);
		const res = await applyVisitTransition(
			"v1",
			action,
			"org1",
			action === "delay"
				? ({ dispatcherId: "d1" } as never)
				: ({ techId: "t1" } as never),
		);
		expect(res.err).toBe("");
		expect(notifyTech).not.toHaveBeenCalled();
	});

	it("a secondary tech's drive on an already-driving visit does not queue the notice", async () => {
		setup("Driving");
		// The secondary write locks the visit, then writes assignment and tech.
		sdb.$transaction.mockImplementation(async (arg: unknown) =>
			(arg as (tx: unknown) => unknown)({
				$queryRaw: vi.fn(async () => [{ status: "Driving" }]),
				job_visit_technician: sdb.job_visit_technician,
				technician: sdb.technician,
			}),
		);
		const res = await applyVisitTransition("v1", "drive", "org1", {
			techId: "t1",
		} as never);
		expect(res.err).toBe("");
		expect(sdb.job_visit_technician.update).toHaveBeenCalled();
		expect(notifyTech).not.toHaveBeenCalled();
	});

	it("a rejecting notifyTechOnTheWay does not affect the response", async () => {
		setup("Scheduled");
		notifyTech.mockRejectedValueOnce(new Error("boom"));
		const res = await applyVisitTransition("v1", "drive", "org1", {
			techId: "t1",
		} as never);
		expect(res.err).toBe("");
		expect(res.item).toBeDefined();
	});
});

describe("applyVisitTransition review request hook", () => {
	beforeEach(() => vi.clearAllMocks());

	it("completing the job's last visit queues the review request for the job", async () => {
		// The transaction fake has no other visits, so this one completes the job.
		setup("InProgress");
		const res = await applyVisitTransition("v1", "complete", "org1", {
			techId: "t1",
		} as never);
		expect(res.err).toBe("");
		expect(notifyJob).toHaveBeenCalledWith("j1", "org1");
	});
});

describe("applyVisitTransition completion summary hook", () => {
	beforeEach(() => vi.clearAllMocks());

	it("complete queues the completion summary; other actions do not", async () => {
		setup("InProgress");
		await applyVisitTransition("v1", "complete", "org1", {
			techId: "t1",
		} as never);
		expect(done).toHaveBeenCalledWith("v1", "org1");
		done.mockClear();
		setup("Driving");
		await applyVisitTransition("v1", "arrive", "org1", {
			techId: "t1",
		} as never);
		expect(done).not.toHaveBeenCalled();
	});
});
