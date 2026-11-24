import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => ({
	sdb: {
		invoice: {
			findFirst: vi.fn(),
			updateMany: vi.fn(),
		},
	},
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({
	getOrgRealmId: vi.fn(async () => "realm1"),
}));
vi.mock("../logger.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../qb/qbNotify.js", () => ({ notifyQbProblem: vi.fn(async () => undefined) }));

import { clearQbDivergence, markQbDiverged } from "../qb/qbDivergence.js";
import { logActivity } from "../logger.js";
import { notifyQbProblem } from "../qb/qbNotify.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("markQbDiverged", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm1",
			invoice_number: "INV-1039",
		});
	});

	it("marking twice returns false the second time and does not notify again", async () => {
		mockFn(sdb.invoice.updateMany)
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });

		const first = await markQbDiverged("inv1", "org1", "refund_not_in_qb");
		const second = await markQbDiverged("inv1", "org1", "refund_not_in_qb");

		expect(first).toBe(true);
		expect(second).toBe(false);
		// The transition is the conditional write itself: only a row still
		// unflagged can be flagged, so a repeat cannot transition again.
		for (const [arg] of mockFn(sdb.invoice.updateMany).mock.calls) {
			expect(arg.where).toMatchObject({ id: "inv1", qb_diverged_at: null });
		}
		expect(mockFn(sdb.invoice.updateMany).mock.calls[0][0].data).toEqual({
			qb_diverged_at: expect.any(Date),
			qb_diverged_reason: "refund_not_in_qb",
		});
		expect(notifyQbProblem).toHaveBeenCalledTimes(1);
		expect(notifyQbProblem).toHaveBeenCalledWith(
			"org1",
			{ id: "inv1", invoice_number: "INV-1039" },
			"refund_not_in_qb",
		);
	});

	it("does not mark an invoice synced to another QuickBooks company", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm-old",
		});

		expect(await markQbDiverged("inv1", "org1", "refund_not_in_qb")).toBe(false);
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
	});
});

describe("clearQbDivergence", () => {
	beforeEach(() => vi.clearAllMocks());

	it("clearing writes nulls and logs invoice.qb_reconciled", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			invoice_number: "INV-1039",
			qb_diverged_at: new Date(),
			qb_diverged_reason: "refund_not_in_qb",
		});
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 1 });

		const result = await clearQbDivergence("inv1", "org1", { dispatcherId: "d1" });

		expect(result).toEqual({ err: "" });
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1", qb_diverged_at: { not: null } },
			data: { qb_diverged_at: null, qb_diverged_reason: null },
		});
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.qb_reconciled",
				entity_type: "invoice",
				entity_id: "inv1",
				organization_id: "org1",
				actor_type: "dispatcher",
				actor_id: "d1",
			}),
		);
	});

	it("refuses an invoice outside the org", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue(null);

		const result = await clearQbDivergence("inv1", "org1", { dispatcherId: "d1" });

		expect(result.err).toBe("Invoice not found");
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});
});
