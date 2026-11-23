import { describe, it, expect, vi, beforeEach } from "vitest";

const recomputeVisitTotals = vi.fn(async () => ({ ok: true }));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({ recomputeVisitTotals }));

const tx = {
	$queryRaw: vi.fn(async () => []),
	visit_tech_time_entry: {
		updateMany: vi.fn(async () => ({ count: 1 })),
		update: vi.fn(async () => ({ id: "e1" })),
		findFirst: vi.fn(async () => ({ id: "other" })),
	},
	job_visit_line_item: { create: vi.fn(async () => ({ id: "li1" })) },
	job_visit: {
		findUnique: vi.fn(async () => ({ status: "InProgress" })),
		update: vi.fn(async () => ({})),
	},
	job_visit_technician: { updateMany: vi.fn(async () => ({ count: 1 })) },
	technician: { update: vi.fn(async () => ({})), findUnique: vi.fn(async () => ({})) },
};
const sdb = {
	visit_tech_time_entry: {
		findFirst: vi.fn(async () => ({ id: "e1", clocked_in_at: new Date(Date.now() - 3600_000) })),
	},
	technician: { findFirst: vi.fn(async () => ({ hourly_rate: 50, name: "Ana" })) },
	// The secondary status event reloads the visit after commit.
	job_visit: { findFirst: vi.fn(async () => null) },
	$transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
};
vi.mock("../../lib/context.js", () => ({ getScopedDb: () => sdb }));
vi.mock("../../services/appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn() }));
vi.mock("../../services/socketService.js", () => ({ emitToOrg: vi.fn() }));
vi.mock("../jobVisitsController.js", () => ({
	buildVisitStatusPayload: vi.fn(() => ({})),
	buildSecondaryEventPayload: vi.fn(() => ({})),
}));
vi.mock("../../services/visitLifecycle/index.js", () => ({
	LifecycleRefusal: class extends Error {},
	applyStatusChange: vi.fn(),
	runPostCommit: vi.fn(),
	actorOf: vi.fn(() => ({ type: "technician", id: "t1" })),
}));
vi.mock("../timesheetController.js", () => ({
	isWeekLocked: vi.fn(async () => false),
	TIMESHEET_LOCKED: "locked",
}));

describe("clock-out visit totals", () => {
	beforeEach(() => vi.clearAllMocks());

	it("clock-out recomputes the visit through recomputeVisitTotals, not subtotal × tax_rate", async () => {
		const { clockOutVisit } = await import("../visitTimeEntriesController.js");
		await clockOutVisit("v1", "t1", "org1");
		expect(recomputeVisitTotals).toHaveBeenCalledWith("v1", "org1", tx);
		for (const [arg] of tx.job_visit.update.mock.calls as unknown as [
			{ data: Record<string, unknown> },
		][]) {
			expect(arg.data).not.toHaveProperty("tax_amount");
		}
	});
});
