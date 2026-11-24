import { describe, it, expect, vi, beforeEach } from "vitest";

const sdb = {
	invoice_schedule: { findFirst: vi.fn() },
	log: { findFirst: vi.fn() },
	$transaction: vi.fn(),
};
const innerTx = {
	$queryRaw: vi.fn(async (..._args: unknown[]) => [{ status: "Active" }]),
	invoice_schedule: { updateMany: vi.fn(async () => ({ count: 1 })) },
	log: {
		findFirst: vi.fn(),
		create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
			id: "log1",
			...args.data,
		})),
	},
};

vi.mock("../../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
}));
vi.mock("../../invoiceGenerator.js", () => ({
	buildRecurringPlanInvoicePayload: vi.fn(async () => ({
		payload: { client_id: "c1" },
		warnings: [],
	})),
}));
vi.mock("../../invoiceService.js", () => ({
	createInvoiceRecord: vi.fn(async () => ({
		id: "inv1",
		invoice_number: "INV-1",
		client_id: "c1",
		total: 100,
		status: "Draft",
		recurring_plan_id: "p1",
	})),
}));
vi.mock("../../logger.js", () => ({
	logActivity: vi.fn(async () => undefined),
}));
vi.mock("../../socketService.js", () => ({
	getSocket: vi.fn(() => {
		throw new Error("socket not initialised");
	}),
}));
vi.mock("../../recordChanged.js", () => ({ recordChangedFromLog: vi.fn() }));
vi.mock("../../../controllers/logsController.js", () => ({
	redactFeedRow: vi.fn((r: unknown) => r),
}));

import { maybeAutoInvoiceOnCompletion } from "../autoInvoice.js";
import { isModuleOn } from "../../entitlementService.js";
import { buildRecurringPlanInvoicePayload } from "../../invoiceGenerator.js";
import { createInvoiceRecord } from "../../invoiceService.js";
import { logActivity } from "../../logger.js";
import { recordChangedFromLog } from "../../recordChanged.js";

const schedule = (over: Record<string, unknown> = {}) => ({
	id: "s1",
	frequency: "on_visit_completion",
	is_active: true,
	last_invoiced_at: null,
	recurring_plan: { status: "Active" },
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(isModuleOn).mockResolvedValue(true);
	sdb.log.findFirst.mockResolvedValue(null);
	innerTx.log.findFirst.mockResolvedValue(null);
	innerTx.invoice_schedule.updateMany.mockResolvedValue({ count: 1 });
	innerTx.$queryRaw.mockResolvedValue([{ status: "Active" }]);
	sdb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn(innerTx),
	);
});

describe("maybeAutoInvoiceOnCompletion", () => {
	it("skips when the schedule frequency is not on_visit_completion", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(
			schedule({ frequency: "monthly" }),
		);
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(buildRecurringPlanInvoicePayload).not.toHaveBeenCalled();
		expect(createInvoiceRecord).not.toHaveBeenCalled();
	});

	it("skips when the plan is paused", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(
			schedule({ recurring_plan: { status: "Paused" } }),
		);
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(buildRecurringPlanInvoicePayload).not.toHaveBeenCalled();
		expect(createInvoiceRecord).not.toHaveBeenCalled();
	});

	it("a plan paused after the schedule was read is not billed", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		innerTx.$queryRaw.mockResolvedValue([{ status: "Paused" }]);
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(String(innerTx.$queryRaw.mock.calls[0][0])).toMatch(/FOR SHARE/);
		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(innerTx.log.create).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("a schedule switched off after it was read is not billed", async () => {
		sdb.invoice_schedule.findFirst
			.mockResolvedValueOnce(schedule())
			.mockResolvedValueOnce(schedule({ is_active: false }));
		innerTx.invoice_schedule.updateMany.mockResolvedValueOnce({ count: 0 });
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(innerTx.invoice_schedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ is_active: true }),
			}),
		);
		expect(innerTx.log.create).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("creates no invoice when every completed visit is already billed", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		vi.mocked(buildRecurringPlanInvoicePayload).mockResolvedValueOnce({
			payload: { client_id: "c1", line_items: [] },
			warnings: [],
			empty: true,
		} as never);
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("skips when recurring_plans is off", async () => {
		vi.mocked(isModuleOn).mockResolvedValue(false);
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(isModuleOn).toHaveBeenCalledWith("o1", "recurring_plans");
		expect(sdb.invoice_schedule.findFirst).not.toHaveBeenCalled();
		expect(createInvoiceRecord).not.toHaveBeenCalled();
	});

	it("skips when this visit already produced an auto invoice", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		sdb.log.findFirst.mockResolvedValue({ id: "log1" });
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(createInvoiceRecord).not.toHaveBeenCalled();
	});

	it("creates the invoice and writes the visit marker inside the invoice tx", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(createInvoiceRecord).toHaveBeenCalledTimes(1);
		expect(innerTx.invoice_schedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "s1", last_invoiced_at: null, is_active: true },
			}),
		);
		expect(innerTx.log.create).toHaveBeenCalledTimes(1);
		expect(innerTx.log.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				event_type: "invoice.created",
				entity_id: "inv1",
				organization_id: "o1",
				changes: expect.objectContaining({
					source_visit_id: { old: null, new: "v1" },
				}),
			}),
		});
		// One log row, not a second one from logActivity.
		expect(logActivity).not.toHaveBeenCalled();
		expect(recordChangedFromLog).toHaveBeenCalledTimes(1);
	});

	it("a marker that appears before the in-tx re-check rolls back quietly", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		innerTx.log.findFirst.mockResolvedValue({ id: "log-other" });
		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");
		expect(innerTx.log.create).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("a CAS miss from a concurrent same-plan completion retries on the fresh schedule and bills", async () => {
		const later = new Date("2027-03-01T16:00:00Z");
		sdb.invoice_schedule.findFirst
			.mockResolvedValueOnce(schedule())
			.mockResolvedValueOnce(schedule({ last_invoiced_at: later }));
		innerTx.invoice_schedule.updateMany.mockResolvedValueOnce({ count: 0 });

		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");

		expect(innerTx.invoice_schedule.updateMany).toHaveBeenCalledTimes(2);
		expect(innerTx.invoice_schedule.updateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: { id: "s1", last_invoiced_at: later, is_active: true },
			}),
		);
		expect(innerTx.log.create).toHaveBeenCalledTimes(1);
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("logs the failure only once the CAS retries are exhausted", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		innerTx.invoice_schedule.updateMany.mockResolvedValue({ count: 0 });

		await maybeAutoInvoiceOnCompletion("o1", "v1", "p1");

		expect(innerTx.invoice_schedule.updateMany).toHaveBeenCalledTimes(3);
		expect(innerTx.log.create).not.toHaveBeenCalled();
		expect(logActivity).toHaveBeenCalledTimes(1);
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({ event_type: "invoice.auto_creation_failed" }),
		);
	});

	it("never rejects; a failure is logged against the visit", async () => {
		sdb.invoice_schedule.findFirst.mockResolvedValue(schedule());
		vi.mocked(createInvoiceRecord).mockRejectedValueOnce(new Error("boom"));
		await expect(
			maybeAutoInvoiceOnCompletion("o1", "v1", "p1"),
		).resolves.toBeUndefined();
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.auto_creation_failed",
				entity_id: "v1",
			}),
		);
	});
});
