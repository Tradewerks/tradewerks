import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

import { getReportDefinition } from "../../lib/reports/reportRegistry.js";
import { filterRows } from "../../lib/reports/filterEngine.js";

// Export and the in-memory fallback must search the same text columns as SQL.
describe("payments searchKeys", () => {
	const searchKeys = getReportDefinition("payments")!.searchKeys;
	const rows = [
		{ id: "p1", invoiceNumber: "INV-0015", clientName: "Acme", amount: 75, paidAt: "Oct 17, 2026", _paidAtIso: "2026-10-17" },
		{ id: "p2", invoiceNumber: "INV-0075", clientName: "Beta", amount: 20, paidAt: "Oct 1, 2026", _paidAtIso: "2026-10-01" },
	];

	it("ignores amounts, dates and hidden keys", () => {
		expect(filterRows(rows, { search: "75", searchKeys }).map((r) => r.id)).toEqual(["p2"]);
		expect(filterRows(rows, { search: "2026", searchKeys })).toEqual([]);
	});
});
