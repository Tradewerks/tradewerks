import { describe, it, expect, vi } from "vitest";
import {
	applyInventoryTaxable,
	applyInventoryTaxableToNewLines,
	lineTaxFieldsForCreate,
	lineTaxFieldsForUpdate,
} from "../inventoryTaxable.js";

function txWith(rows: { id: string; taxable: boolean }[]) {
	return { inventory_item: { findMany: vi.fn().mockResolvedValue(rows) } };
}

describe("applyInventoryTaxable", () => {
	it("non-taxable item + omitted taxable -> false", async () => {
		const tx = txWith([{ id: "inv1", taxable: false }]);
		const [out] = await applyInventoryTaxable(tx, "org-1", [{ inventory_item_id: "inv1" }]);
		expect(out!.taxable).toBe(false);
	});

	it("explicit taxable: true wins over a non-taxable item", async () => {
		const tx = txWith([{ id: "inv1", taxable: false }]);
		const [out] = await applyInventoryTaxable(tx, "org-1", [
			{ inventory_item_id: "inv1", taxable: true },
		]);
		expect(out!.taxable).toBe(true);
		expect(tx.inventory_item.findMany).not.toHaveBeenCalled();
	});

	it("lines without an inventory id are unchanged and cost no query", async () => {
		const tx = txWith([]);
		const lines = [{ name: "x" }, { inventory_item_id: null }];
		expect(await applyInventoryTaxable(tx, "org-1", lines)).toBe(lines);
		expect(tx.inventory_item.findMany).not.toHaveBeenCalled();
	});

	it("one org-scoped query for many lines, deduped ids", async () => {
		const tx = txWith([
			{ id: "a", taxable: false },
			{ id: "b", taxable: true },
		]);
		const out = await applyInventoryTaxable(tx, "org-1", [
			{ inventory_item_id: "a" },
			{ inventory_item_id: "b" },
			{ inventory_item_id: "a" },
		]);
		expect(out.map((l) => l.taxable)).toEqual([false, true, false]);
		expect(tx.inventory_item.findMany).toHaveBeenCalledTimes(1);
		expect(tx.inventory_item.findMany).toHaveBeenCalledWith({
			where: { id: { in: ["a", "b"] }, organization_id: "org-1" },
			select: { id: true, taxable: true },
		});
	});

	it("an item not found in the org leaves the line untouched", async () => {
		const tx = txWith([]);
		const [out] = await applyInventoryTaxable(tx, "org-1", [{ inventory_item_id: "gone" }]);
		expect(out!.taxable).toBeUndefined();
	});
});

describe("applyInventoryTaxableToNewLines", () => {
	it("fills only lines not already stored", async () => {
		const tx = txWith([{ id: "inv1", taxable: false }]);
		const existing = { id: "L1", inventory_item_id: "inv1" };
		const fresh = { inventory_item_id: "inv1" };
		const lookup = await applyInventoryTaxableToNewLines(tx, "org-1", [existing, fresh], new Set(["L1"]));
		expect(lookup(existing).taxable).toBeUndefined();
		expect(lookup(fresh).taxable).toBe(false);
	});
});

describe("lineTaxFieldsForUpdate", () => {
	it("omits fields the client did not send, so stored values stand", () => {
		expect(lineTaxFieldsForUpdate({})).toEqual({});
	});

	it("passes explicit values through, including false and a cleared group", () => {
		expect(lineTaxFieldsForUpdate({ taxable: false, tax_group_id: null })).toEqual({
			taxable: false,
			tax_group_id: null,
		});
	});
});

describe("lineTaxFieldsForCreate", () => {
	it("defaults an unset flag to taxable and an unset group to null", () => {
		expect(lineTaxFieldsForCreate({})).toEqual({ taxable: true, tax_group_id: null });
	});

	it("keeps an inventory-filled false and an explicit group", () => {
		expect(lineTaxFieldsForCreate({ taxable: false, tax_group_id: "g1" })).toEqual({
			taxable: false,
			tax_group_id: "g1",
		});
	});
});
