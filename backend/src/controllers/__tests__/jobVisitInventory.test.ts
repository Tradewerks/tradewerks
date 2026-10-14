/**
 * Tests for inventory consumption triggered by job visit status changes.
 * Under the ledger model, consumption fires exactly once per visit, on its
 * Completed transition — there is no job-level deduction mode.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateJobVisit } from "../jobVisitsController.js";
import { db } from "../../db.js";
import { deductInventoryForVisit } from "../inventoryController.js";
import { recordMovements } from "../../services/stockMovements.js";
import type { Request } from "express";

// Module gating is not under test here: every module reads as on.
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

vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));

// Mock deductInventoryForVisit so we can assert when/how it's called (for updateJobVisit tests)
vi.mock("../inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

const mockDb = vi.mocked(db);
const mockDeduct = vi.mocked(deductInventoryForVisit);

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
		status: "Completed",
		job: { id: "job-1", client: {} },
		visit_techs: [],
		notes: [],
	};
	const mockTx = {
		job_visit: {
			update: vi.fn().mockResolvedValue(updatedVisit),
			findMany: vi.fn().mockResolvedValue(allVisits),
			findUnique: vi.fn().mockResolvedValue(updatedVisit),
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

describe("updateJobVisit — inventory consumption", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("consumes inventory exactly once when a visit is marked Completed", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Scheduled", "InProgress") as any,
		);
		setupTransaction([{ id: "visit-1", status: "Completed" }]);

		await updateJobVisit(makeRequest("visit-1", { status: "Completed" }));

		expect(mockDeduct).toHaveBeenCalledOnce();
		expect(mockDeduct).toHaveBeenCalledWith("visit-1", expect.anything(), undefined, undefined);
	});

	it("does not consume if the visit was already Completed before this update", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Completed", "InProgress") as any,
		);
		setupTransaction([{ id: "visit-1", status: "Completed" }]);

		await updateJobVisit(makeRequest("visit-1", { status: "Completed" }));

		expect(mockDeduct).not.toHaveBeenCalled();
	});

	it("does not consume when status changes to something other than Completed", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Scheduled", "Scheduled") as any,
		);
		setupTransaction([{ id: "visit-1", status: "InProgress" }]);

		await updateJobVisit(makeRequest("visit-1", { status: "InProgress" }));

		expect(mockDeduct).not.toHaveBeenCalled();
	});

	it("only consumes for the completing visit, not sibling visits, when the job completes", async () => {
		mockDb.job_visit.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			makeExistingVisit("Scheduled", "InProgress") as any,
		);
		// After the update, all visits are Completed → job becomes Completed
		setupTransaction([
			{ id: "visit-1", status: "Completed" },
			{ id: "visit-2", status: "Completed" },
		]);

		await updateJobVisit(makeRequest("visit-1", { status: "Completed" }));

		// visit-2 already consumed at its own completion — never again here
		expect(mockDeduct).toHaveBeenCalledOnce();
		expect(mockDeduct).toHaveBeenCalledWith("visit-1", expect.anything(), undefined, undefined);
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
