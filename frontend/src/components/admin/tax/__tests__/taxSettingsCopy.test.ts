import { describe, it, expect } from "vitest";
import type { TaxGroup } from "../../../../types/tax";
import {
	RATES_EXPLAINER,
	activeDefaultGroup,
	deactivateDefaultWarning,
	defaultCheckboxLabel,
	defaultChipLabel,
	defaultRowLabel,
	defaultRowNote,
	groupsExplainer,
	noDefaultWarning,
	ratesOutsideActiveGroups,
} from "../taxSettingsCopy";

const group = (over: Partial<TaxGroup> & { rateIds?: string[] } = {}): TaxGroup => {
	const { rateIds = [], ...rest } = over;
	return {
		id: "g",
		organization_id: "o",
		name: "G",
		description: null,
		is_default: false,
		is_active: true,
		rates: rateIds.map((id, i) => ({
			id: `gr-${id}`,
			sort_order: i,
			tax_rate: {
				id,
				organization_id: "o",
				name: id,
				rate: 0.01,
				description: null,
				jurisdiction: null,
				is_default: false,
				is_active: true,
				created_at: "",
				updated_at: "",
			},
		})),
		combined_rate: 0,
		created_at: "",
		updated_at: "",
		...rest,
	};
};

describe("taxSettingsCopy", () => {
	it.each([
		[defaultRowLabel("auto"), "When the address lookup fails, use"],
		[defaultRowLabel("manual"), "Default group — taxes lines without their own group"],
		[defaultRowNote("auto"), "Applies the next time a document's address can't be looked up."],
		[
			defaultRowNote("manual"),
			"New lines get this group. Saved drafts keep the group already on their lines.",
		],
		[
			noDefaultWarning("auto", 0.065),
			"No fallback group. If an address can't be looked up, documents use your organization rate of 6.5% and are flagged for review.",
		],
		[
			noDefaultWarning("auto", 0),
			"No fallback group. If an address can't be looked up, documents get no tax and are flagged for review.",
		],
		[
			noDefaultWarning("manual", 0.065),
			"No default group. Lines with no group, on clients with no group, aren't taxed.",
		],
		[
			noDefaultWarning("manual", 0),
			"No default group. Lines with no group, on clients with no group, aren't taxed.",
		],
		[
			deactivateDefaultWarning("auto", 0.065),
			"This is your fallback group. After deactivating, documents whose address can't be looked up use your organization rate of 6.5% and are flagged for review.",
		],
		[
			deactivateDefaultWarning("auto", 0),
			"This is your fallback group. After deactivating, documents whose address can't be looked up get no tax and are flagged for review.",
		],
		[
			deactivateDefaultWarning("manual", 0),
			"This is your default group. After deactivating, lines with no group, on clients with no group, aren't taxed.",
		],
		[defaultChipLabel("auto"), "Fallback"],
		[defaultChipLabel("manual"), "Default"],
		[defaultCheckboxLabel("auto"), "Use as fallback group"],
		[defaultCheckboxLabel("manual"), "Set as default group"],
		[
			groupsExplainer("auto"),
			"Picked on a line or a client. Everything else uses the address rate.",
		],
		[
			groupsExplainer("manual"),
			"Picked on a line or a client. Otherwise the default group is filled in.",
		],
		[RATES_EXPLAINER, "Rates are parts of groups. Editing a rate changes every group that uses it."],
	])("copy %#", (actual, expected) => {
		expect(actual).toBe(expected);
	});

	it("formats a two-decimal org rate", () => {
		expect(noDefaultWarning("auto", 0.0825)).toContain("8.25%");
	});

	it("never treats an inactive group as the default", () => {
		expect(activeDefaultGroup([group({ is_default: true, is_active: false })])).toBeNull();
	});

	it("finds the active default in a mixed list", () => {
		const stale = group({ id: "stale", is_default: true, is_active: false });
		const plain = group({ id: "plain" });
		const def = group({ id: "def", is_default: true });
		expect(activeDefaultGroup([stale, plain, def])?.id).toBe("def");
	});

	it("flags rates no active group uses", () => {
		const outside = ratesOutsideActiveGroups([
			group({ id: "a", rateIds: ["in"] }),
			group({ id: "b", is_active: false, rateIds: ["inactiveOnly"] }),
		]);
		expect(outside("in")).toBe(false);
		expect(outside("inactiveOnly")).toBe(true);
		expect(outside("nowhere")).toBe(true);
	});
});
