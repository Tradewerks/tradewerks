import { describe, it, expect, vi } from "vitest";

/**
 * Every dispute, refund, reject and cancel test in this changeset calls the
 * service or the controller directly, so the routers themselves — and the
 * permission gate attached to each route — were never exercised. A transposed
 * string (`edit_quotes` on the invoice refund route) or a `requirePermission`
 * dropped during a refactor would ship green.
 *
 * requirePermission is a factory, so the permission it closes over is not
 * readable from the mounted handler. Mocking the factory to tag the middleware
 * it returns makes the string assertable per route, which is the actual claim:
 * these routes are gated, and gated on the right permission.
 */
vi.mock("../../lib/requirePermissions.js", () => ({
	requirePermission: (permission: string) => {
		const mw = (_req: unknown, _res: unknown, next: () => void) => next();
		(mw as unknown as { __permission: string }).__permission = permission;
		return mw;
	},
	requireAnyPermission: (...permissions: string[]) => {
		const mw = (_req: unknown, _res: unknown, next: () => void) => next();
		(mw as unknown as { __permission: string }).__permission =
			permissions.join("|");
		return mw;
	},
	requirePermissionForBody: (
		permission: string,
		applies: (body: unknown) => boolean,
	) => {
		const mw = (_req: unknown, _res: unknown, next: () => void) => next();
		(mw as unknown as { __permission: string }).__permission = permission;
		(mw as unknown as { __applies: unknown }).__applies = applies;
		return mw;
	},
	requireVehiclePermission: () => (_r: unknown, _s: unknown, n: () => void) =>
		n(),
}));

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateQuoteNumber: vi.fn(),
	generateInvoiceNumber: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../services/emailService.js", () => ({
	sendQuoteEmail: vi.fn(),
	sendInvoiceEmail: vi.fn(),
}));

vi.mock("../../lib/pdf/pdfService.js", () => ({
	generateQuotePdf: vi.fn(),
	generateInvoicePdf: vi.fn(),
}));

vi.mock("../../services/followupTriggers.js", () => ({
	onQuoteSent: vi.fn(),
	onInvoiceSent: vi.fn(),
}));

vi.mock("../../services/invoiceService.js", () => ({
	createInvoiceRecord: vi.fn(),
}));

vi.mock("../../services/invoiceGenerator.js", () => ({
	buildVisitInvoicePayload: vi.fn(),
	buildRecurringPlanInvoicePayload: vi.fn(),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import quotesRouter from "../quotes.js";
import invoicesRouter from "../invoices.js";
import disputesRouter from "../disputes.js";
import quickbooksRouter from "../quickbooks.js";
import { getHandlers } from "./harness.js";

/** The permission strings the gates on a route close over, in mount order. */
const permissionsFor = (
	router: Parameters<typeof getHandlers>[0],
	method: string,
	path: string,
): string[] =>
	getHandlers(router, method, path)
		.map((h) => (h as unknown as { __permission?: string }).__permission)
		.filter((p): p is string => typeof p === "string");

/** Every {method, path} actually mounted on a router, read off its own
 *  stack — so a route added after this test was written is still seen. */
const allRoutes = (
	router: Parameters<typeof getHandlers>[0],
): Array<{ method: string; path: string }> => {
	const stack = (
		router as unknown as {
			stack: Array<{
				route?: { path: string; methods: Record<string, boolean> };
			}>;
		}
	).stack;
	const out: Array<{ method: string; path: string }> = [];
	for (const layer of stack) {
		if (!layer.route) continue;
		for (const method of Object.keys(layer.route.methods)) {
			if (layer.route.methods[method]) out.push({ method, path: layer.route.path });
		}
	}
	return out;
};

describe("dispute route permission gates", () => {
	// Reads stay on view_*. Writes move off edit_*: opening a dispute is not a
	// document edit (the person who takes the client's call often has no edit
	// rights), and resolving one is a money decision that edit_* must not carry.
	//
	// toContain, not toEqual([expected]): the write doors also carry view_*
	// (DW-65 — their refusals can echo status/amount to a caller who couldn't
	// otherwise see the document), so a route legitimately closes over more
	// than one permission. A per-route case still fails if its own permission
	// is missing or wrong.
	const cases: Array<[string, string, string, string]> = [
		["quotes", "get", "/:quoteId/disputes", "view_quotes"],
		["quotes", "post", "/:quoteId/disputes", "open_disputes"],
		["quotes", "post", "/:quoteId/disputes", "view_quotes"],
		[
			"quotes",
			"post",
			"/:quoteId/disputes/:disputeId/resolve",
			"resolve_disputes",
		],
		[
			"quotes",
			"post",
			"/:quoteId/disputes/:disputeId/resolve",
			"view_quotes",
		],
		["invoices", "get", "/:invoiceId/disputes", "view_invoices"],
		["invoices", "post", "/:invoiceId/disputes", "open_disputes"],
		["invoices", "post", "/:invoiceId/disputes", "view_invoices"],
		[
			"invoices",
			"post",
			"/:invoiceId/disputes/:disputeId/resolve",
			"resolve_disputes",
		],
		[
			"invoices",
			"post",
			"/:invoiceId/disputes/:disputeId/resolve",
			"view_invoices",
		],
	];

	for (const [which, method, path, expected] of cases) {
		it(`${method.toUpperCase()} /${which}${path} requires ${expected}`, () => {
			const router = which === "quotes" ? quotesRouter : invoicesRouter;
			expect(permissionsFor(router, method, path)).toContain(expected);
		});
	}

	it("GET /disputes/open is gated on either document view permission", () => {
		expect(permissionsFor(disputesRouter, "get", "/open")).toEqual(["view_quotes|view_invoices"]);
	});

	// Enumerated from the router's actual stack rather than a hand-maintained
	// list of paths, so a new /disputes sub-route (a comment endpoint, say)
	// is covered the moment it is mounted — DW-66's "can't see a new route".
	it("gates every mounted /disputes route on both routers", () => {
		for (const router of [quotesRouter, invoicesRouter]) {
			const disputeRoutes = allRoutes(router).filter(({ path }) =>
				path.includes("/disputes"),
			);
			expect(disputeRoutes.length).toBeGreaterThan(0);
			for (const { method, path } of disputeRoutes) {
				expect(
					permissionsFor(router, method, path).length,
				).toBeGreaterThan(0);
			}
		}
	});
});

describe("money-mutating route permission gates", () => {
	// A refund writes a negative invoice_payment row — cash leaving the
	// business. It belongs behind its own gate, not behind the permission that
	// also lets someone correct a due date.
	it("POST /invoices/:invoiceId/refunds requires refund_invoices", () => {
		expect(
			permissionsFor(invoicesRouter, "post", "/:invoiceId/refunds"),
		).toEqual(["refund_invoices"]);
	});

	// Voiding is a PATCH on the same route that renames a memo, so the cash-out
	// gate cannot sit on the route — it has to read what the body is asking for.
	it("PATCH /invoices/:id gates a void on refund_invoices", () => {
		expect(permissionsFor(invoicesRouter, "patch", "/:id")).toEqual([
			"edit_invoices",
			"refund_invoices",
		]);
	});

	it("PATCH /invoices/:id leaves non-void edits on edit_invoices alone", () => {
		const conditional = getHandlers(invoicesRouter, "patch", "/:id")
			.map((h) => h as unknown as { __applies?: (b: unknown) => boolean })
			.find((h) => typeof h.__applies === "function");
		expect(conditional?.__applies?.({ status: "Void" })).toBe(true);
		expect(conditional?.__applies?.({ memo: "typo fix" })).toBe(false);
		expect(conditional?.__applies?.(undefined)).toBe(false);
	});

	// Deleting a payment row reverses recorded cash and re-syncs the invoice
	// totals, which is a payment void by another name.
	it("DELETE /invoices/:invoiceId/payments/:paymentId requires refund_invoices", () => {
		expect(
			permissionsFor(
				invoicesRouter,
				"delete",
				"/:invoiceId/payments/:paymentId",
			),
		).toEqual(["refund_invoices"]);
	});

	it("POST /quotes/:id/reject requires edit_quotes", () => {
		expect(permissionsFor(quotesRouter, "post", "/:id/reject")).toEqual([
			"edit_quotes",
		]);
	});

	it("POST /quotes/:id/cancel requires edit_quotes", () => {
		expect(permissionsFor(quotesRouter, "post", "/:id/cancel")).toEqual([
			"edit_quotes",
		]);
	});

	// The gate has to be present, not merely correct where present. An ungated
	// route yields an empty list, so this states the invariant for the whole
	// set rather than relying on each assertion above being kept in step.
	it("leaves no new dispute or money route ungated", () => {
		const routes: Array<
			[Parameters<typeof getHandlers>[0], string, string]
		> = [
			[quotesRouter, "get", "/:quoteId/disputes"],
			[quotesRouter, "post", "/:quoteId/disputes"],
			[quotesRouter, "post", "/:quoteId/disputes/:disputeId/resolve"],
			[quotesRouter, "post", "/:id/reject"],
			[quotesRouter, "post", "/:id/cancel"],
			[invoicesRouter, "get", "/:invoiceId/disputes"],
			[invoicesRouter, "post", "/:invoiceId/disputes"],
			[invoicesRouter, "post", "/:invoiceId/disputes/:disputeId/resolve"],
			[invoicesRouter, "post", "/:invoiceId/refunds"],
			[invoicesRouter, "patch", "/:id"],
			[invoicesRouter, "delete", "/:invoiceId/payments/:paymentId"],
		];

		for (const [router, method, path] of routes) {
			expect(permissionsFor(router, method, path).length).toBeGreaterThan(
				0,
			);
		}
	});
});

describe("document send route permission gates", () => {
	// Emailing a quote to the client is not a document edit. A clerk who mails
	// out finished documents has no business changing the prices on them, and an
	// estimator who drafts them has no business contacting the client. Riding on
	// edit_* made both roles impossible to express.
	it("POST /quotes/:id/send requires send_quotes", () => {
		expect(permissionsFor(quotesRouter, "post", "/:id/send")).toEqual([
			"send_quotes",
		]);
	});

	it("POST /invoices/:id/send requires send_invoices", () => {
		expect(permissionsFor(invoicesRouter, "post", "/:id/send")).toEqual([
			"send_invoices",
		]);
	});

	// Mailing an invoice through QuickBooks is the same business act as mailing
	// it through Postmark. This route carried no gate at all, so send_invoices
	// was a permission with a door standing open next to it.
	it("POST /integrations/quickbooks/invoices/:id/email requires send_invoices", () => {
		expect(
			permissionsFor(quickbooksRouter, "post", "/invoices/:id/email"),
		).toEqual(["send_invoices"]);
	});

	// The gate is the whole point of the permission: a send route that lost its
	// requirePermission during a refactor would ship green without this.
	it("leaves no send route ungated", () => {
		for (const router of [quotesRouter, invoicesRouter]) {
			const sendRoutes = allRoutes(router).filter(({ path }) =>
				path.endsWith("/send"),
			);
			expect(sendRoutes.length).toBeGreaterThan(0);
			for (const { method, path } of sendRoutes) {
				expect(
					permissionsFor(router, method, path).length,
				).toBeGreaterThan(0);
			}
		}
	});
});
