import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateInvoiceNumber: vi.fn().mockResolvedValue("INV-0001"),
}));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));
vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) =>
		next(),
}));
vi.mock("../../services/invoiceService.js", () => ({
	createInvoiceRecord: vi.fn().mockResolvedValue({ id: "inv-1" }),
}));
vi.mock("../../services/invoiceGenerator.js", () => ({
	buildVisitInvoicePayload: vi.fn(),
	buildRecurringPlanInvoicePayload: vi
		.fn()
		.mockResolvedValue({ payload: {}, warnings: [] }),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn(),
}));
vi.mock("../../services/emailService.js", () => ({
	sendInvoiceEmail: vi.fn(),
}));
vi.mock("../../lib/pdf/pdfService.js", () => ({ generateInvoicePdf: vi.fn() }));
vi.mock("../../services/followupTriggers.js", () => ({
	onInvoiceSent: vi.fn(),
}));

import invoicesRouter from "../invoices.js";
import { callRoute } from "./harness.js";
import { getScopedDb } from "../../lib/context.js";
import { buildRecurringPlanInvoicePayload } from "../../services/invoiceGenerator.js";
import { createInvoiceRecord } from "../../services/invoiceService.js";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
	vi.useRealTimers();
});

describe("POST /invoices/generate schedule advance", () => {
	it("null next_invoice_at on the billing day advances to next month, not today", async () => {
		// 15:00 Nov 23 in Chicago, the plan's billing day.
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const tx = { invoice_schedule: { updateMany } };
		vi.mocked(getScopedDb).mockReturnValue({
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({
					id: "sched-1",
					frequency: "monthly",
					day_of_month: 23,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: null,
					last_invoiced_at: null,
					recurring_plan: {
						timezone: "America/Chicago",
						starts_at: new Date("2026-01-01T06:00:00Z"),
					},
				}),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb(tx)),
		} as never);

		const res = await callRoute(invoicesRouter, "post", "/generate", {
			body: { source: "recurring_plan", plan_id: PLAN_ID },
		});

		expect(res.status).toBe(201);
		expect(
			updateMany.mock.calls[0][0].data.next_invoice_at.toISOString(),
		).toBe("2026-12-23T06:00:00.000Z");
	});

	it("a period not yet due is refused with its plan-local date", async () => {
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const $transaction = vi.fn();
		vi.mocked(getScopedDb).mockReturnValue({
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({
					id: "sched-1",
					frequency: "monthly",
					day_of_month: 23,
					day_of_week: null,
					generate_days_before: 0,
					// 00:00 Dec 23 in Chicago.
					next_invoice_at: new Date("2026-12-23T06:00:00Z"),
					last_invoiced_at: new Date("2026-11-23T15:00:00Z"),
					recurring_plan: {
						timezone: "America/Chicago",
						starts_at: new Date("2026-01-01T06:00:00Z"),
					},
				}),
			},
			$transaction,
		} as never);
		vi.mocked(createInvoiceRecord).mockClear();

		const res = await callRoute(invoicesRouter, "post", "/generate", {
			body: { source: "recurring_plan", plan_id: PLAN_ID },
		});

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).toContain(
			"The next invoice for this plan isn't due until Dec 23, 2026.",
		);
		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect($transaction).not.toHaveBeenCalled();
	});

	it("pressing Generate twice the same day bills once", async () => {
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const schedule = {
			id: "sched-1",
			frequency: "monthly",
			day_of_month: 23,
			day_of_week: null,
			generate_days_before: 0,
			next_invoice_at: new Date("2026-11-23T06:00:00Z") as Date | null,
			last_invoiced_at: null as Date | null,
			recurring_plan: {
				timezone: "America/Chicago",
				starts_at: new Date("2026-01-01T06:00:00Z"),
			},
		};
		const updateMany = vi.fn(
			async (args: { data: { last_invoiced_at: Date; next_invoice_at: Date } }) => {
				Object.assign(schedule, args.data);
				return { count: 1 };
			},
		);
		vi.mocked(getScopedDb).mockReturnValue({
			invoice_schedule: {
				findFirst: vi.fn(async () => ({ ...schedule })),
			},
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			$transaction: vi.fn((cb: any) => cb({ invoice_schedule: { updateMany } })),
		} as never);
		vi.mocked(createInvoiceRecord).mockClear();

		const first = await callRoute(invoicesRouter, "post", "/generate", {
			body: { source: "recurring_plan", plan_id: PLAN_ID },
		});
		const second = await callRoute(invoicesRouter, "post", "/generate", {
			body: { source: "recurring_plan", plan_id: PLAN_ID },
		});

		expect(first.status).toBe(201);
		expect(second.status).toBe(400);
		expect(createInvoiceRecord).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenCalledTimes(1);
		expect(schedule.next_invoice_at!.toISOString()).toBe("2026-12-23T06:00:00.000Z");
	});

	it("an empty period is refused without creating an invoice or advancing", async () => {
		vi.setSystemTime(new Date("2026-11-23T21:00:00Z"));
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const $transaction = vi.fn();
		vi.mocked(getScopedDb).mockReturnValue({
			invoice_schedule: {
				findFirst: vi.fn().mockResolvedValue({
					id: "sched-1",
					frequency: "monthly",
					day_of_month: 23,
					day_of_week: null,
					generate_days_before: 0,
					next_invoice_at: new Date("2026-11-23T06:00:00Z"),
					last_invoiced_at: null,
					recurring_plan: {
						timezone: "America/Chicago",
						starts_at: new Date("2026-01-01T06:00:00Z"),
					},
				}),
				updateMany,
			},
			$transaction,
		} as never);
		vi.mocked(buildRecurringPlanInvoicePayload).mockResolvedValueOnce({
			payload: { client_id: "c1", line_items: [] },
			warnings: [],
			empty: true,
		} as never);
		vi.mocked(createInvoiceRecord).mockClear();

		const res = await callRoute(invoicesRouter, "post", "/generate", {
			body: { source: "recurring_plan", plan_id: PLAN_ID },
		});

		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).toContain("Nothing to bill for this period.");
		expect(createInvoiceRecord).not.toHaveBeenCalled();
		expect($transaction).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});
});
