import { describe, expect, test } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLineItems } from "../../hooks/forms/useLineItems";
import { lineTaxPayload } from "../../lib/taxEditorMode";
import { UpdateRecurringPlanSchema } from "../recurringPlans";

const line = { name: "Filter", quantity: 1, unit_price: 10, sort_order: 0 };

describe("recurring plan line taxable", () => {
	test("toggling a line to No Tax lands taxable:false in the update payload", () => {
		const { result } = renderHook(() => useLineItems({ mode: "edit", minItems: 0 }));
		act(() =>
			result.current.setLineItems([
				{
					id: "a",
					entity_line_item_id: "server-1",
					name: "Filter",
					description: "",
					quantity: 1,
					unit_price: 10,
					item_type: "",
					total: 10,
					taxable: true,
				} as never,
			]),
		);
		act(() => result.current.setLineItemTaxGroup("a", "6b0c1f5e-1d3a-4c55-9c0e-0a1b2c3d4e50", true));
		act(() => result.current.setLineItemTaxGroup("a", null, false));
		const item = result.current.activeLineItems[0];
		expect(result.current.dirtyLineItemFields["li:a:taxable"]).toBe(true);

		const parsed = UpdateRecurringPlanSchema.parse({
			line_items: [{ ...line, id: "6b0c1f5e-1d3a-4c55-9c0e-0a1b2c3d4e5f", ...lineTaxPayload(item) }],
		});
		expect(parsed.line_items?.[0].taxable).toBe(false);
		expect(parsed.line_items?.[0].tax_group_id).toBeNull();
	});

	test("update schema keeps an explicit taxable:true", () => {
		const parsed = UpdateRecurringPlanSchema.parse({ line_items: [{ ...line, taxable: true }] });
		expect(parsed.line_items?.[0].taxable).toBe(true);
	});

	test("a chosen tax group is sent with the line", () => {
		const gid = "6b0c1f5e-1d3a-4c55-9c0e-0a1b2c3d4e50";
		const parsed = UpdateRecurringPlanSchema.parse({
			line_items: [{ ...line, ...lineTaxPayload({ taxable: true, tax_group_id: gid }) }],
		});
		expect(parsed.line_items?.[0].tax_group_id).toBe(gid);
	});
});
