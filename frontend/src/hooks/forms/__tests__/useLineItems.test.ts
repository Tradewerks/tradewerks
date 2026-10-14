import { renderHook, act } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { useLineItems } from "../useLineItems";
import type { BaseLineItem } from "../../../types/common";

function makeItem(overrides: Partial<BaseLineItem> = {}): BaseLineItem {
	return {
		id: "li-1",
		name: "Widget",
		description: "",
		quantity: 2,
		unit_price: 10,
		item_type: "material",
		total: 20,
		taxable: true,
		tax_group_id: null,
		inventory_item_id: null,
		...overrides,
	};
}

describe("useLineItems — setLineItemInventoryItem", () => {
	test("links the line: sets id, overwrites name, adopts catalog price, recomputes total", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", initialItems: [makeItem({ quantity: 2 })] })
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		const item = result.current.lineItems[0];
		expect(item.inventory_item_id).toBe("inv-1");
		expect(item.name).toBe("Catalog Widget");
		expect(item.unit_price).toBe(15);
		expect(item.total).toBe(30); // 2 * 15
	});

	test("unit_price: null (quick-add path) keeps the line's existing price and recomputes total from it", () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ quantity: 3, unit_price: 12, total: 36 })],
			})
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-new",
				name: "Quick Added Part",
				unit_price: null,
			});
		});

		const item = result.current.lineItems[0];
		expect(item.inventory_item_id).toBe("inv-new");
		expect(item.name).toBe("Quick Added Part");
		expect(item.unit_price).toBe(12); // unchanged — held over from before the link
		expect(item.total).toBe(36); // 3 * 12, recomputed from the retained price
	});

	test("setLineItemInventoryItem(id, null) clears only inventory_item_id — name/price/total untouched", () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [
					makeItem({
						inventory_item_id: "inv-1",
						name: "Linked Widget",
						unit_price: 20,
						quantity: 2,
						total: 40,
					}),
				],
			})
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", null);
		});

		const item = result.current.lineItems[0];
		expect(item.inventory_item_id).toBeNull();
		// The customer was already quoted this price/name — unlinking must not disturb them.
		expect(item.name).toBe("Linked Widget");
		expect(item.unit_price).toBe(20);
		expect(item.total).toBe(40);
	});

	test("linking an untyped line classifies it as material — the pick IS the classification", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", initialItems: [makeItem({ item_type: "" })] })
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		expect(result.current.lineItems[0].item_type).toBe("material");
	});

	test("linking never overwrites a type the user already chose", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", initialItems: [makeItem({ item_type: "equipment" })] })
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		expect(result.current.lineItems[0].item_type).toBe("equipment");
	});

	test("unlinking leaves the type alone — unlinking is not unclassifying", () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ item_type: "material", inventory_item_id: "inv-1" })],
			})
		);

		act(() => {
			result.current.setLineItemInventoryItem("li-1", null);
		});

		expect(result.current.lineItems[0].item_type).toBe("material");
		expect(result.current.lineItems[0].inventory_item_id).toBeNull();
	});
});

describe("useLineItems — updateLineItem invalidates a stale link", () => {
	test("editing the name to different text clears the link", () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ inventory_item_id: "inv-1", name: "Widget" })],
			})
		);

		act(() => {
			result.current.updateLineItem("li-1", "name", "Something Else");
		});

		expect(result.current.lineItems[0].inventory_item_id).toBeNull();
		expect(result.current.lineItems[0].name).toBe("Something Else");
	});

	test("editing the name to the SAME text does not clear the link", () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ inventory_item_id: "inv-1", name: "Widget" })],
			})
		);

		act(() => {
			result.current.updateLineItem("li-1", "name", "Widget");
		});

		expect(result.current.lineItems[0].inventory_item_id).toBe("inv-1");
	});

	test('changing item_type to "labor" clears the link', () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ inventory_item_id: "inv-1", item_type: "material" })],
			})
		);

		act(() => {
			result.current.updateLineItem("li-1", "item_type", "labor");
		});

		expect(result.current.lineItems[0].inventory_item_id).toBeNull();
	});

	test('switching item_type between "material" and "equipment" keeps the link', () => {
		const { result } = renderHook(() =>
			useLineItems({
				mode: "create",
				initialItems: [makeItem({ inventory_item_id: "inv-1", item_type: "material" })],
			})
		);

		act(() => {
			result.current.updateLineItem("li-1", "item_type", "equipment");
		});

		expect(result.current.lineItems[0].inventory_item_id).toBe("inv-1");

		act(() => {
			result.current.updateLineItem("li-1", "item_type", "material");
		});

		expect(result.current.lineItems[0].inventory_item_id).toBe("inv-1");
	});
});

describe("useLineItems — dirty tracking in edit mode", () => {
	test("linking a previously-unlinked line marks inventory_item_id, name, and unit_price dirty", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));

		act(() => {
			result.current.setLineItems([makeItem({ name: "Widget", unit_price: 10, total: 20 })]);
		});

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		expect(result.current.dirtyLineItemFields["li:li-1:inventory_item_id"]).toBe(true);
		expect(result.current.dirtyLineItemFields["li:li-1:name"]).toBe(true);
		expect(result.current.dirtyLineItemFields["li:li-1:unit_price"]).toBe(true);
	});

	test("linking an untyped line marks item_type dirty, since the link supplied it", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));

		act(() => {
			result.current.setLineItems([makeItem({ item_type: "" })]);
		});

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		expect(result.current.dirtyLineItemFields["li:li-1:item_type"]).toBe(true);
	});

	test("linking a line that already had a type leaves item_type out of the dirty set", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));

		act(() => {
			result.current.setLineItems([makeItem({ item_type: "material" })]);
		});

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-1",
				name: "Catalog Widget",
				unit_price: 15,
			});
		});

		expect(result.current.dirtyLineItemFields["li:li-1:item_type"]).toBeUndefined();
	});

	test("linking with unit_price: null does not mark unit_price dirty, since the price didn't change", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));

		act(() => {
			result.current.setLineItems([makeItem({ name: "Widget", unit_price: 10, total: 20 })]);
		});

		act(() => {
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-new",
				name: "Widget", // same text — isolates the unit_price behavior from the name behavior
				unit_price: null,
			});
		});

		expect(result.current.dirtyLineItemFields["li:li-1:inventory_item_id"]).toBe(true);
		expect(result.current.dirtyLineItemFields["li:li-1:name"]).toBe(false);
		expect(result.current.dirtyLineItemFields["li:li-1:unit_price"]).toBeUndefined();
	});

	test("unlinking marks inventory_item_id dirty and does not touch name/unit_price dirty keys", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));

		act(() => {
			result.current.setLineItems([
				makeItem({
					inventory_item_id: "inv-1",
					name: "Catalog Widget",
					unit_price: 15,
					total: 30,
				}),
			]);
		});

		act(() => {
			result.current.setLineItemInventoryItem("li-1", null);
		});

		expect(result.current.dirtyLineItemFields["li:li-1:inventory_item_id"]).toBe(true);
		expect(result.current.dirtyLineItemFields["li:li-1:name"]).toBeUndefined();
		expect(result.current.dirtyLineItemFields["li:li-1:unit_price"]).toBeUndefined();
	});
});
