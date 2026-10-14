/**
 * applyLinkageMatch rewrites historical billing rows. It touches only lines
 * pointing at nothing, and stamps a COMPLETED visit's lines `used` — which
 * is what deductInventoryForVisit skips, keeping a re-completion from
 * consuming the same stock twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyLinkageMatch } from "../inventoryController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const lineItemTable = () => ({ updateMany: vi.fn().mockResolvedValue({ count: 1 }) });
	const mockDb = {
		inventory_item: { findFirst: vi.fn(), findMany: vi.fn() },
		quote_line_item: lineItemTable(),
		job_line_item: lineItemTable(),
		recurring_plan_line_item: lineItemTable(),
		invoice_line_item: lineItemTable(),
		job_visit_line_item: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { db } = require("../../db.js");
		return db;
	}),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
	InsufficientStockError: class extends Error {},
}));

vi.mock("xlsx", () => ({
	default: {},
	read: vi.fn(),
	utils: {
		sheet_to_json: vi.fn(),
		json_to_sheet: vi.fn(),
		book_new: vi.fn(),
		book_append_sheet: vi.fn(),
		aoa_to_sheet: vi.fn(),
	},
	write: vi.fn(),
}));

import { db } from "../../db.js";
const mockDb = vi.mocked(db);

const ORG = "org-1";
const ITEM = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function visitCalls(): UpdateManyArgs[] {
	return mockDb.job_visit_line_item.updateMany.mock.calls.map((c) => c[0] as UpdateManyArgs);
}

describe("applyLinkageMatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.inventory_item.findFirst.mockResolvedValue({ id: ITEM } as any);
		mockDb.$transaction.mockImplementation(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			async (fn: any) => fn(mockDb),
		);
		for (const table of [
			mockDb.quote_line_item,
			mockDb.job_line_item,
			mockDb.recurring_plan_line_item,
			mockDb.invoice_line_item,
		]) {
			table.updateMany.mockResolvedValue({ count: 1 });
		}
		mockDb.job_visit_line_item.updateMany.mockResolvedValue({ count: 2 });
	});

	it("rejects an item owned by another organization", async () => {
		mockDb.inventory_item.findFirst.mockResolvedValue(null);

		const result = await applyLinkageMatch({ name: "Capacitor", inventory_item_id: ITEM }, ORG);

		expect(result.err).toContain("not found");
		expect(mockDb.quote_line_item.updateMany).not.toHaveBeenCalled();
	});

	it("only rewrites lines that are not already linked", async () => {
		await applyLinkageMatch({ name: "Capacitor", inventory_item_id: ITEM }, ORG);

		const everyCall: UpdateManyArgs[] = [
			mockDb.quote_line_item.updateMany.mock.calls[0]![0] as UpdateManyArgs,
			mockDb.job_line_item.updateMany.mock.calls[0]![0] as UpdateManyArgs,
			mockDb.recurring_plan_line_item.updateMany.mock.calls[0]![0] as UpdateManyArgs,
			mockDb.invoice_line_item.updateMany.mock.calls[0]![0] as UpdateManyArgs,
			...visitCalls(),
		];
		for (const call of everyCall) {
			expect(call.where.inventory_item_id).toBeNull();
			expect(call.where.name).toBe("Capacitor");
			expect(call.where.item_type).toEqual({ in: ["material", "equipment"] });
		}
	});

	it("stamps completed visits `used` and every other status `planned`", async () => {
		await applyLinkageMatch({ name: "Capacitor", inventory_item_id: ITEM }, ORG);

		const calls = visitCalls();
		expect(calls).toHaveLength(2);

		const used = calls.find((c) => c.data.fulfillment_status === "used");
		const planned = calls.find((c) => c.data.fulfillment_status === "planned");
		expect((used!.where.visit as { status: unknown }).status).toEqual({ equals: "Completed" });
		expect((planned!.where.visit as { status: unknown }).status).toEqual({ not: "Completed" });

		// Nobody planned these lines — a fabricated qty_planned would read as variance.
		for (const call of calls) {
			expect(call.data).not.toHaveProperty("qty_planned");
		}
	});

	it("reports one count per line table, visits summed across both stamps", async () => {
		const result = await applyLinkageMatch({ name: "Capacitor", inventory_item_id: ITEM }, ORG);

		expect(result.updated).toEqual({
			quote: 1,
			job: 1,
			job_visit: 4,
			recurring_plan: 1,
			invoice: 1,
		});
	});

	it("rejects a blank name rather than linking every unnamed line", async () => {
		const result = await applyLinkageMatch({ name: "", inventory_item_id: ITEM }, ORG);

		expect(result.err).toContain("Validation failed");
		expect(mockDb.$transaction).not.toHaveBeenCalled();
	});
});
