/**
 * Limit maths and the deterministic checks. Pinned here because the technician's
 * pre-flight answer and the submit-time enforcement both come from these
 * functions — if they ever disagree, a tech is told they may spend and then told
 * they may not, having already paid.
 */
import { describe, it, expect } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
	checkLimits,
	countOcrCorrections,
	deriveAllocationAmounts,
	evaluateFlags,
	findDuplicate,
	spendWindows,
	spreadEstimate,
	velocityFlags,
} from "../fieldPurchase.js";

const noSpend = { today: 0, week: 0 };

describe("checkLimits", () => {
	it("refuses only when the grant is missing or revoked", () => {
		expect(checkLimits(null, 10, noSpend)).toEqual({
			authorized: false,
			requires_preauth: false,
			breaches: [],
		});
		expect(
			checkLimits({ per_transaction_limit: 500, is_active: false }, 10, noSpend).authorized,
		).toBe(false);
	});

	it("passes an under-limit amount with no breaches", () => {
		const v = checkLimits({ per_transaction_limit: 500, is_active: true }, 499.99, noSpend);
		expect(v).toEqual({ authorized: true, requires_preauth: false, breaches: [] });
	});

	it("treats the limit itself as allowed, not a breach", () => {
		const v = checkLimits({ per_transaction_limit: 500, is_active: true }, 500, noSpend);
		expect(v.requires_preauth).toBe(false);
	});

	// Amounts are stored positive on both kinds, so without the carve-out a large
	// return trips the spending ceiling and asks a dispatcher for permission
	// before the company can be repaid.
	it("does not hold a refund to the per-transaction ceiling", () => {
		const grant = { per_transaction_limit: 500, is_active: true };
		expect(checkLimits(grant, 900, noSpend).requires_preauth).toBe(true);
		expect(
			checkLimits(grant, 900, noSpend, undefined, { kind: "refund" }).requires_preauth,
		).toBe(false);
	});

	// A per-transaction cap alone is defeated by several sub-limit buys, which is
	// what the aggregate ceilings exist to catch.
	it("catches an aggregate breach built from under-limit purchases", () => {
		const v = checkLimits({ per_transaction_limit: 500, daily_limit: 600, is_active: true }, 400, {
			today: 400,
			week: 400,
		});
		expect(v.requires_preauth).toBe(true);
		expect(v.breaches.map((b) => b.code)).toEqual(["daily"]);
		expect(v.breaches[0]).toMatchObject({ limit: "600.00", would_be: "800.00" });
	});

	it("reports every ceiling crossed at once", () => {
		const v = checkLimits(
			{ per_transaction_limit: 100, daily_limit: 150, weekly_limit: 200, is_active: true },
			180,
			{ today: 0, week: 100 },
		);
		expect(v.breaches.map((b) => b.code)).toEqual(["per_transaction", "daily", "weekly"]);
	});

	it("checks the per-job ceiling against that job's share, not the receipt total", () => {
		const grant = { per_transaction_limit: 1000, per_job_limit: 200, is_active: true };
		const split = new Map<string, number>([
			["job-a", 150],
			["job-b", 150],
		]);
		// 300 total, but no single job exceeds 200.
		expect(checkLimits(grant, 300, noSpend, split).requires_preauth).toBe(false);

		const lopsided = new Map<string, number>([["job-a", 300]]);
		const v = checkLimits(grant, 300, noSpend, lopsided);
		expect(v.breaches).toEqual([
			{ code: "per_job", limit: "200.00", would_be: "300.00", job_id: "job-a" },
		]);
	});

	it("adds prior spend on the same job to the per-job check", () => {
		const v = checkLimits(
			{ per_transaction_limit: 1000, per_job_limit: 200, is_active: true },
			100,
			{ today: 0, week: 0, perJob: new Map([["job-a", 150]]) },
			new Map([["job-a", 100]]),
		);
		expect(v.breaches[0]).toMatchObject({ code: "per_job", would_be: "250.00" });
	});

	it("ignores ceilings left unset", () => {
		const v = checkLimits({ per_transaction_limit: 50, is_active: true }, 10, {
			today: 10_000,
			week: 99_000,
		});
		expect(v.requires_preauth).toBe(false);
	});

	it("does the maths in Decimal, so cents do not drift", () => {
		const v = checkLimits(
			{
				per_transaction_limit: new Prisma.Decimal("100.00"),
				daily_limit: new Prisma.Decimal("100.30"),
				is_active: true,
			},
			new Prisma.Decimal("0.10"),
			{ today: new Prisma.Decimal("100.20"), week: 0 },
		);
		// 100.20 + 0.10 is exactly 100.30 in Decimal; in floats it is 100.30000000000001.
		expect(v.requires_preauth).toBe(false);
	});

	it("holds a refund to no ceiling at all, not just to the per-transaction one", () => {
		const grant = {
			per_transaction_limit: 500,
			daily_limit: 600,
			weekly_limit: 1000,
			per_job_limit: 400,
			is_active: true,
		};
		// A $900 return against a $600 daily ceiling. Summed as spend this reads as
		// a breach and the submit refuses, which makes the company unrepayable.
		const v = checkLimits(
			grant,
			900,
			{ today: 0, week: 0, perJob: new Map() },
			new Map([["job-a", 900]]),
			{ kind: "refund" },
		);
		expect(v).toEqual({ authorized: true, requires_preauth: false, breaches: [] });
	});

	it("still refuses a revoked grant on a refund, because that is not a ceiling", () => {
		expect(
			checkLimits({ per_transaction_limit: 500, is_active: false }, 900, noSpend, undefined, {
				kind: "refund",
			}).authorized,
		).toBe(false);
	});

	it("leaves a purchase measured against every ceiling", () => {
		const grant = { per_transaction_limit: 500, daily_limit: 600, is_active: true };
		const v = checkLimits(grant, 400, { today: 300, week: 300, perJob: new Map() }, undefined, {
			kind: "purchase",
		});
		expect(v.breaches.map((b) => b.code)).toEqual(["daily"]);
	});
});

describe("evaluateFlags", () => {
	const base = {
		total: 100,
		tax_amount: 0,
		lines: [{ line_total: 100 }],
		has_geo: true,
	};

	it("raises nothing when the receipt adds up and geo is present", () => {
		expect(evaluateFlags(base)).toEqual([]);
	});

	it("flags a total that disagrees with its own lines", () => {
		const flags = evaluateFlags({ ...base, total: 130 });
		expect(flags.map((f) => f.code)).toEqual(["total_mismatch"]);
	});

	it("tolerates a single cent of rounding", () => {
		expect(evaluateFlags({ ...base, total: 100.01 })).toEqual([]);
		expect(evaluateFlags({ ...base, total: 100.02 }).map((f) => f.code)).toEqual([
			"total_mismatch",
		]);
	});

	it("counts tax toward the expected total", () => {
		expect(evaluateFlags({ ...base, total: 107, tax_amount: 7 })).toEqual([]);
	});

	it("flags spending past a pre-authorized estimate without refusing it", () => {
		const flags = evaluateFlags({ ...base, estimated_amount: 80 });
		expect(flags.map((f) => f.code)).toEqual(["over_estimate"]);
	});

	it("flags a purchase outside every linked job's window", () => {
		const flags = evaluateFlags({
			...base,
			purchased_at: new Date("2026-08-21T20:00:00Z"),
			jobWindows: [
				{
					job_id: "job-a",
					start: new Date("2026-08-21T08:00:00Z"),
					end: new Date("2026-08-21T12:00:00Z"),
				},
			],
		});
		expect(flags.map((f) => f.code)).toEqual(["outside_job_window"]);
	});

	it("clears the window check when any one linked job covers the purchase", () => {
		const flags = evaluateFlags({
			...base,
			purchased_at: new Date("2026-08-21T20:00:00Z"),
			jobWindows: [
				{
					job_id: "job-a",
					start: new Date("2026-08-21T08:00:00Z"),
					end: new Date("2026-08-21T12:00:00Z"),
				},
				{
					job_id: "job-b",
					start: new Date("2026-08-21T18:00:00Z"),
					end: new Date("2026-08-21T22:00:00Z"),
				},
			],
		});
		expect(flags).toEqual([]);
	});

	it("notes missing geolocation as advisory, since desktop capture has none", () => {
		const flags = evaluateFlags({ ...base, has_geo: false });
		expect(flags.map((f) => f.code)).toEqual(["geo_missing"]);
	});
});

describe("spendWindows", () => {
	it("spans seven org-local days ending with the purchase day", () => {
		const w = spendWindows(new Date("2026-08-21T15:00:00Z"), "UTC");
		expect(w.dayStart.toISOString()).toBe("2026-08-21T00:00:00.000Z");
		expect(w.dayEnd.toISOString()).toBe("2026-08-22T00:00:00.000Z");
		expect(w.weekStart.toISOString()).toBe("2026-08-15T00:00:00.000Z");
	});

	it("uses the org timezone for the day boundary, not UTC", () => {
		// 02:00Z on the 21st is still the 20th in Chicago, so that is the day the
		// spend counts against, and it began at that zone's midnight, 05:00Z.
		const w = spendWindows(new Date("2026-08-21T02:00:00Z"), "America/Chicago");
		expect(w.dayStart.toISOString()).toBe("2026-08-20T05:00:00.000Z");
		expect(w.dayEnd.toISOString()).toBe("2026-08-21T05:00:00.000Z");
	});

	it("spans seven org-local days, not eight", () => {
		// The week is the six local days before the purchase day plus the purchase
		// day itself, each bound measured in the same org timezone as dayStart/dayEnd.
		const w = spendWindows(new Date("2026-08-21T02:00:00Z"), "America/Chicago");
		expect(w.weekStart.toISOString()).toBe("2026-08-14T05:00:00.000Z");
		expect(w.weekEnd.toISOString()).toBe("2026-08-21T05:00:00.000Z");
	});

	it("still spans seven local days across a spring-forward, where a 144-hour subtraction would span eight", () => {
		// 2026-03-09 in Chicago is the day after the clocks moved; the week it ends
		// is 03-03 through 03-09.
		const w = spendWindows(new Date("2026-03-09T18:00:00Z"), "America/Chicago");
		expect(w.weekStart.toISOString()).toBe("2026-03-03T06:00:00.000Z");
		expect(w.dayEnd.toISOString()).toBe("2026-03-10T05:00:00.000Z");
	});
});

describe("countOcrCorrections", () => {
	const line = (description: string, quantity: number, unit_price: number, line_total: number) => ({
		description,
		quantity,
		unit_price,
		line_total,
	});

	it("counts nothing when the technician changed nothing", () => {
		const snapshot = [line("Capacitor 45/5", 1, 24.99, 24.99), line("Contactor", 2, 18, 36)];
		expect(countOcrCorrections(snapshot, snapshot)).toBe(0);
	});

	it("ignores description whitespace and case, which OCR varies on its own", () => {
		expect(
			countOcrCorrections(
				[line("CAPACITOR  45/5", 1, 24.99, 24.99)],
				[line("Capacitor 45/5", 1, 24.99, 24.99)],
			),
		).toBe(0);
	});

	it("counts an edited amount as one correction, not a delete plus an add", () => {
		expect(
			countOcrCorrections([line("Capacitor", 1, 24.99, 24.99)], [line("Capacitor", 1, 26.99, 26.99)]),
		).toBe(1);
	});

	it("lets the untouched line claim its own match before an edited twin does", () => {
		const snapshot = [line("Contactor", 1, 18, 18), line("Contactor", 2, 18, 36)];
		// Both share a description; only the second was corrected.
		expect(countOcrCorrections(snapshot, [line("Contactor", 1, 18, 18), line("Contactor", 3, 18, 54)])).toBe(
			1,
		);
	});

	it("counts an added line and a deleted line each as one miss", () => {
		const snapshot = [line("Capacitor", 1, 24.99, 24.99)];
		expect(countOcrCorrections(snapshot, [...snapshot, line("Shipping", 1, 5, 5)])).toBe(1);
		expect(countOcrCorrections(snapshot, [])).toBe(1);
	});

	it("does not let one extracted line absorb two identical final lines", () => {
		const snapshot = [line("Contactor", 1, 18, 18)];
		expect(countOcrCorrections(snapshot, [line("Contactor", 1, 18, 18), line("Contactor", 1, 18, 18)])).toBe(
			1,
		);
	});
});

describe("findDuplicate", () => {
	const subject = {
		vendor_name: "Grainger #114",
		purchased_at: new Date("2026-08-21T15:00:00Z"),
		total: 65.27,
		receipt_number: null as string | null,
	};
	const prior = (over: Record<string, unknown> = {}) => ({
		id: "fp-prior",
		status: "approved",
		vendor_name: "Grainger #114",
		purchased_at: new Date("2026-08-21T09:00:00Z"),
		total: 65.27,
		technician_name: "Dana Reyes",
		receipt_number: null as string | null,
		...over,
	});

	it("blocks an exact match that was already reimbursed", () => {
		const v = findDuplicate(subject, [prior()]);
		expect(v?.level).toBe("exact");
		expect(v?.message).toContain("Dana Reyes");
	});

	it("only flags the same triple when the prior is still in review", () => {
		expect(findDuplicate(subject, [prior({ status: "pending_review" })])?.level).toBe("near");
	});

	it("flags a near match on the adjacent day or a rounding-sized difference", () => {
		expect(
			findDuplicate(subject, [prior({ purchased_at: new Date("2026-08-20T20:00:00Z") })])?.level,
		).toBe("near");
		expect(findDuplicate(subject, [prior({ total: 66.5 })])?.level).toBe("near");
	});

	it("ignores punctuation between two prints of the same vendor name", () => {
		expect(findDuplicate(subject, [prior({ vendor_name: "GRAINGER  114" })])?.level).toBe("exact");
	});

	it("does not match a different vendor, day, or amount", () => {
		expect(findDuplicate(subject, [prior({ vendor_name: "Ferguson" })])).toBeNull();
		expect(
			findDuplicate(subject, [prior({ purchased_at: new Date("2026-08-18T09:00:00Z") })]),
		).toBeNull();
		expect(findDuplicate(subject, [prior({ total: 120 })])).toBeNull();
	});

	it("cannot match on nothing: a purchase with no vendor or date is not a duplicate", () => {
		expect(findDuplicate({ ...subject, vendor_name: null }, [prior()])).toBeNull();
		expect(findDuplicate({ ...subject, purchased_at: null }, [prior()])).toBeNull();
		expect(findDuplicate({ ...subject, total: 0 }, [prior()])).toBeNull();
	});

	it("prefers the exact match over a near one already found", () => {
		const v = findDuplicate(subject, [prior({ id: "near", total: 66.5 }), prior({ id: "exact" })]);
		expect(v).toMatchObject({ level: "exact", purchase_id: "exact" });
	});

	it("refuses a receipt whose number a prior purchase already claimed", () => {
		const v = findDuplicate(
			{
				vendor_name: "Ferguson",
				purchased_at: new Date("2026-08-21"),
				total: 65.27,
				receipt_number: "884213",
			},
			[
				prior({
					status: "reimbursed",
					vendor_name: "FERGUSON #12",
					purchased_at: new Date("2026-08-19"),
					total: 40.0,
					receipt_number: "884213",
				}),
			],
		);
		// Same vendor, same ticket number: a different date and total cannot make it a
		// different receipt, so this outranks the fuzzy tier entirely.
		expect(v?.level).toBe("exact");
	});

	it("does not match two receipts that merely both lack a number", () => {
		const v = findDuplicate(
			{
				vendor_name: "Ferguson",
				purchased_at: new Date("2026-08-21"),
				total: 65.27,
				receipt_number: null,
			},
			[
				prior({
					vendor_name: "Ferguson",
					purchased_at: new Date("2026-08-01"),
					total: 12.0,
					receipt_number: null,
				}),
			],
		);
		expect(v).toBeNull();
	});

	it("does not match the same number printed by two different vendors", () => {
		const v = findDuplicate(
			{
				vendor_name: "Ferguson",
				purchased_at: new Date("2026-08-21"),
				total: 65.27,
				receipt_number: "1001",
			},
			[
				prior({
					vendor_name: "Grainger",
					purchased_at: new Date("2026-08-21"),
					total: 65.27,
					receipt_number: "1001",
				}),
			],
		);
		expect(v?.level).not.toBe("exact");
	});
});

describe("velocityFlags", () => {
	const day = (id: string, total: number) => ({ id, total });

	it("says nothing about a single purchase", () => {
		expect(velocityFlags(100, [], 500)).toEqual([]);
	});

	it("raises velocity at the third purchase of the day", () => {
		expect(velocityFlags(50, [day("a", 50)], 500)).toEqual([]);
		expect(velocityFlags(50, [day("a", 50), day("b", 50)], 500).map((f) => f.code)).toEqual([
			"velocity",
		]);
	});

	it("catches a limit defeated by sub-limit buys", () => {
		const codes = velocityFlags(300, [day("a", 400)], 500).map((f) => f.code);
		expect(codes).toContain("split_transaction");
	});

	it("stays quiet when a purchase broke the limit honestly on its own", () => {
		// That one already breached and went through pre-authorization; calling it a
		// split as well would flag the control that worked.
		const codes = velocityFlags(600, [day("a", 400)], 500).map((f) => f.code);
		expect(codes).not.toContain("split_transaction");
	});

	it("needs a limit to say anything about splitting", () => {
		expect(velocityFlags(300, [day("a", 400)], null)).toEqual([]);
	});
});

describe("deriveAllocationAmounts", () => {
	const sum = (out: { amount: Prisma.Decimal }[]) =>
		out.reduce((n, o) => n.plus(o.amount), new Prisma.Decimal(0));

	it("gives a lone job its lines plus all of the tax", () => {
		const out = deriveAllocationAmounts(
			[{ id: "a", lines: [{ line_total: "40.00" }, { line_total: "60.00" }] }],
			8.5,
		);
		expect(out).toEqual([{ id: "a", amount: expect.anything() }]);
		expect(out[0]!.amount.toFixed(2)).toBe("108.50");
	});

	it("splits tax pro-rata by what each job's lines came to", () => {
		const out = deriveAllocationAmounts(
			[
				{ id: "a", lines: [{ line_total: "80.00" }] },
				{ id: "b", lines: [{ line_total: "20.00" }] },
			],
			10,
		);
		// 80/20 of the lines is 80/20 of the tax: 8.00 and 2.00.
		expect(out.map((o) => o.amount.toFixed(2))).toEqual(["88.00", "22.00"]);
		expect(sum(out).toFixed(2)).toBe("110.00");
	});

	it("settles the rounding cent on the largest share", () => {
		// A third of a cent each way: 3.33 + 3.33 + 3.33 leaves one behind, and one
		// unallocated penny is a receipt reported as partly unallocated.
		const out = deriveAllocationAmounts(
			[
				{ id: "small", lines: [{ line_total: "10.00" }] },
				{ id: "mid", lines: [{ line_total: "10.00" }] },
				{ id: "big", lines: [{ line_total: "10.01" }] },
			],
			10,
		);
		expect(sum(out).toFixed(2)).toBe("40.01");
		expect(out.find((o) => o.id === "big")!.amount.toFixed(2)).toBe("13.35");
	});

	it("spreads tax equally when no line has a value to spread it against", () => {
		const out = deriveAllocationAmounts(
			[
				{ id: "a", lines: [{ line_total: 0 }] },
				{ id: "b", lines: [] },
			],
			5,
		);
		expect(out.map((o) => o.amount.toFixed(2))).toEqual(["2.50", "2.50"]);
	});

	it("gives a job with no lines nothing but its tax share", () => {
		const out = deriveAllocationAmounts(
			[
				{ id: "a", lines: [{ line_total: "100.00" }] },
				{ id: "b", lines: [] },
			],
			10,
		);
		expect(out.map((o) => o.amount.toFixed(2))).toEqual(["110.00", "0.00"]);
	});

	it("has nothing to say about a purchase with no jobs", () => {
		expect(deriveAllocationAmounts([], 10)).toEqual([]);
	});
});

/**
 * A receipt with a printed discount carries a negative line. Both derivations sum
 * line totals, so they are sign-agnostic by construction — these pin that, because
 * the alternative is a job billed for a discount it never received.
 */
describe("a discounted receipt", () => {
	it("pulls a job's share down by its own discount", () => {
		const out = deriveAllocationAmounts(
			[
				{ id: "a", lines: [{ line_total: "100.00" }, { line_total: "-20.00" }] },
				{ id: "b", lines: [{ line_total: "100.00" }] },
			],
			18,
		);
		const [a, b] = out.map((o) => o.amount);
		expect(a!.lessThan(b!)).toBe(true);
		// The parts still add up to the whole: subtotal 180 plus 18 of tax.
		expect(a!.plus(b!).toFixed(2)).toBe("198.00");
	});

	// Written for an all-free receipt, and a receipt whose lines net to zero lands
	// in the same branch. Tax owed by nobody in particular is split equally.
	it("spreads tax equally when the lines net to zero", () => {
		const out = deriveAllocationAmounts(
			[
				{ id: "a", lines: [{ line_total: "50.00" }] },
				{ id: "b", lines: [{ line_total: "-50.00" }] },
			],
			10,
		);
		expect(out.map((o) => o.amount.toFixed(2))).toEqual(["55.00", "-45.00"]);
	});

	// The defect's actual symptom: dropped negatives made the receipt disagree with
	// its own lines, so every discounted purchase reached the dispatcher flagged.
	it("does not flag total_mismatch", () => {
		const flags = evaluateFlags({
			total: 108,
			tax_amount: 8,
			lines: [{ line_total: 120 }, { line_total: -20 }],
			has_geo: true,
		});
		expect(flags.map((f) => f.code)).not.toContain("total_mismatch");
	});
});

describe("spreadEstimate", () => {
	it("gives a lone job the whole ask", () => {
		expect(spreadEstimate(["a"], 500).get("a")!.toFixed(2)).toBe("500.00");
	});

	it("splits equally and still adds up exactly", () => {
		const out = spreadEstimate(["a", "b", "c"], 100);
		expect([...out.values()].reduce((n, v) => n.plus(v), new Prisma.Decimal(0)).toFixed(2)).toBe(
			"100.00",
		);
	});

	it("has nothing to say about a purchase with no jobs", () => {
		expect(spreadEstimate([], 500).size).toBe(0);
	});
});
