import { describe, expect, it } from "vitest";
import {
	advanceNextInvoiceAt,
	calculateNextInvoiceAt,
	notBeforeAfterBilled,
	type ScheduleAnchor,
} from "../invoiceSchedule.js";
import { invoiceScheduleSchema } from "../validate/recurringPlans.js";
import { diffLocalDays, toLocalDate } from "../recurrence/zonedTime.js";

const TZ = "America/Chicago";

function anchor(over: Partial<ScheduleAnchor>): ScheduleAnchor {
	return {
		frequency: "monthly",
		dayOfMonth: 1,
		dayOfWeek: null,
		generateDaysBefore: 0,
		timezone: TZ,
		...over,
	};
}

describe("invoiceSchedule", () => {
	it("monthly on the 31st bills Feb 28 then Mar 31", () => {
		const a = anchor({ dayOfMonth: 31 });
		const feb = calculateNextInvoiceAt(a, {
			from: new Date("2027-02-01T18:00:00Z"),
		});
		// 00:00 CST = 06:00Z; 00:00 CDT = 05:00Z
		expect(feb.toISOString()).toBe("2027-02-28T06:00:00.000Z");
		const mar = advanceNextInvoiceAt(a, feb);
		expect(mar.toISOString()).toBe("2027-03-31T05:00:00.000Z");
		const apr = advanceNextInvoiceAt(a, mar);
		expect(apr.toISOString()).toBe("2027-04-30T05:00:00.000Z");
	});

	it("first invoice for a plan starting next month is in next month, not this one", () => {
		const a = anchor({ dayOfMonth: 1 });
		const next = calculateNextInvoiceAt(a, {
			from: new Date("2026-11-18T18:00:00Z"),
			notBefore: new Date("2026-12-10T14:00:00Z"),
		});
		expect(toLocalDate(next, TZ)).toBe("2027-01-01");
		expect(next.toISOString()).toBe("2027-01-01T06:00:00.000Z");
	});

	it("generation date is midnight Chicago, not midnight UTC", () => {
		// 21:00 on Nov 17 in Chicago, already Nov 18 in UTC.
		const from = new Date("2026-11-18T03:00:00Z");
		const next = calculateNextInvoiceAt(anchor({ dayOfMonth: 18 }), {
			from,
		});
		expect(next.toISOString()).toBe("2026-11-18T06:00:00.000Z");

		const early = calculateNextInvoiceAt(
			anchor({ dayOfMonth: 20, generateDaysBefore: 5 }),
			{ from },
		);
		expect(early.toISOString()).toBe("2026-11-15T06:00:00.000Z");
	});

	it("biweekly advance adds exactly 14 days", () => {
		const a = anchor({
			frequency: "biweekly",
			dayOfWeek: "MO",
			dayOfMonth: null,
		});
		// Spans the Nov 1 2026 DST fall-back.
		const first = calculateNextInvoiceAt(a, {
			from: new Date("2026-10-24T15:00:00Z"),
		});
		expect(first.toISOString()).toBe("2026-10-26T05:00:00.000Z");
		const second = advanceNextInvoiceAt(a, first);
		expect(
			diffLocalDays(toLocalDate(second, TZ), toLocalDate(first, TZ)),
		).toBe(14);
		expect(second.toISOString()).toBe("2026-11-09T06:00:00.000Z");
	});

	it("fixed_amount basis with 0 is rejected by validation", () => {
		const base = {
			billing_basis: "fixed_amount" as const,
			frequency: "monthly" as const,
			day_of_month: 1,
		};
		expect(
			invoiceScheduleSchema.safeParse({ ...base, fixed_amount: 0 })
				.success,
		).toBe(false);
		expect(
			invoiceScheduleSchema.safeParse({ ...base, fixed_amount: 0.01 })
				.success,
		).toBe(true);
	});

	it("advance tolerates legacy UTC-midnight next_invoice_at without re-billing the period", () => {
		const a = anchor({ dayOfMonth: 1 });
		// Pre-timezone rows were written as 00:00 UTC (18:00 the previous day in Chicago).
		const next = advanceNextInvoiceAt(a, new Date("2026-12-01T00:00:00Z"));
		expect(next.toISOString()).toBe("2027-01-01T06:00:00.000Z");
	});

	it("advance with generate_days_before keeps the billing anchor", () => {
		const a = anchor({ dayOfMonth: 31, generateDaysBefore: 3 });
		const first = calculateNextInvoiceAt(a, {
			from: new Date("2027-02-01T18:00:00Z"),
		});
		expect(toLocalDate(first, TZ)).toBe("2027-02-25");
		const second = advanceNextInvoiceAt(a, first);
		expect(toLocalDate(second, TZ)).toBe("2027-03-28");
	});

	describe("legacy UTC-midnight rows", () => {
		it("Auckland monthly day 31 advances Jan 31 to Feb 28", () => {
			const a = anchor({ dayOfMonth: 31, timezone: "Pacific/Auckland" });
			const next = advanceNextInvoiceAt(
				a,
				new Date("2027-01-31T00:00:00Z"),
			);
			// 00:00 NZDT (+13)
			expect(next.toISOString()).toBe("2027-02-27T11:00:00.000Z");
		});

		it("Kiritimati monthly day 31 advances Jan 31 to Feb 28", () => {
			const a = anchor({
				dayOfMonth: 31,
				timezone: "Pacific/Kiritimati",
			});
			const next = advanceNextInvoiceAt(
				a,
				new Date("2027-01-31T00:00:00Z"),
			);
			expect(next.toISOString()).toBe("2027-02-27T10:00:00.000Z");
		});

		it("Auckland weekly MO advances to the next Monday", () => {
			const a = anchor({
				frequency: "weekly",
				dayOfWeek: "MO",
				dayOfMonth: null,
				timezone: "Pacific/Auckland",
			});
			const next = advanceNextInvoiceAt(
				a,
				new Date("2026-11-23T00:00:00Z"),
			);
			expect(toLocalDate(next, "Pacific/Auckland")).toBe("2026-11-30");
			expect(next.toISOString()).toBe("2026-11-29T11:00:00.000Z");
		});

		it("Pago_Pago monthly day 1 advances Dec 1 to Jan 1", () => {
			const a = anchor({ dayOfMonth: 1, timezone: "Pacific/Pago_Pago" });
			const next = advanceNextInvoiceAt(
				a,
				new Date("2026-12-01T00:00:00Z"),
			);
			expect(next.toISOString()).toBe("2027-01-01T11:00:00.000Z");
		});

		it("legacy row with generate_days_before re-derives the billing date", () => {
			const a = anchor({ dayOfMonth: 1, generateDaysBefore: 3 });
			// Billing Dec 1 minus 3 days, stored as 00:00 UTC.
			const next = advanceNextInvoiceAt(
				a,
				new Date("2026-11-28T00:00:00Z"),
			);
			expect(next.toISOString()).toBe("2026-12-29T06:00:00.000Z");
		});
	});

	it("Auckland weekly new-row round trip stays on Monday", () => {
		const a = anchor({
			frequency: "weekly",
			dayOfWeek: "MO",
			dayOfMonth: null,
			timezone: "Pacific/Auckland",
		});
		const first = calculateNextInvoiceAt(a, {
			from: new Date("2026-11-22T12:00:00Z"),
		});
		expect(first.toISOString()).toBe("2026-11-22T11:00:00.000Z");
		expect(advanceNextInvoiceAt(a, first).toISOString()).toBe(
			"2026-11-29T11:00:00.000Z",
		);
	});

	it("weekly advance re-snaps a drifted row to dayOfWeek", () => {
		const a = anchor({
			frequency: "weekly",
			dayOfWeek: "MO",
			dayOfMonth: null,
			timezone: "Pacific/Auckland",
		});
		// Tue Dec 1 00:00 NZDT, one day off its Monday anchor.
		const next = advanceNextInvoiceAt(a, new Date("2026-11-30T11:00:00Z"));
		expect(toLocalDate(next, "Pacific/Auckland")).toBe("2026-12-07");
	});

	describe("notBeforeAfterBilled", () => {
		const startsAt = new Date("2026-01-01T06:00:00Z");

		it("edit on the billing day after the run bills next month, not today", () => {
			const notBefore = notBeforeAfterBilled(TZ, startsAt, {
				last_invoiced_at: new Date("2026-11-23T06:05:00Z"),
				generate_days_before: 0,
			});
			const next = calculateNextInvoiceAt(
				anchor({ dayOfMonth: 23, generateDaysBefore: 2 }),
				{ from: new Date("2026-11-23T21:00:00Z"), notBefore },
			);
			expect(next.toISOString()).toBe("2026-12-21T06:00:00.000Z");
		});

		it("counts the billed period's generate_days_before", () => {
			// Generated Nov 18 for the Nov 23 billing date.
			const notBefore = notBeforeAfterBilled(TZ, startsAt, {
				last_invoiced_at: new Date("2026-11-18T06:05:00Z"),
				generate_days_before: 5,
			});
			expect(toLocalDate(notBefore, TZ)).toBe("2026-11-24");
		});

		it("starts_at wins when later; no billing history falls back to starts_at", () => {
			const late = new Date("2027-03-01T06:00:00Z");
			expect(
				notBeforeAfterBilled(TZ, late, {
					last_invoiced_at: new Date("2026-11-23T06:05:00Z"),
					generate_days_before: 0,
				}),
			).toEqual(late);
			expect(notBeforeAfterBilled(TZ, startsAt, null)).toEqual(startsAt);
		});

		it("a stored next_invoice_at's billing date is the floor, over last_invoiced_at", () => {
			// Late weekly run on Nov 27 billed Nov 23; next is Nov 30 billing (gdb 3).
			const notBefore = notBeforeAfterBilled(TZ, startsAt, {
				next_invoice_at: new Date("2026-11-27T06:00:00Z"),
				last_invoiced_at: new Date("2026-11-27T15:00:00Z"),
				generate_days_before: 3,
			});
			expect(toLocalDate(notBefore, TZ)).toBe("2026-11-30");
		});
	});
});
