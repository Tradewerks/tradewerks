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

import { getNotInvoicedReport } from "../reportsController.js";

const raw = mockDb.$queryRaw as ReturnType<typeof vi.fn>;
const rawSql = () => (raw.mock.calls[0][0] as string[]).join("");

const row = (o: Record<string, unknown>) => ({
	clientId: "c1",
	clientName: "Acme",
	kind: "job",
	id: "j1",
	number: "J-1",
	title: "Job",
	status: "Completed",
	date: new Date("2026-10-01"),
	value: 0,
	billed: 0,
	unbilled: 0,
	...o,
});

beforeEach(() => vi.clearAllMocks());

describe("getNotInvoicedReport", () => {
	it("filters Draft/Void invoices, traceability-only links and recurring jobs", async () => {
		raw.mockResolvedValueOnce([]);
		await getNotInvoicedReport("org1");
		const sql = rawSql();
		expect(sql).toContain("i.status NOT IN ('Draft', 'Void')");
		expect(sql).toContain("ij.billed_amount IS NOT NULL");
		expect(sql).toContain("j.recurring_plan_id IS NULL");
		expect(sql).toContain("q.status = 'Approved'");
	});

	it("sums each stage per client and keeps the oldest date", async () => {
		raw.mockResolvedValueOnce([
			row({ stage: "ready", id: "j1", value: 1250, billed: 110, unbilled: 1140 }),
			row({ stage: "ready", id: "j2", unbilled: 406.5, date: new Date("2026-09-01") }),
			row({ stage: "in_progress", id: "j3", unbilled: 942 }),
			row({ stage: "approved", kind: "quote", id: "q1", unbilled: 500.1 }),
			row({ clientId: "c2", clientName: "Beta", stage: "ready", id: "j4", unbilled: 9000 }),
		]);

		const [first, second] = await getNotInvoicedReport("org1");

		expect(first.clientId).toBe("c2");
		expect(second).toMatchObject({
			clientId: "c1",
			approved: 500.1,
			inProgress: 942,
			readyToBill: 1546.5,
			total: 2988.6,
			oldestDate: new Date("2026-09-01"),
		});
		expect(second.items).toHaveLength(4);
		expect(second.items[0]).toMatchObject({ value: 1250, billed: 110, unbilled: 1140 });
		expect(second.items[0]).not.toHaveProperty("clientId");
	});
});
