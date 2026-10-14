import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: {
		item_external_mapping: { findFirst: vi.fn() },
		inventory_item: { findMany: vi.fn() },
	},
}));

vi.mock("../../../db.js", () => ({ db: mocks.db }));

import { candidateIdentity, matchInventoryCandidate } from "../matcher.js";

const updatedAt = new Date("2026-09-23T12:00:00.000Z");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.db.item_external_mapping.findFirst.mockResolvedValue(null);
	mocks.db.inventory_item.findMany.mockResolvedValue([]);
});

describe("candidateIdentity", () => {
	it("prefers stable platform identity ahead of barcode and SKU", () => {
		expect(candidateIdentity({
			external_id: " Product-42 ",
			source_namespace: "QuickBooks",
			barcode: "123",
			sku: "ABC",
		})).toBe("external:quickbooks:product 42");
	});
});

describe("matchInventoryCandidate", () => {
	it("stops at a within-import duplicate before querying inventory", async () => {
		await expect(matchInventoryCandidate("org-1", { sku: "ABC" }, "sku:abc")).resolves.toMatchObject({
			action: "conflict",
			duplicateGroup: "sku:abc",
			evidence: { tier: "within_import" },
		});
		expect(mocks.db.inventory_item.findMany).not.toHaveBeenCalled();
	});

	it("matches an accepted external identity in the same organization and namespace", async () => {
		mocks.db.item_external_mapping.findFirst.mockResolvedValue({
			inventory_item: { id: "item-1", quantity: 9, updated_at: updatedAt },
		});
		const result = await matchInventoryCandidate("org-1", {
			external_id: "external-1",
			source_namespace: "QB",
		});
		expect(result).toMatchObject({
			action: "update",
			existingItemId: "item-1",
			existingQuantity: 9,
			evidence: { tier: "external_identity" },
		});
		expect(mocks.db.item_external_mapping.findFirst).toHaveBeenCalledWith(expect.objectContaining({
			where: expect.objectContaining({
				provider: "inventory-import:qb",
				account_id: "org-1",
				external_id: "external-1",
				inventory_item: { organization_id: "org-1" },
			}),
		}));
	});

	it("uses an exact organization-scoped barcode match", async () => {
		mocks.db.inventory_item.findMany.mockResolvedValueOnce([
			{ id: "item-1", quantity: 2, updated_at: updatedAt },
		]);
		await expect(matchInventoryCandidate("org-1", { barcode: "012345" })).resolves.toMatchObject({
			action: "update",
			existingItemId: "item-1",
			evidence: { tier: "exact_barcode" },
		});
		expect(mocks.db.inventory_item.findMany.mock.calls[0][0].where).toEqual({
			organization_id: "org-1",
			barcode: "012345",
		});
	});

	it("turns multiple exact SKU matches into a conflict instead of a create", async () => {
		mocks.db.inventory_item.findMany.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "item-1", quantity: 1, updated_at: updatedAt },
				{ id: "item-2", quantity: 3, updated_at: updatedAt },
			]);
		await expect(matchInventoryCandidate("org-1", { barcode: "none", sku: "DUP-1" })).resolves.toMatchObject({
			action: "conflict",
			evidence: { tier: "ambiguous_sku", candidates: ["item-1", "item-2"] },
		});
	});

	it("matches an exact alternate ID after SKU and barcode miss", async () => {
		mocks.db.inventory_item.findMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "item-3", quantity: 7, updated_at: updatedAt }]);
		const result = await matchInventoryCandidate("org-1", {
			barcode: "none",
			sku: "none",
			alt_ids: ["ALT-7"],
		});
		expect(result).toMatchObject({ action: "update", existingItemId: "item-3", evidence: { tier: "exact_alternate_id" } });
	});

	it("requires review when multiple high-similarity items remain plausible", async () => {
		mocks.db.inventory_item.findMany.mockResolvedValue([
			{ id: "item-1", name: "Carrier blower motor", unit: "each", category: "motors", quantity: 1, updated_at: updatedAt },
			{ id: "item-2", name: "Carrier blower motor assembly", unit: "each", category: "motors", quantity: 1, updated_at: updatedAt },
		]);
		await expect(matchInventoryCandidate("org-1", {
			name: "Carrier blower motor",
			unit: "each",
			category: "motors",
		})).resolves.toMatchObject({ action: "conflict", evidence: { tier: "ambiguous_similarity" } });
	});

	it("creates only when deterministic and fuzzy tiers find no match", async () => {
		await expect(matchInventoryCandidate("org-1", {
			name: "Unique economizer harness",
			unit: "each",
			category: "controls",
		})).resolves.toMatchObject({ action: "create", evidence: { tier: "no_match" } });
	});
});
