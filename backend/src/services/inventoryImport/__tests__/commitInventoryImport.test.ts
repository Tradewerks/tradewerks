import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "../../../../generated/prisma/client.js";

const mocks = vi.hoisted(() => {
	const delegate = () => ({
		findFirst: vi.fn(),
		findMany: vi.fn(),
		findUnique: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		updateMany: vi.fn(),
		deleteMany: vi.fn(),
	});
	const tx = {
		$executeRaw: vi.fn(),
		inventory_import: delegate(),
		inventory_import_candidate: delegate(),
		inventory_import_change: delegate(),
		inventory_item: delegate(),
		inventory_tag: delegate(),
		inventory_variant_group: delegate(),
		item_external_mapping: delegate(),
		stock_movement: delegate(),
		job_visit_line_item: delegate(),
		quote_line_item: delegate(),
		job_line_item: delegate(),
		invoice_line_item: delegate(),
		log: delegate(),
	};
	return {
		tx,
		db: { $transaction: vi.fn() },
		recordMovements: vi.fn(),
		getOrCreateBatch: vi.fn(),
	};
});

vi.mock("../../../db.js", () => ({ db: mocks.db }));
vi.mock("../../stockMovements.js", () => ({
	recordMovements: mocks.recordMovements,
	getOrCreateBatch: mocks.getOrCreateBatch,
}));
vi.mock("../../metricsService.js", () => ({
	inventoryImportEvents: { add: vi.fn() },
	inventoryImportDuration: { record: vi.fn() },
}));

import { commitInventoryImport, undoInventoryImport } from "../commitInventoryImport.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function importRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "import-1",
		organization_id: "org-1",
		status: "ready_for_review",
		revision: 4,
		created_at: new Date("2026-09-23T11:00:00.000Z"),
		committed_at: null,
		undo_expires_at: null,
		...overrides,
	};
}

function candidate(overrides: Record<string, unknown> = {}) {
	return {
		id: "candidate-1",
		proposed_action: "create",
		normalized_proposal: { name: "Filter", location: "A1" },
		user_overrides: {},
		validation_issues: [],
		requires_financial_approval: false,
		financial_approved_at: null,
		existing_item_id: null,
		existing_quantity_at_review: null,
		matching_evidence: {},
		source: { source_type: "spreadsheet", storage_url: "https://example.test/source.xlsx" },
		...overrides,
	};
}

function item(overrides: Record<string, unknown> = {}) {
	return {
		id: "item-1",
		organization_id: "org-1",
		name: "Filter",
		description: "",
		location: "A1",
		quantity: 3,
		unit: "each",
		unit_price: null,
		cost: null,
		sku: null,
		barcode: null,
		category: null,
		low_stock_threshold: null,
		image_urls: [],
		alt_ids: [],
		is_active: true,
		is_serialized: false,
		is_batch_tracked: false,
		variant_group_id: null,
		variant_attributes: null,
		updated_at: NOW,
		tags: [],
		...overrides,
	};
}

function snap(name: string) {
	return {
		name,
		description: "",
		location: "A1",
		quantity: 3,
		unit: "each",
		unit_price: null,
		cost: null,
		sku: null,
		barcode: null,
		category: null,
		low_stock_threshold: null,
		image_urls: [],
		alt_ids: [],
		is_active: true,
		variant_group_id: null,
		variant_attributes: null,
		tag_ids: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.db.$transaction.mockImplementation(async (callback: (tx: typeof mocks.tx) => unknown) => callback(mocks.tx));
	mocks.tx.$executeRaw.mockResolvedValue(undefined);
	mocks.recordMovements.mockResolvedValue({ movementIds: [] });
});

describe("commitInventoryImport", () => {
	it("is idempotent after a prior successful commit", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord({
			status: "committed",
			committed_at: NOW,
			undo_expires_at: new Date(NOW.getTime() + 30 * 60_000),
		}));

		await expect(commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
			dispatcherId: "dispatcher-1",
		})).resolves.toMatchObject({ status: "committed", idempotent: true });
		expect(mocks.tx.inventory_import_candidate.findMany).not.toHaveBeenCalled();
		expect(mocks.tx.inventory_item.create).not.toHaveBeenCalled();
	});

	it("maps a concurrent unique-identity race to a reviewable 409 conflict", async () => {
		mocks.db.$transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
			"Unique constraint failed",
			{ code: "P2002", clientVersion: "7" },
		));

		await expect(commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
		})).rejects.toMatchObject({ code: "DUPLICATE_IDENTITY_CONFLICT", statusCode: 409 });
	});

	it("rejects any financial or stock value without explicit approval", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord());
		mocks.tx.inventory_import_candidate.findMany.mockResolvedValue([
			candidate({
				normalized_proposal: { name: "Filter", location: "A1", quantity: 8, cost: 4.25 },
				requires_financial_approval: true,
			}),
		]);

		await expect(commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
		})).rejects.toMatchObject({ code: "FINANCIAL_APPROVAL_REQUIRED", statusCode: 409 });
		expect(mocks.tx.inventory_import.update).not.toHaveBeenCalled();
		expect(mocks.tx.inventory_item.create).not.toHaveBeenCalled();
	});

	it("detects quantity changes made after review instead of overwriting stock", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord());
		mocks.tx.inventory_import_candidate.findMany.mockResolvedValue([
			candidate({
				proposed_action: "update",
				normalized_proposal: { name: "Filter", location: "A1", quantity: 8 },
				existing_item_id: "item-1",
				existing_quantity_at_review: 2,
			}),
		]);
		mocks.tx.inventory_item.findFirst.mockResolvedValue(item({ quantity: 3 }));
		mocks.tx.inventory_import.update.mockResolvedValue(importRecord({ status: "committing" }));

		await expect(commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
		})).rejects.toMatchObject({ code: "STOCK_CHANGED_SINCE_REVIEW", statusCode: 409 });
		expect(mocks.tx.inventory_item.update).not.toHaveBeenCalled();
		expect(mocks.recordMovements).not.toHaveBeenCalled();
	});

	it("does not silently re-denominate existing stock when an imported unit differs", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord());
		mocks.tx.inventory_import_candidate.findMany.mockResolvedValue([
			candidate({
				proposed_action: "update",
				normalized_proposal: { name: "Filter", location: "A1", unit: "box" },
				existing_item_id: "item-1",
				matching_evidence: { existing_updated_at: NOW.toISOString() },
			}),
		]);
		mocks.tx.inventory_item.findFirst.mockResolvedValue(item());
		mocks.tx.inventory_import.update.mockResolvedValue(importRecord({ status: "committing" }));

		await expect(commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
		})).rejects.toMatchObject({ code: "UNIT_CHANGE_WITH_STOCK", statusCode: 409 });
		expect(mocks.tx.inventory_item.update).not.toHaveBeenCalled();
	});

	it("creates stock at zero and applies the target snapshot only through the ledger", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord());
		mocks.tx.inventory_import_candidate.findMany.mockResolvedValue([
			candidate({
				normalized_proposal: {
					name: "Filter",
					location: "A1",
					quantity: 4,
					cost: 2,
					cost_at_receipt: 1.5,
				},
				requires_financial_approval: true,
				financial_approved_at: NOW,
			}),
		]);
		mocks.tx.inventory_import.update.mockImplementation(async ({ data }: { data: { status: string } }) =>
			importRecord({ status: data.status, committed_at: data.status === "committed" ? NOW : null }),
		);
		mocks.tx.inventory_item.create.mockResolvedValue(item({ quantity: 0, cost: 2 }));
		mocks.tx.inventory_item.findFirst
			.mockResolvedValueOnce({ id: "item-1", quantity: 0, is_serialized: false, is_batch_tracked: false })
			.mockResolvedValueOnce(item({ quantity: 4, cost: 2 }));
		mocks.recordMovements.mockResolvedValue({ movementIds: ["movement-1"] });
		mocks.tx.inventory_import_change.create.mockResolvedValue({ id: "change-1" });
		mocks.tx.log.create.mockResolvedValue({ id: "log-1" });

		const result = await commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
			dispatcherId: "dispatcher-1",
		});

		expect(result).toMatchObject({ status: "committed", item_ids: ["item-1"], idempotent: false });
		expect(mocks.tx.inventory_item.create.mock.calls[0][0].data.quantity).toBe(0);
		expect(mocks.recordMovements).toHaveBeenCalledWith(
			mocks.tx,
			"org-1",
			{ actor_type: "dispatcher", actor_id: "dispatcher-1" },
			[expect.objectContaining({ inventory_item_id: "item-1", qty: 4, reason: "initial", unit_cost: 1.5 })],
		);
		expect(mocks.tx.inventory_import_change.create).toHaveBeenCalledWith(expect.objectContaining({
			data: expect.objectContaining({ stock_movement_ids: ["movement-1"], action: "created" }),
		}));
	});

	it.each([
		{ approved: false, expected: [] },
		{ approved: true, expected: ["https://images.example.test/filter.jpg"] },
	])("attaches a product photo only after explicit approval ($approved)", async ({ approved, expected }) => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord());
		mocks.tx.inventory_import_candidate.findMany.mockResolvedValue([
			candidate({
				user_overrides: approved ? { photo_attachment_approved: true } : {},
				source: {
					source_type: "product_photo",
					storage_url: "https://images.example.test/filter.jpg",
				},
			}),
		]);
		mocks.tx.inventory_import.update.mockImplementation(async ({ data }: { data: { status: string } }) =>
			importRecord({ status: data.status, committed_at: data.status === "committed" ? NOW : null }),
		);
		mocks.tx.inventory_item.create.mockResolvedValue(item({ quantity: 0, image_urls: expected }));
		mocks.tx.inventory_item.findFirst
			.mockResolvedValueOnce({ id: "item-1", quantity: 0, is_serialized: false, is_batch_tracked: false })
			.mockResolvedValueOnce(item({ quantity: 0, image_urls: expected }));
		mocks.tx.inventory_import_change.create.mockResolvedValue({ id: "change-1" });
		mocks.tx.log.create.mockResolvedValue({ id: "log-1" });

		await commitInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			revision: 4,
		});

		expect(mocks.tx.inventory_item.create.mock.calls[0][0].data.image_urls).toEqual(expected);
	});
});

describe("undoInventoryImport", () => {
	it("rejects undo after the configured deadline before touching stock", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord({
			status: "committed",
			committed_at: new Date(Date.now() - 60_000),
			undo_expires_at: new Date(Date.now() - 1),
			changes: [],
		}));

		await expect(undoInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
		})).rejects.toMatchObject({ code: "UNDO_EXPIRED", statusCode: 409 });
		expect(mocks.tx.stock_movement.findFirst).not.toHaveBeenCalled();
	});

	it("blocks undo when a later stock movement exists", async () => {
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord({
			status: "committed",
			committed_at: NOW,
			undo_expires_at: new Date(Date.now() + 60_000),
			changes: [{
				inventory_item_id: "item-1",
				stock_movement_ids: ["movement-1"],
			}],
		}));
		mocks.tx.stock_movement.findFirst.mockResolvedValue({ id: "later-movement" });

		await expect(undoInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
		})).rejects.toMatchObject({ code: "UNDO_BLOCKED_BY_ACTIVITY", statusCode: 409 });
		expect(mocks.recordMovements).not.toHaveBeenCalled();
	});

	it("restores an updated item's prior snapshot atomically", async () => {
		const current = item({ name: "Imported name" });
		mocks.tx.inventory_import.findFirst.mockResolvedValue(importRecord({
			status: "committed",
			committed_at: NOW,
			undo_expires_at: new Date(Date.now() + 60_000),
			changes: [{
				id: "change-1",
				inventory_item_id: "item-1",
				action: "updated",
				before_snapshot: snap("Original name"),
				after_snapshot: snap("Imported name"),
				created_mapping_ids: [],
				stock_movement_ids: [],
				created_variant_group_id: null,
			}],
		}));
		mocks.tx.stock_movement.findFirst.mockResolvedValue(null);
		mocks.tx.inventory_item.findFirst.mockResolvedValue(current);
		mocks.tx.stock_movement.findMany.mockResolvedValue([]);
		mocks.tx.inventory_item.update.mockResolvedValue(item({ name: "Original name" }));
		mocks.tx.inventory_import.update.mockImplementation(async ({ data }: { data: { status: string } }) =>
			importRecord({ status: data.status }),
		);
		mocks.tx.log.create.mockResolvedValue({ id: "log-1" });

		await expect(undoInventoryImport({
			importId: "import-1",
			organizationId: "org-1",
			dispatcherId: "dispatcher-1",
		})).resolves.toMatchObject({ status: "undone", idempotent: false });
		const restore = mocks.tx.inventory_item.update.mock.calls[0][0];
		expect(restore).toEqual(expect.objectContaining({
			where: { id: "item-1" },
			data: expect.objectContaining({ name: "Original name" }),
		}));
		expect(restore.data).not.toHaveProperty("quantity");
	});
});
