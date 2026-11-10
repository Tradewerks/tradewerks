import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, logActivity } = vi.hoisted(() => {
	const model = () => ({ findFirst: vi.fn(), update: vi.fn(async () => ({})) });
	return { sdb: { quote: model(), job: model(), invoice: model() }, logActivity: vi.fn(async () => undefined) };
});
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../services/logger.js", () => ({ logActivity }));

import { acknowledgeTaxReview } from "../taxReviewController.js";

describe("acknowledgeTaxReview", () => {
	beforeEach(() => vi.clearAllMocks());

	it("records who acknowledged and when, and audits it with the review reason", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce({
			id: "i1",
			tax_needs_review: true,
			tax_snapshot: { version: 2, groups: [], review_reason: "Not registered to collect in IL" },
		});
		const r = await acknowledgeTaxReview("invoice", "i1", "org1", { dispatcherId: "d1" });
		expect(r).toMatchObject({ ok: true, item: { id: "i1", tax_review_ack_by: "d1" } });
		expect(sdb.invoice.update).toHaveBeenCalledWith({
			where: { id: "i1" },
			data: { tax_review_ack_by: "d1", tax_review_ack_at: expect.any(Date) },
		});
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.tax_review_acknowledged",
				entity_type: "invoice",
				entity_id: "i1",
				actor_type: "dispatcher",
				actor_id: "d1",
				reason: "Not registered to collect in IL",
			}),
		);
	});

	it("404s an unknown document and 409s one with nothing to acknowledge", async () => {
		sdb.quote.findFirst.mockResolvedValueOnce(null);
		expect(await acknowledgeTaxReview("quote", "q0", "org1", { dispatcherId: "d1" })).toMatchObject({ ok: false, code: "NOT_FOUND" });
		sdb.quote.findFirst.mockResolvedValueOnce({ id: "q1", tax_needs_review: false, tax_snapshot: null });
		expect(await acknowledgeTaxReview("quote", "q1", "org1", { dispatcherId: "d1" })).toMatchObject({ ok: false, code: "CONFLICT" });
		expect(sdb.quote.update).not.toHaveBeenCalled();
	});

	it("refuses a caller with no dispatcher identity", async () => {
		sdb.job.findFirst.mockResolvedValueOnce({ id: "j1", tax_needs_review: true, tax_snapshot: null });
		expect(await acknowledgeTaxReview("job", "j1", "org1", { techId: "t1" })).toMatchObject({ ok: false, code: "VALIDATION" });
	});
});
