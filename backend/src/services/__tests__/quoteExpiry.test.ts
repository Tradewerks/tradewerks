import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({
	db: { quote: { findMany: vi.fn(), update: vi.fn() } },
}));

vi.mock("../logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import { expireStaleQuotes } from "../quoteExpiry.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("expireStaleQuotes", () => {
	beforeEach(() => vi.clearAllMocks());

	it("only considers quotes still awaiting a decision, capped to one batch", async () => {
		mockFn(db.quote.findMany).mockResolvedValue([]);

		await expireStaleQuotes(new Date("2026-09-04T00:00:00Z"));

		const args = mockFn(db.quote.findMany).mock.calls[0][0];
		expect(args.where.status.in).toEqual(["Issued", "Sent", "Viewed"]);
		expect(args.where.expires_at.lt).toEqual(new Date("2026-09-04T00:00:00Z"));
		// A caller with years of unswept quotes must not load them all in one
		// tick — the batch cap is what makes that safe.
		expect(args.take).toBeGreaterThan(0);
	});

	it("expires each match and reports the count", async () => {
		mockFn(db.quote.findMany).mockResolvedValue([
			{
				id: "q1",
				status: "Sent",
				organization_id: "org1",
				quote_number: "Q-1001",
			},
			{
				id: "q2",
				status: "Viewed",
				organization_id: "org1",
				quote_number: "Q-1002",
			},
		]);

		const result = await expireStaleQuotes(new Date("2026-09-04T00:00:00Z"));

		expect(result).toEqual({ expired: 2, failed: 0 });
		expect(db.quote.update).toHaveBeenCalledTimes(2);
		expect(mockFn(db.quote.update).mock.calls[0][0].data.status).toBe(
			"Expired",
		);
	});

	it("is idempotent — the second of two runs re-queries and finds nothing left", async () => {
		mockFn(db.quote.findMany).mockResolvedValueOnce([
			{
				id: "q1",
				status: "Sent",
				organization_id: "org1",
				quote_number: "Q-1001",
			},
		]);

		const first = await expireStaleQuotes();
		expect(first).toEqual({ expired: 1, failed: 0 });
		expect(db.quote.update).toHaveBeenCalledTimes(1);

		// The second run's own query — not a cached list — is what a real
		// re-run would see once q1 has already left the expirable statuses.
		mockFn(db.quote.findMany).mockResolvedValueOnce([]);
		const second = await expireStaleQuotes();
		expect(second).toEqual({ expired: 0, failed: 0 });
		expect(db.quote.update).toHaveBeenCalledTimes(1);
	});

	it("keeps going when one quote fails, and reports the failure instead of dropping it", async () => {
		mockFn(db.quote.findMany).mockResolvedValue([
			{
				id: "q1",
				status: "Sent",
				organization_id: "org1",
				quote_number: "Q-1001",
			},
			{
				id: "q2",
				status: "Sent",
				organization_id: "org1",
				quote_number: "Q-1002",
			},
		]);
		mockFn(db.quote.update)
			.mockRejectedValueOnce(new Error("row locked"))
			.mockResolvedValueOnce({ id: "q2" });

		const result = await expireStaleQuotes();

		expect(result).toEqual({ expired: 1, failed: 1 });
	});
});
