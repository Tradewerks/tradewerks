import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({ db: mockDb }));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

import { getInvoiceLifeCycleReport } from "../reportsController.js";

const raw = mockDb.$queryRaw as ReturnType<typeof vi.fn>;
const rawSql = () => (raw.mock.calls[0][0] as string[]).join("");

const row = (o: Record<string, unknown>) => ({
	id: "i1",
	invoice_number: "INV-1",
	status: "Paid",
	client_id: "c1",
	client_name: "Acme",
	created_at: new Date("2026-10-01"),
	sent_at: null,
	due_date: null,
	paid_date: null,
	completed_at: null,
	completed_to_invoiced: null,
	created_to_sent: null,
	sent_to_paid: null,
	created_to_paid: null,
	days_late: null,
	...o,
});

beforeEach(() => vi.clearAllMocks());

describe("getInvoiceLifeCycleReport", () => {
	it("excludes Draft/Void and adjustments and dates payment from invoice_payment", async () => {
		raw.mockResolvedValueOnce([]);
		await getInvoiceLifeCycleReport(undefined, undefined, "org1");
		const sql = rawSql();
		expect(sql).toContain("i.status NOT IN ('Draft', 'Void')");
		expect(sql).toContain("d.adjustment_invoice_id = i.id");
		expect(sql).toContain("MAX(ip.paid_at)");
		expect(sql).toContain("CASE WHEN iss.created_at >= jc.completed_at");
	});

	it("averages skip nulls, on-time counts paid invoices with a due date, slowest client first", async () => {
		const due = new Date("2026-10-15");
		const paid = new Date("2026-10-20");
		raw.mockResolvedValueOnce([
			// Paid 2 days early
			row({ id: "a1", created_to_paid: 10.04, due_date: due, paid_date: paid, days_late: -2 }),
			// Paid 3 days late
			row({ id: "a2", created_to_paid: 20, due_date: due, paid_date: paid, days_late: 3 }),
			// Paid, no due date: not in on-time %
			row({ id: "a3", created_to_paid: 30, paid_date: paid }),
			// Open and overdue: counts in days late, not on-time %
			row({ id: "a4", status: "Sent", created_to_sent: 1, due_date: due, days_late: 7 }),
			row({ id: "b1", client_id: "c2", client_name: "Beta", created_to_paid: 45 }),
			row({ id: "c1", client_id: "c3", client_name: "Gamma" }),
		]);

		const [first, second, third] = await getInvoiceLifeCycleReport(undefined, undefined, "org1");

		expect(first.clientId).toBe("c2");
		expect(third.clientId).toBe("c3");
		expect(third.avgCreatedToPaid).toBeNull();
		expect(second).toMatchObject({
			clientId: "c1",
			invoiceCount: 4,
			openCount: 1,
			avgCreatedToPaid: 20,
			avgCreatedToSent: 1,
			avgSentToPaid: null,
			avgDaysLate: 2.7,
			onTimePct: 50,
		});
		expect(second.items[0].createdToPaid).toBe(10);
	});
});
