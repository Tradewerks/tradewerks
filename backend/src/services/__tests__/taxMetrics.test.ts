import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { countDraftsNeedingReview } from "../tax/taxMetrics.js";

describe("countDraftsNeedingReview", () => {
	it("counts unlocked documents flagged for review, per type", async () => {
		const count = (n: number) => ({ count: vi.fn(async () => n) });
		const client = { quote: count(2), job: count(1), invoice: count(0) };
		expect(await countDraftsNeedingReview(client as never)).toEqual({ quote: 2, job: 1, invoice: 0 });
		expect(client.quote.count).toHaveBeenCalledWith({
			where: { tax_needs_review: true, status: "Draft" },
		});
		expect(client.job.count).toHaveBeenCalledWith({
			where: { tax_needs_review: true, status: { notIn: ["Completed", "Cancelled"] } },
		});
		expect(client.invoice.count).toHaveBeenCalledWith({
			where: { tax_needs_review: true, status: "Draft" },
		});
	});
});
