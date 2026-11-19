/**
 * Tests for inventory consumption triggered by job visit status changes.
 * Under the ledger model, consumption fires exactly once per visit, on its
 * Completed transition — there is no job-level deduction mode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateJobVisit } from "../jobVisitsController.js";
import { db } from "../../db.js";
import { applyStatusChange } from "../../services/visitLifecycle/applyStatusChange.js";
import { recordMovements } from "../../services/stockMovements.js";
import type { Request } from "express";

// Module gating is not under test here: every module reads as on.
vi.mock("../../services/customerComms/visitEvents.js", () => ({
	notifyVisitScheduled: vi.fn(async () => undefined),
	notifyVisitRescheduled: vi.fn(async () => undefined),
	notifyVisitCancelled: vi.fn(async () => undefined),
	retimeVisitReminders: vi.fn(async () => undefined),
	notifyJobCompleted: vi.fn(async () => undefined),
	notifyVisitCompleted: vi.fn(async () => undefined),
	notifyTechOnTheWay: vi.fn(async () => undefined),
}));
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job_visit: { findFirst: vi.fn(), findUnique: vi.fn() },
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));

vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));

// Mock deductInventoryForVisit so we can assert when/how it's called (for updateJobVisit tests)
vi.mock("../inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));

// Notices after commit are covered by postCommit.test.ts.
vi.mock("../../services/visitLifecycle/postCommit.js", () => ({
	runPostCommit: vi.fn(),
}));

// Completion (and its stock deduction) belongs to the lifecycle service; its
// pg tests cover the deduct-once guarantee. Here: the PUT hands it over.
vi.mock("../../services/visitLifecycle/applyStatusChange.js", () => ({
	LifecycleRefusal: class extends Error {},
	syncJobFromVisits: vi.fn(),
	applyStatusChange: vi.fn(async (_tx: unknown, args: { orgId: string; visitId: string; action: string }) => ({
		orgId: args.orgId,
		visitId: args.visitId,
		jobId: "job-1",
		action: args.action,
		from: "Scheduled",
		to: "Completed",
		at: new Date(),
		jobChange: null,
		lowStockItemIds: [],
		autoInvoicePlanId: null,
		wrappingUpTechIds: [],
		activatedTechIds: [],
		cancelledTechIds: [],
		suppressCustomerNotice: false,
		cancellationReason: null,
	})),
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

const mockDb = vi.mocked(db);
const mockApply = vi.mocked(applyStatusChange);
const dispatcher = { dispatcherId: "d-1" };

function makeRequest(visitId: string, body: object): Request {
	return { params: { id: visitId }, body } as unknown as Request;
}

function makeExistingVisit(status: string, jobStatus: string) {
	return {
		id: "visit-1",
		job_id: "job-1",
		status,
		name: "Visit 1",
		description: "",
		arrival_constraint: null,
		finish_constraint: null,
		scheduled_start_at: null,
		scheduled_end_at: null,
		arrival_time: null,
		arrival_window_start: null,
		arrival_window_end: null,
		finish_time: null,
		actual_start_at: null,
		actual_end_at: null,
		job: {
			id: "job-1",
			status: jobStatus,
		},
	};
}

// Sets up $transaction to execute the callback with a mock tx
function setupTransaction(allVisits: { id: string; status: string }[]) {
	const updatedVisit = {
		id: "visit-1",
		job_id: "job-1",
		status: "Completed",
		scheduled_start_at: new Date(),
		job: { id: "job-1", client: {} },
		visit_techs: [],
		notes: [],
	};
	const mockTx = {
		$queryRaw: vi.fn().mockResolvedValue([]),
		job_visit: {
			update: vi.fn().mockResolvedValue(updatedVisit),
			findMany: vi.fn().mockResolvedValue(allVisits),
			findUnique: vi.fn().mockResolvedValue(updatedVisit),
			findFirst: vi.fn().mockResolvedValue(updatedVisit),
		},
		job: {
			update: vi.fn().mockResolvedValue(undefined),
		},
		job_visit_line_item: {
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockTx) => unknown) =>
		fn(mockTx),
	);
	return mockTx;
}

describe("updateJobVisit — completion goes through the lifecycle service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hands exactly one completion of this visit to the service when it is marked Completed", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Scheduled", "InProgress") as any,
		);
		setupTransaction([{ id: "visit-1", status: "Completed" }]);

		await updateJobVisit(makeRequest("visit-1", { status: "Completed" }), "org-1", dispatcher);

		expect(mockApply).toHaveBeenCalledOnce();
		expect(mockApply).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ visitId: "visit-1", action: "record_complete" }),
		);
	});

	it("does not complete again if the visit was already Completed before this update", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Completed", "InProgress") as any,
		);
		setupTransaction([{ id: "visit-1", status: "Completed" }]);

		await updateJobVisit(makeRequest("visit-1", { status: "Completed" }), "org-1", dispatcher);

		expect(mockApply).not.toHaveBeenCalled();
	});

	it("refuses a status move with no lifecycle edge before any write", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Scheduled", "Scheduled") as any,
		);
		setupTransaction([{ id: "visit-1", status: "InProgress" }]);

		const res = await updateJobVisit(makeRequest("visit-1", { status: "InProgress" }), "org-1", dispatcher);

		expect(res).toMatchObject({ code: "WRONG_STATE" });
		expect(mockApply).not.toHaveBeenCalled();
		expect(mockDb.$transaction).not.toHaveBeenCalled();
	});
});

// Unit tests for deductInventoryForVisit function
describe("deductInventoryForVisit", async () => {
	// Import the real implementation for these unit tests
	const { deductInventoryForVisit: realDeductInventoryForVisit } = await vi.importActual<typeof import("../inventoryController.js")>("../inventoryController.js");
	const mockRecordMovements = vi.mocked(recordMovements);

	type LineItem = { id: string; visit_id: string; inventory_item_id: string; quantity: number };

	function makeTx(lineItems: LineItem[]) {
		return {
			job_visit_line_item: {
				findMany: vi.fn().mockResolvedValue(lineItems),
				updateMany: vi.fn().mockResolvedValue({ count: lineItems.length }),
			},
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("marks consumed line items used so a re-completion does not double-deduct", async () => {
		// tx.job_visit_line_item.findMany → one line {id:"li-1", inventory_item_id:"inv-1", quantity:2}
		const tx = makeTx([
			{ id: "li-1", visit_id: "visit-1", inventory_item_id: "inv-1", quantity: 2 },
		]);

		mockRecordMovements.mockResolvedValueOnce({ lowStockItemIds: [] });

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		await realDeductInventoryForVisit("visit-1", tx as any, "org-1", { dispatcherId: "d-1" });

		expect(tx.job_visit_line_item.updateMany).toHaveBeenCalledWith({
			where: { id: { in: ["li-1"] } },
			data: { fulfillment_status: "used" },
		});
	});
});
