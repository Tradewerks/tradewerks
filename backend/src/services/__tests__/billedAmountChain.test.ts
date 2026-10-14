import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncBilledAmounts } from "../invoiceService.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("syncBilledAmounts across an adjustment chain", () => {
	let tx: Record<string, unknown>;

	beforeEach(() => {
		tx = {
			invoice: { findFirst: vi.fn(), findMany: vi.fn() },
			invoice_line_item: { findMany: vi.fn() },
			invoice_visit: { findMany: vi.fn(), update: vi.fn() },
			invoice_job: { findMany: vi.fn(), update: vi.fn() },
		};
	});

	it("nets an adjustment against the original", async () => {
		mockFn(tx.invoice.findFirst).mockResolvedValue({ id: "inv1", adjusts_invoice_id: null });
		mockFn(tx.invoice.findMany).mockResolvedValue([{ id: "adj1" }]);
		// The original bills 500 to visit v1; the adjustment credits 200 back.
		// Two job-level lines (source_visit_id: null) net 100/-40 -> 60, proving
		// the job loop also nets across the chain without double-counting the
		// visit-attributed lines (job filter keeps source_visit_id === null).
		mockFn(tx.invoice_line_item.findMany).mockResolvedValue([
			{ total: 500, source_job_id: "j1", source_visit_id: "v1" },
			{ total: -200, source_job_id: "j1", source_visit_id: "v1" },
			{ total: 100, source_job_id: "j1", source_visit_id: null },
			{ total: -40, source_job_id: "j1", source_visit_id: null },
		]);
		mockFn(tx.invoice_visit.findMany).mockResolvedValue([{ visit_id: "v1" }]);
		mockFn(tx.invoice_job.findMany).mockResolvedValue([{ job_id: "j1" }]);

		await syncBilledAmounts("inv1", tx as never);

		expect(mockFn(tx.invoice_visit.update).mock.calls[0][0].data.billed_amount).toBe(300);
		expect(mockFn(tx.invoice_job.update).mock.calls[0][0].data.billed_amount).toBe(60);
	});

	it("resolves to the original when called with an adjustment's id", async () => {
		mockFn(tx.invoice.findFirst).mockResolvedValue({ id: "adj1", adjusts_invoice_id: "inv1" });
		mockFn(tx.invoice.findMany).mockResolvedValue([{ id: "adj1" }]);
		mockFn(tx.invoice_line_item.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_visit.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_job.findMany).mockResolvedValue([]);

		await syncBilledAmounts("adj1", tx as never);

		// The join rows live on the original, so that is what must be read.
		expect(mockFn(tx.invoice_visit.findMany).mock.calls[0][0].where.invoice_id).toBe("inv1");
	});

	it("behaves exactly as before for an invoice with no adjustments", async () => {
		mockFn(tx.invoice.findFirst).mockResolvedValue({ id: "inv1", adjusts_invoice_id: null });
		mockFn(tx.invoice.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_line_item.findMany).mockResolvedValue([
			{ total: 500, source_job_id: "j1", source_visit_id: "v1" },
		]);
		mockFn(tx.invoice_visit.findMany).mockResolvedValue([{ visit_id: "v1" }]);
		mockFn(tx.invoice_job.findMany).mockResolvedValue([{ job_id: "j1" }]);

		await syncBilledAmounts("inv1", tx as never);

		expect(mockFn(tx.invoice_visit.update).mock.calls[0][0].data.billed_amount).toBe(500);
	});
	// "Void the adjustment first" (D1) is only honest if the voided credit then
	// stops reducing the job's revenue.
	it("leaves a voided adjustment out of the chain", async () => {
		mockFn(tx.invoice.findFirst).mockResolvedValue({ id: "inv1", adjusts_invoice_id: null });
		mockFn(tx.invoice.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_line_item.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_visit.findMany).mockResolvedValue([]);
		mockFn(tx.invoice_job.findMany).mockResolvedValue([]);

		await syncBilledAmounts("inv1", tx as never);

		expect(mockFn(tx.invoice.findMany).mock.calls[0][0].where).toEqual({
			adjusts_invoice_id: "inv1",
			status: { not: "Void" },
		});
	});
});
