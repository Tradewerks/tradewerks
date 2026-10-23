import { describe, it, expect } from "vitest";
import {
	buildRateChangeNotice,
	describeJurisdictionChange,
	formatRatePercent,
	type RateChange,
} from "../tax/rateChange.js";
import type { RateSetView } from "../tax/rateSet.js";

const set = (id: string, parts: [string, string, number][]): RateSetView => ({
	id,
	state_code: "WI",
	total_rate: parts.reduce((s, [, , r]) => s + r, 0),
	components: parts.map(([type, name, rate], i) => ({
		id: `${id}-${i}`,
		jurisdiction_type: type as RateSetView["components"][number]["jurisdiction_type"],
		jurisdiction_name: name,
		jurisdiction_code: null,
		rate,
	})),
});
const OLD = set("old", [["state", "WI", 0.05], ["county", "DANE", 0.005]]);
const NEW = set("new", [["state", "WI", 0.05], ["county", "DANE", 0.006]]);

describe("formatRatePercent", () => {
	it.each([
		[0.0825, "8.25%"],
		[0.055, "5.5%"],
		[0.00125, "0.125%"],
		[0, "0%"],
	])("%s → %s", (rate, want) => expect(formatRatePercent(rate)).toBe(want));
});

describe("describeJurisdictionChange", () => {
	it("names the jurisdiction whose rate moved, keeping the state code as-is", () => {
		expect(describeJurisdictionChange(OLD, NEW)).toBe("Dane County 0.5% → 0.6%");
	});

	it("reports added and removed jurisdictions", () => {
		const withCity = set("c", [["state", "WI", 0.05], ["city", "MADISON", 0.001]]);
		expect(describeJurisdictionChange(OLD, withCity)).toBe("Madison added at 0.1%, Dane County removed");
	});

	it("falls back when only names or codes differ", () => {
		const renamed = set("r", [["state", "WI", 0.05], ["county", "DANE", 0.005]]);
		expect(describeJurisdictionChange(OLD, renamed)).toBe("jurisdiction details changed");
	});
});

describe("buildRateChangeNotice", () => {
	const ch = (model: RateChange["model"], from = OLD, to = NEW): RateChange => ({ model, from, to });

	it("one draft", () => {
		expect(buildRateChangeNotice([ch("quote")])).toEqual({
			title: "Tax rate changed on 1 draft",
			body: "1 draft 5.5% → 5.6% (Dane County 0.5% → 0.6%)",
			actionUrl: "/dispatch/quotes?status=Draft",
		});
	});

	it("groups drafts by rate pair, largest first, and links to the type with most drafts", () => {
		const other = set("o", [["state", "WI", 0.05], ["county", "ROCK", 0.005]]);
		const other2 = set("o2", [["state", "WI", 0.05], ["county", "ROCK", 0.0055]]);
		const n = buildRateChangeNotice([ch("quote"), ch("invoice", other, other2), ch("invoice", other, other2)]);
		expect(n.title).toBe("Tax rate changed on 3 drafts");
		expect(n.body).toBe(
			"2 drafts 5.5% → 5.55% (Rock County 0.5% → 0.55%); 1 draft 5.5% → 5.6% (Dane County 0.5% → 0.6%)",
		);
		expect(n.actionUrl).toBe("/dispatch/invoices?status=Draft");
	});

	it("caps the body at three rate pairs", () => {
		const pairs = [1, 2, 3, 4].map((i) =>
			ch("job", set(`f${i}`, [["county", `C${i}`, 0.001]]), set(`t${i}`, [["county", `C${i}`, 0.002]])),
		);
		const n = buildRateChangeNotice(pairs);
		expect(n.body.endsWith("; and 1 more rate change")).toBe(true);
		expect(n.actionUrl).toBe("/dispatch/jobs");
	});
});
