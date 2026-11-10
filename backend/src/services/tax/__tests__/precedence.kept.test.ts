import { describe, it, expect } from "vitest";

import {
	decideDefaultTax,
	shouldResetAck,
	type DefaultTaxInput,
	type KeptRate,
} from "../precedence.js";
import type { RateSetView } from "../rateSet.js";
import type { AddressOutcome } from "../taxResolver.js";

const LA_CROSSE: RateSetView = {
	id: "rs1",
	state_code: "WI",
	total_rate: 0.055,
	components: [
		{ id: "c1", jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.05 },
		{ id: "c2", jurisdiction_type: "county", jurisdiction_name: "LA CROSSE", jurisdiction_code: "063", rate: 0.005 },
	],
};
const LOOKED_UP: RateSetView = { ...LA_CROSSE, id: "rs-lookup" };
const ORG_DEFAULT = { id: "g-def", name: "WI Standard", rates: [{ id: "r1", name: "State", rate: 0.0825 }] };

const kept = (over: Partial<KeptRate> = {}): KeptRate => ({
	rate_set: LA_CROSSE,
	source: "provider",
	needs_review: false,
	review_reason: null,
	resolution_id: "res-1",
	sourcing: "D",
	...over,
});
const lookup: AddressOutcome = {
	kind: "rate",
	stale: false,
	resolution_id: "res-lookup",
	rate_set: LOOKED_UP,
	sourcing: "O",
	reasons: [],
};
const input = (over: Partial<DefaultTaxInput> = {}): DefaultTaxInput => ({
	mode: "manual",
	clientExempt: false,
	clientHasGroup: false,
	explicitTaxableLine: false,
	needsDefault: true,
	outcome: null,
	orgDefault: ORG_DEFAULT,
	legacyRate: 0,
	registeredStates: ["WI"],
	kept: kept(),
	...over,
});

describe("decideDefaultTax — kept address rate", () => {
	it("manual mode reuses the kept rate set for ungrouped lines", () => {
		const d = decideDefaultTax(input());
		expect(d).toMatchObject({
			source: "provider",
			rate_set_id: "rs1",
			resolution_id: "res-1",
			sourcing: "D",
			needs_review: false,
			review_reason: null,
			kept_from_auto: true,
			group: { id: "rs1" },
		});
		expect(d.group?.name.endsWith(" (auto)")).toBe(true);
	});

	it("carries the kept rate's review over", () => {
		const d = decideDefaultTax(
			input({ kept: kept({ needs_review: true, review_reason: "Not registered to collect in IL" }) })
		);
		expect(d).toMatchObject({
			needs_review: true,
			review_reason: "Not registered to collect in IL",
			kept_from_auto: true,
		});
	});

	it("manual mode with nothing kept is the org default", () => {
		expect(decideDefaultTax(input({ kept: null }))).toMatchObject({
			source: "org_default",
			group: ORG_DEFAULT,
			kept_from_auto: false,
		});
	});

	it("auto mode ignores the kept rate and uses the lookup", () => {
		const d = decideDefaultTax(input({ mode: "auto", outcome: lookup }));
		expect(d).toMatchObject({
			source: "provider",
			rate_set_id: "rs-lookup",
			resolution_id: "res-lookup",
			sourcing: "O",
			kept_from_auto: false,
		});
	});

	it("an exempt client is untaxed whatever is kept", () => {
		expect(decideDefaultTax(input({ clientExempt: true }))).toMatchObject({
			source: null,
			group: null,
			kept_from_auto: false,
		});
	});

	it("keeping a flagged rate is the same review state, so the acknowledgment stands", () => {
		const d = decideDefaultTax(
			input({ kept: kept({ needs_review: true, review_reason: "Not registered to collect in IL" }) })
		);
		expect(
			shouldResetAck(
				{ tax_source: "provider", tax_needs_review: true, review_reason: "Not registered to collect in IL" },
				d
			)
		).toBe(false);
	});
});
