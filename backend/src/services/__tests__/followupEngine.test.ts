import { describe, it, expect, vi } from "vitest";
import {
	delayToMs,
	computeNextSendAt,
	computeReminderSendAt,
	isBeforeAnchor,
	resolveStepSendAt,
	decideStep,
	evaluateAnchorStop,
	resolveContactEmail,
	type AnchorLookupDb,
} from "../followupEngine.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE = new Date("2026-07-08T12:00:00.000Z");

describe("delayToMs", () => {
	it("converts hours and days", () => {
		expect(delayToMs(3, "hours")).toBe(3 * HOUR);
		expect(delayToMs(2, "days")).toBe(2 * DAY);
	});
	it("falls back to days for unknown units", () => {
		expect(delayToMs(1, "weeks")).toBe(DAY);
	});
	it("handles zero", () => {
		expect(delayToMs(0, "hours")).toBe(0);
	});
});

describe("computeNextSendAt (after-base)", () => {
	it("adds the delay to the base time", () => {
		expect(computeNextSendAt({ delay_amount: 2, delay_unit: "days" }, BASE).toISOString()).toBe(
			new Date(BASE.getTime() + 2 * DAY).toISOString(),
		);
	});
	it("delay 0 returns the base time (send immediately)", () => {
		expect(computeNextSendAt({ delay_amount: 0, delay_unit: "days" }, BASE).getTime()).toBe(BASE.getTime());
	});
});

describe("computeReminderSendAt (before-anchor)", () => {
	it("subtracts the delay from the anchor", () => {
		expect(computeReminderSendAt(BASE, { delay_amount: 1, delay_unit: "days" }).toISOString()).toBe(
			new Date(BASE.getTime() - DAY).toISOString(),
		);
		expect(computeReminderSendAt(BASE, { delay_amount: 1, delay_unit: "hours" }).getTime()).toBe(BASE.getTime() - HOUR);
	});
});

describe("isBeforeAnchor", () => {
	it("only visit_scheduled is before-anchor", () => {
		expect(isBeforeAnchor("visit_scheduled")).toBe(true);
		expect(isBeforeAnchor("quote_sent")).toBe(false);
		expect(isBeforeAnchor("manual")).toBe(false);
		expect(isBeforeAnchor("date_based")).toBe(false);
	});
});

describe("resolveStepSendAt", () => {
	const step = { delay_amount: 1, delay_unit: "days" };
	it("before-anchor uses anchorAt - delay", () => {
		const at = resolveStepSendAt({ trigger_type: "visit_scheduled", stop_on_open: false }, step, {
			base: BASE,
			anchorAt: BASE,
		});
		expect(at.getTime()).toBe(BASE.getTime() - DAY);
	});
	it("before-anchor with no anchor falls back to base", () => {
		const at = resolveStepSendAt({ trigger_type: "visit_scheduled", stop_on_open: false }, step, {
			base: BASE,
			anchorAt: null,
		});
		expect(at.getTime()).toBe(BASE.getTime());
	});
	it("after-base uses base + delay", () => {
		const at = resolveStepSendAt({ trigger_type: "quote_sent", stop_on_open: true }, step, {
			base: BASE,
			anchorAt: null,
		});
		expect(at.getTime()).toBe(BASE.getTime() + DAY);
	});
});

describe("decideStep (opens-only chaining)", () => {
	const opened = { opened_at: new Date() };
	const notOpened = { opened_at: null };
	const always = { condition: "always" };
	const gated = { condition: "if_previous_not_opened" };

	it("first step (no prior send) always sends", () => {
		expect(decideStep(gated, null, { trigger_type: "quote_sent", stop_on_open: true }).action).toBe("send");
	});
	it("stops when previous opened and sequence stops-on-open", () => {
		const d = decideStep(always, opened, { trigger_type: "quote_sent", stop_on_open: true });
		expect(d.action).toBe("stop");
		expect(d.reason).toBe("recipient_opened");
	});
	it("stops when previous opened and step gated on not-opened", () => {
		expect(decideStep(gated, opened, { trigger_type: "quote_sent", stop_on_open: false }).action).toBe("stop");
	});
	it("continues when opened but stop_on_open=false and step condition=always (broadcast)", () => {
		expect(decideStep(always, opened, { trigger_type: "manual", stop_on_open: false }).action).toBe("send");
	});
	it("sends when previous not opened", () => {
		expect(decideStep(gated, notOpened, { trigger_type: "quote_sent", stop_on_open: true }).action).toBe("send");
	});
});

describe("resolveContactEmail", () => {
	it("returns null when no contact has an email", () => {
		expect(resolveContactEmail([])).toBeNull();
		expect(resolveContactEmail([{ is_primary: true, contact: { email: null } }])).toBeNull();
		expect(resolveContactEmail([{ is_primary: true, contact: null }])).toBeNull();
	});
	it("prefers primary among contacts that have an email", () => {
		expect(
			resolveContactEmail([
				{ is_billing: true, contact: { email: "billing@x.com" } },
				{ is_primary: true, contact: { email: "primary@x.com" } },
			]),
		).toBe("primary@x.com");
	});
	it("skips a primary contact with a null email and falls back to billing/first with an email", () => {
		expect(
			resolveContactEmail([
				{ is_primary: true, contact: { email: null } },
				{ is_billing: true, contact: { email: "billing@x.com" } },
			]),
		).toBe("billing@x.com");
		expect(
			resolveContactEmail([
				{ is_primary: true, contact: { email: null } },
				{ contact: { email: "first@x.com" } },
			]),
		).toBe("first@x.com");
	});
});

describe("evaluateAnchorStop", () => {
	function makeDb(overrides: Partial<Record<keyof AnchorLookupDb, { status: string } | null>>): AnchorLookupDb {
		const mk = (val: { status: string } | null | undefined) => ({ findUnique: vi.fn().mockResolvedValue(val ?? null) });
		return {
			quote: mk(overrides.quote),
			invoice: mk(overrides.invoice),
			request: mk(overrides.request),
			job_visit: mk(overrides.job_visit),
		} as unknown as AnchorLookupDb;
	}

	it("returns null when there is no anchor", async () => {
		expect(await evaluateAnchorStop(null, null, makeDb({}))).toBeNull();
		expect(await evaluateAnchorStop("quote", null, makeDb({}))).toBeNull();
	});

	it("quote: stops on terminal statuses, continues otherwise", async () => {
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Approved" } }))).toBe("quote_approved");
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Rejected" } }))).toBe("quote_rejected");
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Sent" } }))).toBeNull();
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: null }))).toBe("quote_missing");
	});

	// The chase is enrolled at send time, so a quote that later goes into
	// dispute is still on the sequence: without these the client gets a
	// "just checking in on that quote" email about the document they are
	// contesting, and a superseded original keeps being chased after
	// Revise & Resend.
	it("quote: stops chasing a disputed or superseded quote", async () => {
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Disputed" } }))).toBe(
			"quote_disputed",
		);
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Revised" } }))).toBe(
			"quote_revised",
		);
		// Still chased — these are the states the sequence exists for.
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Viewed" } }))).toBeNull();
		expect(await evaluateAnchorStop("quote", "q1", makeDb({ quote: { status: "Issued" } }))).toBeNull();
	});

	// The invoice mirror of the quote case above, and the more damaging half:
	// a payment-reminder sequence that keeps running through a dispute demands
	// money for the exact balance the client has contested.
	it("invoice: stops chasing a disputed invoice", async () => {
		expect(await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "Disputed" } }))).toBe(
			"invoice_disputed",
		);
		// Still chased — an adjustment restores the invoice to one of these,
		// and it is collectible again from that point.
		expect(await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "Viewed" } }))).toBeNull();
		expect(
			await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "PartiallyPaid" } })),
		).toBeNull();
	});

	it("invoice: stops when Paid/Void", async () => {
		expect(await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "Paid" } }))).toBe("invoice_paid");
		expect(await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "Void" } }))).toBe("invoice_void");
		expect(await evaluateAnchorStop("invoice", "i1", makeDb({ invoice: { status: "Sent" } }))).toBeNull();
	});

	it("request: continues only while New/Reviewing", async () => {
		expect(await evaluateAnchorStop("request", "r1", makeDb({ request: { status: "New" } }))).toBeNull();
		expect(await evaluateAnchorStop("request", "r1", makeDb({ request: { status: "Reviewing" } }))).toBeNull();
		expect(await evaluateAnchorStop("request", "r1", makeDb({ request: { status: "Quoted" } }))).toBe("request_quoted");
	});

	it("job_visit: stops when Cancelled/Completed", async () => {
		expect(await evaluateAnchorStop("job_visit", "v1", makeDb({ job_visit: { status: "Cancelled" } }))).toBe(
			"visit_cancelled",
		);
		expect(await evaluateAnchorStop("job_visit", "v1", makeDb({ job_visit: { status: "Scheduled" } }))).toBeNull();
	});

	it("unknown anchor type returns null", async () => {
		expect(await evaluateAnchorStop("widget", "x1", makeDb({}))).toBeNull();
	});
});
