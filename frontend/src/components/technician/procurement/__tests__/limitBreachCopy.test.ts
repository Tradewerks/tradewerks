/**
 * The server measures a `per_job` ceiling against ONE job's share of the receipt,
 * not the whole receipt. Described against the whole receipt, the arithmetic ran
 * backwards and the notice read "$0.00 already spent on this job" — the clamp hid
 * a negative rather than a wrong figure.
 */
import { describe, expect, it } from "vitest";
import { describeBreach } from "../limitBreachCopy";
import type { LimitBreach } from "../../../../types/fieldPurchases";

const perJob = (wouldBe: string, jobId = "job-a"): LimitBreach => ({
	code: "per_job",
	limit: "200.00",
	would_be: wouldBe,
	job_id: jobId,
});

describe("describeBreach", () => {
	// Grant 200 per job, 180 already on it, this receipt's share 50 → server 230.
	it("uses the job's share for a per_job breach", () => {
		const copy = describeBreach(perJob("230.00"), 500, [{ job_id: "job-a", amount: 50 }]);

		expect(copy.spent).toBe("$180.00 already spent on this job");
		expect(copy.action).toBe("Come down $30.00");
	});

	it("falls back to the receipt total when no share is known", () => {
		const copy = describeBreach(perJob("230.00"), 50);

		expect(copy.spent).toBe("$180.00 already spent on this job");
	});

	// Windowed ceilings are measured against the whole receipt, so those are
	// unchanged: a share would understate what has already gone against the window.
	it("uses the receipt total for a windowed breach", () => {
		const copy = describeBreach(
			{ code: "weekly", limit: "500.00", would_be: "620.00" },
			200,
			[{ job_id: "job-a", amount: 50 }]
		);

		expect(copy.spent).toBe("$420.00 already spent this week");
		expect(copy.action).toBe("Come down $120.00");
	});

	it("says nothing about spend for per_transaction", () => {
		const copy = describeBreach(
			{ code: "per_transaction", limit: "500.00", would_be: "900.00" },
			900
		);

		expect(copy.spent).toBeNull();
		expect(copy.action).toBe("Come down $400.00");
	});

	// Both sides arrive as decimal strings, so a cent can go the wrong way. The
	// clamp is a rounding guard, kept deliberately and now pinned as one.
	it("clamps a cents disagreement to zero rather than going negative", () => {
		const copy = describeBreach(perJob("229.99"), 500, [{ job_id: "job-a", amount: 230 }]);

		expect(copy.spent).toBe("$0.00 already spent on this job");
	});
});
