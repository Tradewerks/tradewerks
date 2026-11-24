import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyStatusChange } from "../applyStatusChange.js";
import { syncOccurrenceForVisit } from "../../recurringOccurrenceSync.js";

vi.mock("../../recurringOccurrenceSync.js", () => ({
	syncOccurrenceForVisit: vi.fn(async () => undefined),
}));
vi.mock("../../../controllers/inventoryController.js", () => ({
	deductInventoryForVisit: vi.fn(async () => ({ lowStockItemIds: [] })),
}));
vi.mock("../../../controllers/logsController.js", () => ({
	parentBreadcrumb: vi.fn(() => ({})),
}));
vi.mock("../activityLog.js", () => ({
	logActivityInTx: vi.fn(async () => ({ id: "log-1" })),
}));
vi.mock("../jobRollup.js", () => ({
	recomputeJobActualTotal: vi.fn(async () => undefined),
}));
vi.mock("../techStatus.js", () => ({
	applyTechStatus: vi.fn(async () => ({
		wrappingUpTechIds: [],
		activatedTechIds: [],
	})),
}));
vi.mock("../timeEntries.js", () => ({
	closeOpenTimeEntries: vi.fn(async () => ({ techIds: [] })),
}));

function makeTx(recurringPlanId: string | null, status = "InProgress") {
	return {
		$queryRaw: vi.fn(async () => [{ id: "v1", status }]),
		job_visit: {
			findFirst: vi.fn(async () => ({
				id: "v1",
				job_id: "j1",
				status,
				actual_start_at: new Date(),
				job: {
					id: "j1",
					job_number: "J-1",
					recurring_plan_id: recurringPlanId,
				},
				visit_techs: [{ tech_id: "t1" }],
			})),
			updateMany: vi.fn(async () => ({ count: 1 })),
			findMany: vi.fn(async () => []),
		},
		technician: { findMany: vi.fn(async () => []) },
		invoice_visit: { count: vi.fn(async () => 0) },
		job: {
			findFirst: vi.fn(async () => ({
				status: "InProgress",
				completed_at: null,
				cancelled_at: null,
				cancellation_reason: null,
			})),
			update: vi.fn(),
		},
	};
}

const run = (tx: ReturnType<typeof makeTx>, action: "complete" | "reopen") =>
	applyStatusChange(tx as never, {
		orgId: "org-1",
		visitId: "v1",
		action,
		context: { dispatcherId: "d1" } as never,
		deferJobSync: true,
	});

describe("applyStatusChange occurrence sync", () => {
	beforeEach(() => vi.clearAllMocks());

	it("syncs the occurrence for a recurring plan's visit", async () => {
		await run(makeTx("plan-1"), "complete");
		expect(syncOccurrenceForVisit).toHaveBeenCalledWith(
			"v1",
			"Completed",
			expect.anything(),
			"InProgress",
		);
	});

	it("skips the occurrence write for a visit that is not a plan's", async () => {
		await run(makeTx(null), "complete");
		expect(syncOccurrenceForVisit).not.toHaveBeenCalled();
	});
});
