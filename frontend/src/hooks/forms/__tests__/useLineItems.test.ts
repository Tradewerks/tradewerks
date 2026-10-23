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

describe("useLineItems — late-resolving defaultTaxGroupId", () => {
	test("stamps the untouched blank first line once the default group arrives", () => {
		const { result, rerender } = renderHook(
			({ gid }: { gid: string | null }) =>
				useLineItems({ mode: "create", defaultTaxGroupId: gid }),
			{ initialProps: { gid: null as string | null } },
		);
		expect(result.current.lineItems[0].tax_group_id).toBeNull();
		rerender({ gid: "g1" });
		expect(result.current.lineItems[0].tax_group_id).toBe("g1");
	});

	test("leaves an edited or deliberately untaxed line alone", () => {
		const { result, rerender } = renderHook(
			({ gid }: { gid: string | null }) =>
				useLineItems({ mode: "create", defaultTaxGroupId: gid }),
			{ initialProps: { gid: null as string | null } },
		);
		const id = result.current.lineItems[0].id;
		act(() => result.current.setLineItemTaxGroup(id, null, false));
		rerender({ gid: "g1" });
		expect(result.current.lineItems[0].tax_group_id).toBeNull();
		expect(result.current.lineItems[0].taxable).toBe(false);
	});

	test("never stamps when the default stays null (auto mode)", () => {
		const { result, rerender } = renderHook(
			({ gid }: { gid: string | null }) =>
				useLineItems({ mode: "create", defaultTaxGroupId: gid }),
			{ initialProps: { gid: null as string | null } },
		);
		rerender({ gid: null });
		expect(result.current.lineItems[0].tax_group_id).toBeNull();
	});
});

describe("useLineItems — plain taxable flag", () => {
	const TAXABILITY_KEYS = [
		"tax_category",
		"taxability_source",
		"tax_category_touched",
		"taxability_touched",
	];
	const loaded = makeItem({ id: "s1", name: "Furnace repair", item_type: "labor" });

	test("the hook exposes no category or reset-to-rule setters", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));
		expect(result.current).not.toHaveProperty("setLineItemTaxCategory");
		expect(result.current).not.toHaveProperty("resetLineItemTaxability");
	});

	test("flipping taxable marks only taxable dirty and writes no source marker", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));
		act(() => result.current.setLineItems([loaded]));
		act(() => result.current.setLineItemTaxGroup("s1", null, false));
		const line = result.current.lineItems[0];
		expect(line.taxable).toBe(false);
		expect(result.current.dirtyLineItemFields["li:s1:taxable"]).toBe(true);
		for (const k of TAXABILITY_KEYS) expect(line).not.toHaveProperty(k);
	});

	test("seeded and appended lines keep taxable and carry no taxability keys", () => {
		const seed = {
			name: "Fee",
			description: "",
			quantity: 1,
			unit_price: 50,
			item_type: "other" as const,
			taxable: false,
		};
		const { result } = renderHook(() => useLineItems({ mode: "create" }));
		act(() => result.current.seedLineItems([seed]));
		act(() => result.current.appendLineItems([seed]));
		for (const line of result.current.lineItems) {
			expect(line.taxable).toBe(false);
			for (const k of TAXABILITY_KEYS) expect(line).not.toHaveProperty(k);
		}
	});
});

describe("useLineItems — taxable follows the picked inventory item", () => {
	const pick = (taxable: boolean) => ({
		inventory_item_id: "inv-1",
		name: "Filter",
		unit_price: 10,
		taxable,
	});

	test("a hand-typed blank line starts taxable", () => {
		const { result } = renderHook(() => useLineItems({ mode: "create" }));
		expect(result.current.lineItems[0].taxable).toBe(true);
		act(() => result.current.addLineItem());
		expect(result.current.lineItems[1].taxable).toBe(true);
	});

	test("picking a non-taxable item makes the line non-taxable", () => {
		const { result } = renderHook(() => useLineItems({ mode: "create" }));
		const id = result.current.lineItems[0].id;
		act(() => result.current.setLineItemInventoryItem(id, pick(false)));
		expect(result.current.lineItems[0].taxable).toBe(false);
	});

	test("re-picking the item after the dispatcher flipped the line takes the item's flag again", () => {
		const { result } = renderHook(() => useLineItems({ mode: "create" }));
		const id = result.current.lineItems[0].id;
		act(() => result.current.setLineItemInventoryItem(id, pick(false)));
		act(() => result.current.setLineItemTaxGroup(id, null, true));
		expect(result.current.lineItems[0].taxable).toBe(true);
		act(() => result.current.setLineItemInventoryItem(id, pick(false)));
		expect(result.current.lineItems[0].taxable).toBe(false);
	});

	test("flipping without re-picking keeps the dispatcher's value across save and reload", () => {
		const first = renderHook(() => useLineItems({ mode: "create" }));
		const id = first.result.current.lineItems[0].id;
		act(() => first.result.current.setLineItemInventoryItem(id, pick(false)));
		act(() => first.result.current.setLineItemTaxGroup(id, null, true));
		const saved = first.result.current.lineItems;

		const reloaded = renderHook(() => useLineItems({ mode: "edit", initialItems: saved }));
		expect(reloaded.result.current.lineItems[0].taxable).toBe(true);
		expect(reloaded.result.current.lineItems[0].inventory_item_id).toBe("inv-1");
	});

	test("a link without a flag leaves the line's taxable alone", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", initialItems: [makeItem({ taxable: false })] }),
		);
		act(() =>
			result.current.setLineItemInventoryItem("li-1", {
				inventory_item_id: "inv-2",
				name: "Quick",
				unit_price: null,
			}),
		);
		expect(result.current.lineItems[0].taxable).toBe(false);
	});

	test("in edit mode the pick marks taxable dirty only when it differs from the original", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit" }));
		act(() => result.current.setLineItems([makeItem()]));
		act(() => result.current.setLineItemInventoryItem("li-1", pick(false)));
		expect(result.current.dirtyLineItemFields["li:li-1:taxable"]).toBe(true);
		act(() => result.current.setLineItemInventoryItem("li-1", pick(true)));
		expect(result.current.dirtyLineItemFields["li:li-1:taxable"]).toBe(false);
	});
});

describe("useLineItems — appended lines keep their source tax group", () => {
	const seed = {
		name: "Coil",
		description: "",
		quantity: 1,
		unit_price: 100,
		item_type: "material" as const,
	};

	test("a named group survives over the default group", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", minItems: 0, defaultTaxGroupId: "g-default" }),
		);
		act(() => result.current.appendLineItems([{ ...seed, tax_group_id: "g-source" }]));
		expect(result.current.lineItems.at(-1)?.tax_group_id).toBe("g-source");
	});

	test("an explicit null stays null; an absent group takes the default", () => {
		const { result } = renderHook(() =>
			useLineItems({ mode: "create", minItems: 0, defaultTaxGroupId: "g-default" }),
		);
		act(() => result.current.appendLineItems([{ ...seed, tax_group_id: null }, seed]));
		const [explicitNull, absent] = result.current.lineItems.slice(-2);
		expect(explicitNull.tax_group_id).toBeNull();
		expect(absent.tax_group_id).toBe("g-default");
	});
});
