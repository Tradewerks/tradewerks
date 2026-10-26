/**
 * line.tax_group_id is an FK to tax_group but not to the caller's org, so every path that writes
 * one must check ownership before the line is stored.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		client: { findFirst: vi.fn() },
		quote: { create: vi.fn() },
		quote_line_item: { createMany: vi.fn() },
		invoice: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
		invoice_line_item: { create: vi.fn(), update: vi.fn(), delete: vi.fn() },
		inventory_item: { findMany: vi.fn() },
		tax_group: { count: vi.fn(), findMany: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateQuoteNumber: vi.fn().mockResolvedValue("Q-1001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../lib/geocode.js", () => ({ fillCoords: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeDocumentTotals: vi.fn(async () => ({ ok: true })),
	lockDocumentTaxSnapshot: vi.fn(),
}));

vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue([]),
	invoicePaidTotal: vi.fn().mockResolvedValue(0),
	createInvoiceRecord: vi.fn().mockResolvedValue(undefined),
	recomputeInvoiceTotals: vi.fn().mockResolvedValue(undefined),
	invoiceInclude: {},
}));

vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn().mockResolvedValue(undefined),
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
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/entitlementService.js", () => ({ isModuleOn: vi.fn() }));

vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: vi.fn(async () => "manual"),
}));

import type { Request } from "express";
import { insertQuote } from "../quotesController.js";
import { updateInvoice } from "../invoicesController.js";

const ORG = "org1";
const FOREIGN_GROUP = "9b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8";
const CLIENT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const line = { name: "Condenser fan", quantity: 1, unit_price: 120, tax_group_id: FOREIGN_GROUP };

describe("insertQuote — tax group ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.client.findFirst.mockResolvedValue({ id: CLIENT });
		mockDb.quote.create.mockResolvedValue({ id: "q1" });
		mockDb.inventory_item.findMany.mockResolvedValue([]);
		mockDb.tax_group.count.mockResolvedValue(0);
	});

	it("rejects a line whose tax_group_id belongs to another organization", async () => {
		const result = await insertQuote(
			{
				body: {
					client_id: CLIENT,
					title: "AC repair",
					description: "Fan replacement",
					address: "1 Main St",
					line_items: [line],
				},
			} as unknown as Request,
			ORG,
		);

		expect(result.err).toBe("Tax group not found");
		expect(mockDb.tax_group.count).toHaveBeenCalledWith({
			where: { id: { in: [FOREIGN_GROUP] }, organization_id: ORG },
		});
		expect(mockDb.quote_line_item.createMany).not.toHaveBeenCalled();
	});
});

describe("updateInvoice line items — tax group ownership", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.invoice.findFirst.mockResolvedValue({
			id: "inv1",
			status: "Draft",
			invoice_number: "INV-1001",
			amount_paid: 0,
			line_items: [],
			tax_snapshot: { locked_at: "draft" },
		});
		mockDb.inventory_item.findMany.mockResolvedValue([]);
		mockDb.tax_group.findMany.mockResolvedValue([]);
	});

	it("rejects a foreign tax_group_id before the transaction opens", async () => {
		const result = await updateInvoice(
			{ params: { id: "inv1" }, body: { line_items: [line] } } as unknown as Request,
			ORG,
			{ dispatcherId: "d1" },
		);

		expect(result.err).toBe(`Tax group not found: ${FOREIGN_GROUP}`);
		expect(mockDb.tax_group.findMany).toHaveBeenCalledWith({
			where: { id: { in: [FOREIGN_GROUP] }, organization_id: ORG },
			select: { id: true },
		});
		expect(mockDb.$transaction).not.toHaveBeenCalled();
		expect(mockDb.invoice_line_item.create).not.toHaveBeenCalled();
	});
});
