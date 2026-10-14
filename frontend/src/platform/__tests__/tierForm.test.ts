import { describe, expect, it } from "vitest";
import { fromDraft, sameContents, toDraft } from "../tierForm";

const base = {
	modules: ["quickbooks"],
	limits: {
		dispatchers: 10,
		technicians: null,
		ai_calls_month: 500,
		tax_lookups_month: 0,
		receipt_scans_month: 300,
	},
};

describe("tier form draft", () => {
	it("starts from the given contents; unlimited shows blank", () => {
		const d = toDraft(base);
		expect([...d.modules]).toEqual(["quickbooks"]);
		expect(d.limits).toEqual({
			dispatchers: "10",
			technicians: "",
			ai_calls_month: "500",
			tax_lookups_month: "0",
			receipt_scans_month: "300",
		});
	});
	it("reads blank as unlimited and rejects non-whole numbers", () => {
		const d = toDraft(base);
		expect(fromDraft(d).contents).toEqual({ ...base, modules: ["quickbooks"] });
		expect(
			fromDraft({ ...d, limits: { ...d.limits, dispatchers: "2.5" } }).error
		).toMatch(/whole number/);
		expect(
			fromDraft({ ...d, limits: { ...d.limits, dispatchers: "-1" } }).error
		).toMatch(/whole number/);
	});
	it("detects an unchanged draft", () => {
		const d = toDraft(base);
		expect(sameContents(base, fromDraft(d).contents)).toBe(true);
		d.modules.add("ai_assistant");
		expect(sameContents(base, fromDraft(d).contents)).toBe(false);
	});
});
