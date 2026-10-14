/**
 * Dispatch-side quick add. Reuses the technician provisional lifecycle, so
 * `created_by_tech_id: null` is the only thing marking a row dispatch-origin,
 * and the picker can't see provisional rows — nothing but the idempotency
 * guard stops a duplicate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProvisionalItemForLine } from "../inventoryController.js";
import { DEFAULT_UNIT_CODE } from "../../lib/units.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const lineItemTable = () => ({ updateMany: vi.fn().mockResolvedValue({ count: 1 }) });
	const mockDb = {
		inventory_item: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
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

describe("createProvisionalItemForLine", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.inventory_item.findFirst.mockResolvedValue(null);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.inventory_item.create.mockResolvedValue({ id: "new-item" } as any);
	});

	it("creates a provisional, dispatch-origin item with zero quantity", async () => {
		const result = await createProvisionalItemForLine({ name: "Capacitor", unit: "ea" }, ORG);

		expect(result.err).toBeUndefined();
		expect(mockDb.inventory_item.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				organization_id: ORG,
				name: "Capacitor",
				quantity: 0,
				provisional: true,
				created_by_tech_id: null,
				unit: "each",
			}),
		});
	});

	it("routes an off-catalog unit string through normalizeUnitCode to the default code", async () => {
		await createProvisionalItemForLine({ name: "Widget", unit: "gizmos" }, ORG);

		expect(mockDb.inventory_item.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ unit: DEFAULT_UNIT_CODE }),
		});
	});

	it("falls back to the default unit code when no unit is given at all", async () => {
		await createProvisionalItemForLine({ name: "Widget" }, ORG);

		expect(mockDb.inventory_item.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ unit: DEFAULT_UNIT_CODE }),
		});
	});

	it("is idempotent: an existing provisional row with the same folded name short-circuits create", async () => {
		const existing = { id: "existing-item", name: "Capacitor", provisional: true };
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.inventory_item.findFirst.mockResolvedValue(existing as any);

		const result = await createProvisionalItemForLine({ name: "capacitor" }, ORG);

		expect(result.item).toBe(existing);
		expect(mockDb.inventory_item.create).not.toHaveBeenCalled();
		expect(mockDb.inventory_item.findFirst).toHaveBeenCalledWith({
			where: {
				organization_id: ORG,
				provisional: true,
				name: { equals: "capacitor", mode: "insensitive" },
			},
		});
	});

	it("rejects an empty name without creating anything", async () => {
		const result = await createProvisionalItemForLine({ name: "" }, ORG);

		expect(result.err).toMatch(/^Validation failed/);
		expect(mockDb.inventory_item.findFirst).not.toHaveBeenCalled();
		expect(mockDb.inventory_item.create).not.toHaveBeenCalled();
	});

	it("rejects a name over the 200-character cap without creating anything", async () => {
		const result = await createProvisionalItemForLine({ name: "A".repeat(201) }, ORG);

		expect(result.err).toMatch(/^Validation failed/);
		expect(mockDb.inventory_item.create).not.toHaveBeenCalled();
	});

	it("returns a friendly error without throwing when the db write fails", async () => {
		mockDb.inventory_item.create.mockRejectedValue(new Error("connection lost"));

		const result = await createProvisionalItemForLine({ name: "Capacitor" }, ORG);

		expect(result).toEqual({ err: "Failed to create provisional item" });
	});
});
