import { describe, it, expect, vi } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn() }));

import { decideDefaultTax, shouldResetAck, type DefaultTaxInput } from "../tax/precedence.js";
import { dropClientTaxTotals, effectiveTaxMode } from "../tax/taxMode.js";
import type { AddressOutcome } from "../tax/taxResolver.js";
import type { RateSetView } from "../tax/rateSet.js";

const IL_SET: RateSetView = {
	id: "set-il",
	state_code: "IL",
	total_rate: 0.08,
	components: [{ id: "c1", jurisdiction_type: "state", jurisdiction_name: "IL", jurisdiction_code: null, rate: 0.08 }],
};
const WI_SET: RateSetView = { ...IL_SET, id: "set-wi", state_code: "WI" };
const ORG_DEFAULT = { id: "g-def", name: "Default", rates: [{ id: "r1", name: "State", rate: 0.05 }] };
const rate = (over: Partial<Extract<AddressOutcome, { kind: "rate" }>> = {}): AddressOutcome => ({
	kind: "rate",
	stale: false,
	resolution_id: "res-1",
	rate_set: WI_SET,
	sourcing: "D",
	reasons: [],
	...over,
});
const input = (over: Partial<DefaultTaxInput> = {}): DefaultTaxInput => ({
	mode: "auto",
	clientExempt: false,
	clientHasGroup: false,
	explicitTaxableLine: false,
	needsDefault: true,
	outcome: rate(),
	orgDefault: ORG_DEFAULT,
	legacyRate: 0,
	registeredStates: ["WI"],
	...over,
});

describe("decideDefaultTax", () => {
	it("1: exempt client → no tax, no source", () => {
		expect(decideDefaultTax(input({ clientExempt: true }))).toMatchObject({ group: null, source: null, needs_review: false });
	});

	it("2: client group, or every taxable line explicit → manual_override", () => {
		expect(decideDefaultTax(input({ clientHasGroup: true, needsDefault: false }))).toMatchObject({ source: "manual_override", group: null });
		expect(decideDefaultTax(input({ explicitTaxableLine: true, needsDefault: false }))).toMatchObject({ source: "manual_override" });
	});

	it("nothing taxable → no source and no review", () => {
		expect(decideDefaultTax(input({ needsDefault: false }))).toMatchObject({ source: null, needs_review: false });
	});

	it("3/4: a resolved rate set in a registered state → provider, no review", () => {
		expect(decideDefaultTax(input())).toMatchObject({
			source: "provider",
			needs_review: false,
			review_reason: null,
			resolution_id: "res-1",
			rate_set_id: "set-wi",
			sourcing: "D",
			group: { id: "set-wi" },
		});
	});

	it("registration check: unregistered state → review with the exact reason, rate still applied", () => {
		const d = decideDefaultTax(input({ outcome: rate({ rate_set: IL_SET }) }));
		expect(d).toMatchObject({ source: "provider", needs_review: true, review_reason: "Not registered to collect in IL", group: { id: "set-il" } });
	});

	it("5: stale → cached_stale + review with the resolver's reason", () => {
		const d = decideDefaultTax(input({ outcome: rate({ stale: true, reasons: ["down; using the rate looked up on 2026-10-02"] }) }));
		expect(d).toMatchObject({ source: "cached_stale", needs_review: true, review_reason: "down; using the rate looked up on 2026-10-02" });
	});

	it("6: no rate → org default + review", () => {
		const d = decideDefaultTax(input({ outcome: { kind: "none", ambiguous: true, resolution_id: "res-9", reasons: ["PO box"] } }));
		expect(d).toMatchObject({ source: "org_default", needs_review: true, review_reason: "PO box", group: ORG_DEFAULT, resolution_id: "res-9" });
	});

	it("7: nothing configured → legacy org rate + review", () => {
		const d = decideDefaultTax(input({ outcome: { kind: "none", ambiguous: false, resolution_id: null, reasons: ["down"] }, orgDefault: null, legacyRate: 0.05 }));
		expect(d.source).toBe("legacy");
		expect(d.needs_review).toBe(true);
		expect(d.group).toEqual({ id: "legacy", name: "Organization tax rate", rates: [{ id: "legacy", name: "Sales tax", rate: 0.05 }] });
		expect(d.review_reason).toBe("down; No default tax group; using the organization tax rate");
	});

	it("7: legacy rate of zero → legacy source, no group, review", () => {
		const d = decideDefaultTax(input({ outcome: null, orgDefault: null, legacyRate: 0 }));
		expect(d).toMatchObject({ source: "legacy", group: null, needs_review: true });
	});

	it("manual mode skips 3–5: org default with no review, and never consults the outcome", () => {
		expect(decideDefaultTax(input({ mode: "manual", outcome: null }))).toMatchObject({ source: "org_default", needs_review: false, group: ORG_DEFAULT });
		expect(decideDefaultTax(input({ mode: "manual", outcome: null, orgDefault: null }))).toMatchObject({ source: null, group: null, needs_review: false });
	});
});

describe("effectiveTaxMode", () => {
	// Review Focus 5
	it("is manual when auto is stored but the plan no longer includes tax_auto", () => {
		expect(effectiveTaxMode("auto", false)).toBe("manual");
		expect(effectiveTaxMode("auto", true)).toBe("auto");
		expect(effectiveTaxMode("manual", true)).toBe("manual");
		expect(effectiveTaxMode(null, true)).toBe("manual");
	});
});

describe("dropClientTaxTotals", () => {
	// Review Focus 2
	it("drops client-computed totals in auto mode only", () => {
		const parsed = { title: "x", subtotal: 1, tax_rate: 0.1, tax_amount: 2, discount_amount: 0, total: 3, estimated_total: 3, discount_value: 5 };
		expect(dropClientTaxTotals(parsed, "auto")).toEqual({ title: "x", discount_value: 5 });
		expect(dropClientTaxTotals(parsed, "manual")).toBe(parsed);
	});
});

describe("shouldResetAck", () => {
	it("resets when a review newly appears or its source changes, not when it is unchanged", () => {
		expect(shouldResetAck({ tax_source: "provider", tax_needs_review: false, review_reason: null }, { source: "provider", needs_review: true, review_reason: "r" })).toBe(true);
		expect(shouldResetAck({ tax_source: "cached_stale", tax_needs_review: true, review_reason: "r" }, { source: "org_default", needs_review: true, review_reason: "r" })).toBe(true);
		expect(shouldResetAck({ tax_source: "cached_stale", tax_needs_review: true, review_reason: "r" }, { source: "cached_stale", needs_review: true, review_reason: "r" })).toBe(false);
		expect(shouldResetAck({ tax_source: "cached_stale", tax_needs_review: true, review_reason: "r" }, { source: "provider", needs_review: false, review_reason: null })).toBe(false);
	});

	it("resets when the source is unchanged but the reason differs", () => {
		const prev = { tax_source: "provider", tax_needs_review: true, review_reason: "Not registered to collect in IL" };
		expect(shouldResetAck(prev, { source: "provider", needs_review: true, review_reason: "Not registered to collect in IL" })).toBe(false);
		expect(shouldResetAck(prev, { source: "provider", needs_review: true, review_reason: "Not registered to collect in MN" })).toBe(true);
		expect(shouldResetAck({ tax_source: "provider", tax_needs_review: true }, { source: "provider", needs_review: true, review_reason: "Not registered to collect in MN" })).toBe(true);
	});
});
