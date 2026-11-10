import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, getScopedDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
		job: { findFirst: vi.fn(), findMany: vi.fn() },
		job_visit: { findMany: vi.fn() },
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb, getScopedDb: vi.fn(() => mockDb) };
});

vi.mock("../../db.js", () => ({ db: mockDb }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb,
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));
vi.mock("../../lib/documentLineage.js", () => ({
	resolveDocumentLineage: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn(),
	syncInvoicePaymentTotals: vi.fn(),
	lockInvoiceTaxSnapshot: vi.fn(),
	invoicePaidTotal: vi.fn(),
	createInvoiceRecord: vi.fn(),
	recomputeInvoiceTotals: vi.fn(),
	invoiceInclude: {
		jobs: { include: { job: { select: {} } } },
		visits: { include: { visit: { select: {} } } },
	},
}));
vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn(),
	pushInvoiceDetached: vi.fn(),
}));
vi.mock("../../services/qb/qbAstAuthority.js", () => ({ confirmQuickBooksTax: vi.fn() }));
vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn().mockResolvedValue(false),
	getOrgRealmId: vi.fn(),
}));
vi.mock("../../services/disputeService.js", () => ({
	openDisputeStatusChangeRefusal: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getInvoiceDetail } from "../invoicesController.js";

const invoice = { id: "inv1", line_items: [], jobs: [], visits: [] };

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.invoice.findFirst.mockResolvedValue(invoice);
});

describe("getInvoiceDetail parent_tax_snapshot", () => {
	it("is the earliest-created linked job's snapshot, looked up in the org's scoped db", async () => {
		const snapshot = { version: 2, source: "provider", rate_set_id: "rs-1" };
		mockDb.job.findFirst.mockResolvedValue({ tax_snapshot: snapshot });

		const detail = await getInvoiceDetail("inv1", "org1");

		expect(detail?.parent_tax_snapshot).toEqual(snapshot);
		expect(mockDb.job.findFirst).toHaveBeenCalledWith({
			where: { invoice_jobs: { some: { invoice_id: "inv1" } } },
			orderBy: { created_at: "asc" },
			select: { tax_snapshot: true },
		});
		expect(getScopedDb).toHaveBeenCalledWith("org1");
		expect(getScopedDb.mock.calls.every(([org]) => org === "org1")).toBe(true);
	});

	it("is null when no job is linked", async () => {
		mockDb.job.findFirst.mockResolvedValue(null);
		const detail = await getInvoiceDetail("inv1", "org1");
		expect(detail?.parent_tax_snapshot).toBeNull();
	});
});
