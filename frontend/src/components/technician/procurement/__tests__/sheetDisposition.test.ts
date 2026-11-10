/**
 * The sheet's one stock & billing answer: lines follow it unless set on their own,
 * and reopening a sheet reads the answer back off the per-line values.
 */
import { describe, expect, test } from "vitest";
import {
	applySheetDisposition,
	blankLine,
	isNegativeLine,
	seedSheet,
	startingSheetDisposition,
	type LineDraft,
	type SheetDisposition,
} from "../lineDrafts";
import { dispositionSentence } from "../../../fieldPurchases/dispositionSummary";

const line = (over: Partial<LineDraft> = {}): LineDraft => ({
	...blankLine("a"),
	description: "Part",
	unit_price: "10",
	...over,
});
const ON_JOB: SheetDisposition = { disposition: "non_stock", vehicleId: "" };
const TO_TRUCK: SheetDisposition = { disposition: "receive", vehicleId: "veh-1" };

describe("applySheetDisposition", () => {
	test("moves following lines and leaves pinned ones", () => {
		const out = applySheetDisposition(
			[
				line(),
				line({ disposition: "receive", disposition_vehicle_id: "", dispositionPinned: true }),
			],
			TO_TRUCK
		);
		expect(out[0]).toMatchObject({ disposition: "receive", disposition_vehicle_id: "veh-1" });
		expect(out[1]).toMatchObject({
			disposition: "receive",
			disposition_vehicle_id: "",
			dispositionPinned: true,
		});
	});

	test("lets a pinned line go once it says what the sheet says", () => {
		const out = applySheetDisposition(
			[line({ dispositionPinned: true })],
			ON_JOB
		);
		expect(out[0]!.dispositionPinned).toBe(false);
	});

	test("a stock answer passes discount lines by", () => {
		const out = applySheetDisposition([line({ unit_price: "-5" })], TO_TRUCK);
		expect(out[0]).toMatchObject({ disposition: "non_stock", disposition_vehicle_id: "" });
		expect(out[0]!.dispositionPinned).toBe(false);
	});

	test("returns the same array when nothing changed", () => {
		const lines = [line()];
		expect(applySheetDisposition(lines, ON_JOB)).toBe(lines);
	});

	test("clears the vehicle when the answer is the job", () => {
		const out = applySheetDisposition(
			[line({ disposition: "receive", disposition_vehicle_id: "veh-1" })],
			ON_JOB
		);
		expect(out[0]).toMatchObject({ disposition: "non_stock", disposition_vehicle_id: "" });
	});
});

describe("seedSheet", () => {
	test("all alike: that is the answer and nothing is pinned", () => {
		const { lines, def } = seedSheet([
			line({ disposition: "receive", disposition_vehicle_id: "veh-1" }),
			line({ disposition: "receive", disposition_vehicle_id: "veh-1" }),
		]);
		expect(def).toEqual(TO_TRUCK);
		expect(lines.every((l) => !l.dispositionPinned)).toBe(true);
	});

	test("mixed: the majority wins and the rest come back pinned", () => {
		const { lines, def } = seedSheet([
			line({ disposition: "receive", disposition_vehicle_id: "veh-1" }),
			line({ disposition: "receive", disposition_vehicle_id: "veh-1" }),
			line(),
		]);
		expect(def).toEqual(TO_TRUCK);
		expect(lines.map((l) => l.dispositionPinned)).toEqual([false, false, true]);
	});

	test("a tie goes to the job", () => {
		const { def } = seedSheet([
			line({ disposition: "receive", disposition_vehicle_id: "veh-1" }),
			line(),
		]);
		expect(def).toEqual(ON_JOB);
	});

	test("discount lines and unanswered lines do not vote", () => {
		const { lines, def } = seedSheet([
			line({ disposition: "receive", disposition_vehicle_id: "" }),
			line({ unit_price: "-5" }),
			line({ disposition: "" }),
		]);
		expect(def).toEqual({ disposition: "receive", vehicleId: "" });
		// The discount follows (it is exempt, not different); the blank one differs.
		expect(lines.map((l) => l.dispositionPinned)).toEqual([false, false, true]);
	});

	test("nothing to vote: no answer", () => {
		expect(seedSheet([line({ disposition: "" })]).def).toBeNull();
		expect(seedSheet([]).def).toBeNull();
	});
});

describe("startingSheetDisposition", () => {
	test("a job: consumed on it", () => {
		expect(startingSheetDisposition(true, "veh-1")).toEqual(ON_JOB);
	});
	test("no job: stock, onto the truck where there is one", () => {
		expect(startingSheetDisposition(false, "veh-1")).toEqual(TO_TRUCK);
		expect(startingSheetDisposition(false, null)).toEqual({
			disposition: "receive",
			vehicleId: "",
		});
	});
});

test("isNegativeLine", () => {
	expect(isNegativeLine(line({ unit_price: "-1" }))).toBe(true);
	expect(isNegativeLine(line({ quantity: "-1" }))).toBe(true);
	expect(isNegativeLine(line())).toBe(false);
	expect(isNegativeLine(line({ unit_price: "" }))).toBe(false);
});

describe("dispositionSentence", () => {
	test("one answer for every line", () => {
		expect(
			dispositionSentence([
				{ disposition: "non_stock", vehicleName: null },
				{ disposition: "non_stock", vehicleName: null },
			])
		).toBe("All 2 items consumed on job");
	});
	test("groups, largest first", () => {
		expect(
			dispositionSentence([
				{ disposition: "receive", vehicleName: "Truck 12" },
				{ disposition: "non_stock", vehicleName: null },
				{ disposition: "receive", vehicleName: "Truck 12" },
				{ disposition: null, vehicleName: null },
			])
		).toBe("2 added to Truck 12 · 1 consumed on job · 1 not recorded");
	});
	test("warehouse and empty", () => {
		expect(dispositionSentence([{ disposition: "receive", vehicleName: null }])).toBe(
			"1 item added to Warehouse"
		);
		expect(dispositionSentence([])).toBeNull();
	});
});
