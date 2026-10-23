import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { useAddressTaxChoice } from "../useAddressTaxChoice";
import type { TaxGroup, TaxSnapshot } from "../../../types/tax";
import type { AutoTaxEstimate } from "../../../lib/taxEditorMode";

const kept: AutoTaxEstimate = {
	rate: 0.055,
	rates: [0.05, 0.005],
	place: "La Crosse, WI",
	rounding: "jurisdiction_half_up",
};
const draft = { locked_at: "draft" } as TaxSnapshot;
const doc = { address: "1 Main St, La Crosse, WI", coords: { lat: 43.8, lon: -91.2 } };
const moved = { address: "100 N State St, Chicago, IL", coords: { lat: 41.9, lon: -87.6 } };
const lines = [{ id: "l1", total: 420, taxable: true, tax_group_id: null }];

const base = {
	docNoun: "quote" as const,
	snapshot: draft,
	keptEstimate: kept,
	geo: moved,
	doc,
	lines,
	discountAmount: 0,
	discountType: "amount" as const,
	discountValue: 0,
	taxGroups: [],
	rounding: "jurisdiction_half_up" as const,
};

describe("useAddressTaxChoice", () => {
	it("does not ask when the address is unchanged or the rate is not kept", () => {
		const same = renderHook(() => useAddressTaxChoice({ ...base, geo: doc }));
		expect(same.result.current.ask).toBe(false);
		expect(same.result.current.canSubmit).toBe(true);
		const notKept = renderHook(() => useAddressTaxChoice({ ...base, keptEstimate: null }));
		expect(notKept.result.current.ask).toBe(false);
		const issued = renderHook(() =>
			useAddressTaxChoice({ ...base, snapshot: { locked_at: "2026-10-01" } as TaxSnapshot }),
		);
		expect(issued.result.current.ask).toBe(false);
	});

	it("blocks Save until answered, then sends the answer", () => {
		const { result } = renderHook(() => useAddressTaxChoice(base));
		expect(result.current.ask).toBe(true);
		expect(result.current.canSubmit).toBe(false);
		expect(result.current.payloadChoice).toBeUndefined();
		expect(result.current.panelProps.keepCents).toBe(2310);
		expect(result.current.addressChangedForSummary).toBe(true);
		act(() => result.current.panelProps.onChange("keep"));
		expect(result.current.canSubmit).toBe(true);
		expect(result.current.payloadChoice).toBe("keep");
		// Keeping makes the summary's exact kept figure the one Save stores.
		expect(result.current.addressChangedForSummary).toBe(false);
	});

	it("a picked group lands on ungrouped taxable lines in the payload", () => {
		const { result } = renderHook(() => useAddressTaxChoice(base));
		act(() => result.current.panelProps.onChange({ group_id: "g1" }));
		expect(result.current.lineGroup({ taxable: true, tax_group_id: null })).toBe("g1");
		expect(result.current.lineGroup({ taxable: true, tax_group_id: "g2" })).toBe("g2");
	});

	it("an unexpected refusal opens the prompt from its details", () => {
		const { result } = renderHook(() =>
			useAddressTaxChoice({ ...base, keptEstimate: null }),
		);
		const err = new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
			status: 409,
			data: {
				error: {
					code: "ADDRESS_TAX_CHOICE_REQUIRED",
					details: { rate_label: "La Crosse, WI", rate: 0.055, documents: [] },
				},
			},
		} as AxiosResponse);
		let handled = false;
		act(() => {
			handled = result.current.handleError(err);
		});
		expect(handled).toBe(true);
		expect(result.current.ask).toBe(true);
		expect(result.current.panelProps.rateLabel).toBe("La Crosse, WI");
		expect(result.current.handleError(new Error("other"))).toBe(false);
	});

	it("reset clears an earlier refusal and answer", () => {
		const { result } = renderHook(() =>
			useAddressTaxChoice({ ...base, geo: doc, keptEstimate: null }),
		);
		act(() => {
			result.current.handleError(refusalError());
		});
		act(() => result.current.panelProps.onChange("default"));
		expect(result.current.ask).toBe(true);
		expect(result.current.payloadChoice).toBe("default");
		act(() => result.current.reset());
		expect(result.current.ask).toBe(false);
		expect(result.current.panelProps.value).toBeNull();
		expect(result.current.payloadChoice).toBeUndefined();
	});

	it("feeds the summary: pending, then the answered group's tax; Keep uses the kept row", () => {
		const wi = {
			id: "g-wi",
			name: "WI Standard",
			is_default: true,
			is_active: true,
			combined_rate: 0.0825,
			rates: [{ tax_rate: { rate: 0.05 } }, { tax_rate: { rate: 0.0325 } }],
		} as unknown as TaxGroup;
		const { result } = renderHook(() => useAddressTaxChoice({ ...base, taxGroups: [wi] }));
		expect(result.current.summaryChoice).toBe("pending");
		act(() => result.current.panelProps.onChange("default"));
		expect(result.current.summaryChoice).toEqual({ label: "WI Standard", cents: 3465 });
		act(() => result.current.panelProps.onChange({ group_id: "g-wi" }));
		expect(result.current.summaryChoice).toEqual({ label: "WI Standard", cents: 3465 });
		act(() => result.current.panelProps.onChange("keep"));
		expect(result.current.summaryChoice).toBeNull();
	});

	it("a chosen group's tax matches the engine when lines already in that group merge in", () => {
		const g5 = {
			id: "g5",
			name: "Five",
			is_default: true,
			is_active: true,
			combined_rate: 0.05,
			rates: [{ tax_rate: { rate: 0.05 } }],
		} as unknown as TaxGroup;
		// Half-up per group: $1.10 + $1.10 at 5% is 11¢ together, 6¢ + 6¢ apart.
		const mixed = [
			{ id: "a", total: 1.1, taxable: true, tax_group_id: "g5" },
			{ id: "b", total: 1.1, taxable: true, tax_group_id: null },
		];
		const { result } = renderHook(() =>
			useAddressTaxChoice({ ...base, lines: mixed, taxGroups: [g5] }),
		);
		// The summary already shows the explicit line's 6¢ group row; the choice adds the rest.
		act(() => result.current.panelProps.onChange("default"));
		expect(result.current.summaryChoice).toEqual({ label: "Five", cents: 5 });
		act(() => result.current.panelProps.onChange({ group_id: "g5" }));
		expect(result.current.summaryChoice).toEqual({ label: "Five", cents: 5 });
	});
});

function refusalError() {
	return new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
		status: 409,
		data: {
			error: {
				code: "ADDRESS_TAX_CHOICE_REQUIRED",
				details: { rate_label: "La Crosse, WI", rate: 0.055, documents: [] },
			},
		},
	} as AxiosResponse);
}
