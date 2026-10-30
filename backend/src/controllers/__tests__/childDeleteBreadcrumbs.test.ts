import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => {
	const { createFakeDb } = await import("../../routes/__tests__/harness.js");
	const db = createFakeDb();
	return { db, generateQuoteNumber: vi.fn(), generateJobNumber: vi.fn() };
});
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
	buildChanges: vi.fn(() => ({})),
}));
vi.mock("../../services/socketService.js", () => ({ getSocket: vi.fn(() => ({ emit: vi.fn() })), emitToOrg: vi.fn() }));
vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn(async () => false),
	getOrgRealmId: vi.fn(async () => null),
}));
vi.mock("../../services/qb/qbInvoices.js", () => ({ pushInvoiceDetached: vi.fn(), voidQBInvoice: vi.fn() }));
vi.mock("../../services/qb/qbPayments.js", () => ({ pushPaymentToQB: vi.fn(), deleteQBPayment: vi.fn() }));
vi.mock("../../services/qb/qbSyncLog.js", () => ({ logExternalSync: vi.fn() }));
vi.mock("../../services/invoiceService.js", () => ({
	createInvoiceRecord: vi.fn(),
	syncBilledAmounts: vi.fn(),
	syncInvoicePaymentTotals: vi.fn(async () => undefined),
	recomputeInvoiceTotals: vi.fn(),
	lockInvoiceTaxSnapshot: vi.fn(),
	invoiceInclude: {},
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeDocumentTotals: vi.fn(async () => undefined),
	lockDocumentTaxSnapshot: vi.fn(),
	holdsKeptRate: vi.fn(async () => false),
}));
vi.mock("../../services/wasabiService.js", () => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	signImageUrl: vi.fn(async (u: string | null) => u),
	signImageUrls: vi.fn(async (u: string[]) => u),
	isOwnBucketUrl: () => true,
}));

import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { deleteInvoicePayment, deleteInvoiceNote } from "../invoicesController.js";
import { deleteJobLineItem, deleteJob } from "../jobsController.js";
import { deleteQuoteItem } from "../quotesController.js";
import { deleteRecurringPlanNote } from "../recurringPlanNotesController.js";
import type { FakeDb } from "../../routes/__tests__/harness.js";

const fake = db as unknown as FakeDb;
const lastLog = () => {
	const calls = vi.mocked(logActivity).mock.calls;
	return calls[calls.length - 1]?.[0];
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("child *.deleted log rows carry a parent breadcrumb (review P2-7 / L2)", () => {
	it("invoice_payment.deleted → invoice", async () => {
		fake.invoice_payment.findFirst.mockResolvedValue({ id: "pay-1", invoice_id: "inv-1", amount: "50", qb_payment_id: null, account_id: null });
		fake.invoice.findFirst.mockResolvedValue({ id: "inv-1", status: "Sent" });
		fake.invoice_payment.delete.mockResolvedValue({});

		const result = await deleteInvoicePayment("inv-1", "pay-1", "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(lastLog()).toMatchObject({
			event_type: "invoice_payment.deleted",
			entity_id: "pay-1",
			organization_id: "org-1",
			changes: {
				invoice_id: { old: "inv-1", new: null },
				_parent_type: { old: null, new: "invoice" },
				_parent_id: { old: null, new: "inv-1" },
			},
		});
	});

	it("invoice_note.deleted → invoice", async () => {
		fake.invoice_note.findFirst.mockResolvedValue({ id: "n-1", invoice_id: "inv-1", content: "c" });
		fake.invoice_note.delete.mockResolvedValue({});
		const result = await deleteInvoiceNote("inv-1", "n-1", "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(lastLog()).toMatchObject({
			event_type: "invoice_note.deleted",
			changes: { _parent_type: { old: null, new: "invoice" }, _parent_id: { old: null, new: "inv-1" } },
		});
	});

	it("job_line_item.deleted → job, and the row is org-scoped", async () => {
		fake.job_line_item.findFirst.mockResolvedValue({ id: "li-1", job_id: "job-1", name: "Filter" });
		fake.job_line_item.delete.mockResolvedValue({});
		const result = await deleteJobLineItem("job-1", "li-1", "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(lastLog()).toMatchObject({
			event_type: "job_line_item.deleted",
			entity_id: "li-1",
			organization_id: "org-1",
			changes: {
				job_id: { old: "job-1", new: null },
				_parent_type: { old: null, new: "job" },
				_parent_id: { old: null, new: "job-1" },
			},
		});
	});

	it("quote_line_item.deleted → quote, and the row is org-scoped", async () => {
		fake.quote_line_item.findFirst.mockResolvedValue({ id: "qli-1", quote_id: "q-1", name: "Coil" });
		fake.quote_line_item.delete.mockResolvedValue({});
		const result = await deleteQuoteItem("q-1", "qli-1", "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(lastLog()).toMatchObject({
			event_type: "quote_line_item.deleted",
			organization_id: "org-1",
			changes: {
				quote_id: { old: "q-1", new: null },
				_parent_type: { old: null, new: "quote" },
				_parent_id: { old: null, new: "q-1" },
			},
		});
	});

	it("job.deleted → project only when the job belonged to one", async () => {
		fake.job.findFirst.mockResolvedValue({ id: "job-1", job_number: "J-0001", name: "J", status: "Scheduled", project_id: "proj-1" });
		fake.job.delete.mockResolvedValue({});
		await deleteJob("job-1", "org-1", { dispatcherId: "disp-1" });
		expect(lastLog()).toMatchObject({
			event_type: "job.deleted",
			changes: { _parent_type: { old: null, new: "project" }, _parent_id: { old: null, new: "proj-1" } },
		});

		fake.job.findFirst.mockResolvedValue({ id: "job-2", job_number: "J-0002", name: "J", status: "Scheduled", project_id: null });
		await deleteJob("job-2", "org-1", { dispatcherId: "disp-1" });
		expect(lastLog()?.changes).not.toHaveProperty("_parent_id");
	});

	it("recurring_plan_note.deleted → recurring_plan", async () => {
		fake.recurring_plan.findFirst.mockResolvedValue({ id: "plan-1", organization_id: "org-1" });
		fake.recurring_plan_note.findFirst.mockResolvedValue({ id: "n-1", recurring_plan_id: "plan-1", content: "c" });
		fake.recurring_plan_note.delete.mockResolvedValue({});

		const result = await deleteRecurringPlanNote("job-1", "n-1", "org-1", { dispatcherId: "disp-1" });
		expect(result.err).toBe("");
		expect(lastLog()).toMatchObject({
			event_type: "recurring_plan_note.deleted",
			entity_id: "n-1",
			organization_id: "org-1",
			changes: {
				content: { old: "c", new: null },
				_parent_type: { old: null, new: "recurring_plan" },
				_parent_id: { old: null, new: "plan-1" },
			},
		});
	});
});
