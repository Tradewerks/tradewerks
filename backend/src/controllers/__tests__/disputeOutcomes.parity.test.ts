import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hoisted shape as disputes.authz.test.ts, so db.js and lib/context.js
// share one instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		invoice: {
			findFirst: vi.fn(),
			findMany: vi.fn(async () => []),
			update: vi.fn(),
			create: vi.fn(),
			count: vi.fn(async () => 0),
		},
		document_dispute: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateInvoiceNumber: vi.fn(async () => "INV-1"),
	generateQuoteNumber: vi.fn(async () => "Q-1"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
	invoicePaidTotal: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { listDisputes, postResolution } from "../disputesController.js";
import {
	NO_RESOLVE_PERMISSION,
	openDispute,
	type OutcomeState,
} from "../../services/disputeService.js";
import {
	soldJobReason,
	voidBlockedByAdjustmentReason,
	voidBlockedByPaymentReason,
} from "../../services/disputeAdapters.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

type Kind = "quote" | "invoice";
type Outcome = OutcomeState["id"];
interface Authz {
	canConcede: boolean;
	canRefund: boolean;
	canResolveOwn: boolean;
}

const OUTCOMES: Outcome[] = ["ReviseAndResend", "IssueAdjustment", "Repeal"];
const OPENERS: (string | null)[] = ["d1", "d2", null];
const AUTHZ: Authz[] = [false, true].flatMap((canConcede) =>
	[false, true].flatMap((canRefund) =>
		[false, true].map((canResolveOwn) => ({ canConcede, canRefund, canResolveOwn })),
	),
);
const LOST_RACE = "This dispute was already resolved by someone else.";

const permissionsFor = (authz: Authz) => [
	"resolve_disputes",
	...(authz.canConcede ? ["concede_disputes"] : []),
	...(authz.canRefund ? ["refund_invoices"] : []),
	...(authz.canResolveOwn ? ["resolve_own_disputes"] : []),
];

const reqFor = (permissions: string[], body?: unknown) =>
	({
		body,
		user: { organization_id: "org1", uid: "d1", role: "dispatcher", permissions },
		params: {},
		headers: {},
	}) as unknown as Request;

const bodyFor = (outcome: Outcome) =>
	outcome === "IssueAdjustment"
		? {
				resolution: outcome,
				note: "n",
				adjustment_lines: [{ name: "Credit", quantity: -1, unit_price: 10, total: -10 }],
			}
		: { resolution: outcome, note: "n" };

const aQuote = (over: Record<string, unknown> = {}) => ({
	id: "q1",
	status: "Disputed",
	organization_id: "org1",
	line_items: [],
	job: null,
	request: null,
	...over,
});

const anInvoice = (over: Record<string, unknown> = {}) => ({
	id: "inv1",
	status: "Disputed",
	organization_id: "org1",
	line_items: [],
	amount_paid: 0,
	adjustments: [],
	qb_invoice_id: null,
	...over,
});

const ADJUSTED = [{ id: "adj1", invoice_number: "INV-1001" }];

const DOCUMENTS: Record<Kind, [string, Record<string, unknown>][]> = {
	quote: [
		["an open offer", aQuote()],
		["a quote sold as a job", aQuote({ job: { id: "j1" } })],
		[
			"a quote whose sibling sold",
			aQuote({
				request: {
					id: "r1",
					status: "ConvertedToJob",
					jobs: [{ id: "j9", job_number: "J-0009", quote_id: "q-sibling" }],
				},
			}),
		],
		["a quote cancelled under the dispute", aQuote({ status: "Cancelled" })],
	],
	invoice: [
		["an unpaid invoice", anInvoice()],
		["a paid invoice", anInvoice({ amount_paid: 120 })],
		["an adjusted invoice", anInvoice({ adjustments: ADJUSTED })],
		["a paid, adjusted invoice", anInvoice({ amount_paid: 120, adjustments: ADJUSTED })],
		["an invoice voided under the dispute", anInvoice({ status: "Void" })],
	],
};

function arrange(kind: Kind, doc: Record<string, unknown>, openedBy: string | null) {
	const dispute = {
		id: "disp1",
		status: "Open",
		document_kind: kind,
		quote_id: kind === "quote" ? doc.id : null,
		invoice_id: kind === "invoice" ? doc.id : null,
		status_at_open: "Sent",
		opened_by_dispatcher_id: openedBy,
	};
	mockFn(kind === "quote" ? db.quote.findFirst : db.invoice.findFirst).mockResolvedValue(doc);
	mockFn(db.document_dispute.findFirst).mockResolvedValue(dispute);
	mockFn(db.document_dispute.findMany).mockResolvedValue([dispute]);
	// Losing the swap is how a resolution that clears every refusal stops
	// without executing its outcome.
	mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 0 });
}

/** The write path's refusal, or null when it got as far as the swap. */
async function submitted(kind: Kind, id: string, authz: Authz, outcome: Outcome) {
	const result = await postResolution(kind, id, "disp1", reqFor(permissionsFor(authz), bodyFor(outcome)));
	const err = (result as { err?: string }).err ?? null;
	return err === LOST_RACE ? null : err;
}

async function reported(kind: Kind, id: string, permissions: string[]) {
	const list = await listDisputes(kind, id, reqFor(permissions));
	return list.disputes[0].outcomes as OutcomeState[];
}

/**
 * Ruling P11: a disabled outcome's reason is the refusal a submit would have
 * returned. Both used to be produced separately — the modal from raw evidence
 * in its own order, the server in another — and they disagreed in reachable
 * states (DW-18). Now one function answers both; this pins them together
 * across every document state, grant combination and opener.
 */
describe("the dispute list reports exactly what a submit would answer", () => {
	beforeEach(() => vi.clearAllMocks());

	for (const kind of ["quote", "invoice"] as const) {
		for (const [label, doc] of DOCUMENTS[kind]) {
			it(`${kind}: ${label}`, async () => {
				const mismatches: string[] = [];
				let open = 0;
				let closed = 0;
				for (const authz of AUTHZ) {
					for (const openedBy of OPENERS) {
						arrange(kind, doc, openedBy);
						const states = await reported(kind, doc.id as string, permissionsFor(authz));
						expect(states.map((s) => s.id)).toEqual(OUTCOMES);
						for (const state of states) {
							const answer = await submitted(kind, doc.id as string, authz, state.id);
							if (state.reason !== answer || state.disabled !== (answer !== null)) {
								mismatches.push(
									`${state.id} ${JSON.stringify(authz)} opener=${openedBy}: list=${state.reason} submit=${answer}`,
								);
							}
							if (answer === null) open++;
							else closed++;
						}
					}
				}
				expect(mismatches).toEqual([]);
				// A matrix that never opens, or never closes, proves nothing.
				if (!label.includes("under the dispute")) expect(open).toBeGreaterThan(0);
				expect(closed).toBeGreaterThan(0);
			});
		}
	}

	// The two states DW-18 found, named so a regression reads as what it is.
	it("explains a paid invoice's Repeal by the money, not the missing grant", async () => {
		arrange("invoice", anInvoice({ amount_paid: 300 }), "d2");
		const repeal = (await reported("invoice", "inv1", ["resolve_disputes"])).find(
			(s) => s.id === "Repeal",
		);
		expect(repeal?.reason).toBe(
			"This invoice has $300.00 applied. Issue an adjustment instead — voiding would strand the payment.",
		);
		expect(
			await submitted("invoice", "inv1", { canConcede: false, canRefund: false, canResolveOwn: false }, "Repeal"),
		).toBe(repeal?.reason);
	});

	it("explains a sold sibling before separation of duties", async () => {
		arrange("quote", DOCUMENTS.quote[2][1], "d1");
		const revise = (await reported("quote", "q1", ["resolve_disputes", "concede_disputes"])).find(
			(s) => s.id === "ReviseAndResend",
		);
		expect(revise?.reason).toMatch(/^Another quote on this request was already sold/);
	});

	// The route gate answers before the service, so it answers first here too.
	it("closes every outcome for a caller without resolve_disputes", async () => {
		arrange("invoice", anInvoice(), "d2");
		const states = await reported("invoice", "inv1", ["view_invoices", "concede_disputes"]);
		expect(states.every((s) => s.disabled && s.reason === NO_RESOLVE_PERMISSION)).toBe(true);
	});

	it("reports no outcomes on a resolved dispute", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ status: "Sent" }));
		mockFn(db.document_dispute.findMany).mockResolvedValue([
			{ id: "disp0", status: "Resolved", opened_by_dispatcher_id: "d2" },
		]);
		const list = await listDisputes("invoice", "inv1", reqFor(["resolve_disputes"]));
		expect(list.disputes[0].outcomes).toBeNull();
		expect(list.open_refusal).toBeNull();
	});
});

/**
 * DW-19 / M1 / M3: the lifecycle bar's Convert-to-Job and kebab-Void sentences
 * used to be hand-copied into quoteActions/invoiceActions. They now ride on the
 * dispute payload as `sold_refusal` / `void_refusal`, produced by the same
 * `soldJobReason` and `voidBlockedByPayment/Adjustment` functions the write
 * paths refuse with — insertJob's `quoteConversionRefusal` (jobsController) and
 * updateInvoice's kebab-Void guard (invoicesController), both pinned to those
 * producers by the Phase 1 controller tests. This closes the chain on the read
 * side.
 */
describe("the dispute list carries the write-path Convert and Void refusals", () => {
	beforeEach(() => vi.clearAllMocks());

	for (const [label, doc] of DOCUMENTS.quote) {
		it(`quote: sold_refusal matches soldJobReason for ${label}`, async () => {
			arrange("quote", doc, "d1");
			const list = await listDisputes("quote", doc.id as string, reqFor(["open_disputes"]));
			expect(list.sold_refusal).toBe(
				soldJobReason(doc as unknown as Parameters<typeof soldJobReason>[0]),
			);
			expect(list.void_refusal).toBeNull();
		});
	}

	for (const [label, doc] of DOCUMENTS.invoice) {
		it(`invoice: void_refusal matches the kebab-Void guard for ${label}`, async () => {
			arrange("invoice", doc, "d1");
			const list = await listDisputes("invoice", doc.id as string, reqFor(["open_disputes"]));
			const expected =
				voidBlockedByPaymentReason(Number((doc as { amount_paid?: number }).amount_paid ?? 0)) ??
				voidBlockedByAdjustmentReason(
					((doc as { adjustments?: { invoice_number: string }[] }).adjustments ?? []),
				);
			expect(list.void_refusal).toBe(expected);
			expect(list.sold_refusal).toBeNull();
		});
	}

	it("names the adjustment in void_refusal so the bar can show which to void first", async () => {
		arrange("invoice", anInvoice({ adjustments: ADJUSTED }), "d1");
		const list = await listDisputes("invoice", "inv1", reqFor(["open_disputes"]));
		expect(list.void_refusal).toBe("INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.");
	});
});

/**
 * DW-17: the open door's refusal had drifted from the button's ("cannot" on
 * one side, "can't" on the other) while each side pinned its own copy. The
 * list's open_refusal is now the open door's own sentence.
 */
describe("the dispute list reports why a dispute can't be opened", () => {
	beforeEach(() => vi.clearAllMocks());

	const opened = (kind: Kind, id: string) =>
		openDispute(kind, id, { reason: "wrong total" }, "org1", { dispatcherId: "d1" });

	it.each([
		["quote", aQuote({ status: "Draft" })],
		["invoice", anInvoice({ status: "Void" })],
	] as const)("names the statuses for a %s that can't take one", async (kind, doc) => {
		mockFn(kind === "quote" ? db.quote.findFirst : db.invoice.findFirst).mockResolvedValue(doc);
		mockFn(db.document_dispute.findMany).mockResolvedValue([]);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const list = await listDisputes(kind, doc.id, reqFor(["open_disputes"]));
		const refusal = await opened(kind, doc.id);

		expect(list.open_refusal).toMatch(/can't be disputed/);
		expect(list.open_refusal).toBe((refusal as { err: string }).err);
	});

	it("reports an open dispute the way the open door refuses a second one", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ status: "Sent" }));
		mockFn(db.document_dispute.findMany).mockResolvedValue([
			{ id: "disp1", status: "Open", opened_by_dispatcher_id: "d2" },
		]);
		mockFn(db.document_dispute.findFirst).mockResolvedValue({ id: "disp1" });

		const list = await listDisputes("invoice", "inv1", reqFor(["open_disputes"]));
		const refusal = await opened("invoice", "inv1");

		expect(list.open_refusal).toBe((refusal as { err: string }).err);
	});

	it("reports nothing when a dispute can be opened", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote({ status: "Sent" }));
		mockFn(db.document_dispute.findMany).mockResolvedValue([]);

		const list = await listDisputes("quote", "q1", reqFor(["open_disputes"]));

		expect(list.open_refusal).toBeNull();
	});
});
