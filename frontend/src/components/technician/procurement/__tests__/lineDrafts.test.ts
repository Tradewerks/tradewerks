/**
 * Draft identity: these keys are what keeps a row's DOM node - and so its focus,
 * selection and IME state - attached to its line across deletes and OCR re-seeds.
 */
import { describe, expect, test } from "vitest";
import {
	blankLine,
	clampDestinations,
	draftsFromOcr,
	pendingOcrLines,
	toDrafts,
	type ExtractedReceiptLine,
} from "../lineDrafts";
import type { FieldPurchase } from "../../../../types/fieldPurchases";

function serverLine(over: Record<string, unknown> = {}) {
	return {
		id: "line-a",
		description: "Contactor 40A",
		quantity: "1.00",
		unit_price: "80.00",
		line_total: "80.00",
		inventory_item_id: null,
		inventory_item: null,
		disposition: "non_stock",
		disposition_location: null,
		disposition_vehicle_id: null,
		verified_at: null,
		ocr_confidence: null,
		sort_order: 0,
		...over,
	};
}

const purchaseWith = (lines: unknown[]) => ({ lines }) as unknown as FieldPurchase;

describe("blankLine", () => {
	test("gives every added line an identity of its own", () => {
		const a = blankLine();
		const b = blankLine();

		expect(a.key).toBeTruthy();
		expect(b.key).toBeTruthy();
		expect(a.key).not.toBe(b.key);
	});
});

describe("toDrafts", () => {
	test("keys off the server line, so a re-seed does not re-key an unchanged row", () => {
		const purchase = purchaseWith([
			serverLine({ id: "line-a" }),
			serverLine({ id: "line-b", description: "Capacitor 45/5" }),
		]);

		// The detail query polls every few seconds while OCR runs, and each poll
		// re-seeds this list. Unstable keys here would make the bleed worse than
		// the index keys they replaced.
		const first = toDrafts(purchase);
		const second = toDrafts(purchase);

		expect(first.map((d) => d.key)).toEqual(["line-a", "line-b"]);
		expect(second.map((d) => d.key)).toEqual(first.map((d) => d.key));
	});

	test("a machine-read line starts unconfirmed; one already verified stays confirmed", () => {
		const drafts = toDrafts(
			purchaseWith([
				serverLine({ id: "read", ocr_confidence: "0.42" }),
				serverLine({
					id: "signed",
					ocr_confidence: "0.42",
					verified_at: "2026-08-21T15:04:00.000Z",
				}),
				serverLine({ id: "typed" }),
			]),
		);

		expect(drafts[0]!.acknowledged).toBe(false);
		expect(drafts[1]!.acknowledged).toBe(true);
		// Typed by hand: re-confirming your own typing is ceremony.
		expect(drafts[2]!.acknowledged).toBe(true);
	});
});

/**
 * The line race: extraction lands while the technician is typing at the counter.
 * The server refuses to overwrite what they typed, so the reading it stood down
 * for is offered here instead of being thrown away.
 */
describe("pendingOcrLines", () => {
	const extracted = (over: Partial<ExtractedReceiptLine> = {}): ExtractedReceiptLine => ({
		description: "Capacitor 45/5",
		quantity: 1,
		unit_price: 24.99,
		line_total: 24.99,
		confidence: 0.93,
		applied: false,
		...over,
	});

	test("offers nothing the server already wrote onto the purchase", () => {
		expect(pendingOcrLines([extracted({ applied: true })], [])).toEqual([]);
	});

	test("offers a line the technician's own typing kept off the purchase", () => {
		const typed = { ...blankLine(), description: "Fan belt" };
		expect(pendingOcrLines([extracted()], [typed])).toHaveLength(1);
	});

	/**
	 * Otherwise every re-render after seeding offers the same lines again. Matched
	 * on description because a seeded draft has no id to match on until submit;
	 * editing the description re-offers it, which is the safe direction to fail.
	 */
	test("stops offering a line once it is on the sheet", () => {
		const seeded = draftsFromOcr([extracted()]);
		expect(pendingOcrLines([extracted()], seeded)).toEqual([]);
	});

	/**
	 * A receipt genuinely repeats a description - the same part bought twice, two
	 * boxes of wire nuts at different prices. Suppressing by "is this description
	 * on the sheet at all" loses the second one the moment the first is present,
	 * which is the exact discard this whole affordance exists to prevent.
	 */
	test("counts repeats rather than treating a description as seen or unseen", () => {
		const twice = [extracted(), extracted()];
		expect(pendingOcrLines(twice, draftsFromOcr(twice))).toEqual([]);
		// One deleted off the sheet leaves one still owed.
		expect(pendingOcrLines(twice, draftsFromOcr([extracted()]))).toHaveLength(1);
		expect(pendingOcrLines(twice, [])).toHaveLength(2);
	});

	test("ignores case and stray spacing, which is where OCR text differs", () => {
		const seeded = [{ ...blankLine(), description: "  capacitor   45/5 ", ocrConfidence: 0.9 }];
		expect(pendingOcrLines([extracted()], seeded)).toEqual([]);
	});

	test("offers nothing when a reopened purchase already carries the read lines", () => {
		// The round trip a queried purchase makes: OCR read the lines, the submit
		// saved them, the reopen loaded them back. Their confidence has to survive
		// that or the sheet cannot tell them from lines somebody typed.
		const read = extracted();
		const reloaded = toDrafts(
			purchaseWith([
				serverLine({ id: "saved", description: read.description, ocr_confidence: "0.91" }),
			]),
		);
		expect(pendingOcrLines([read], reloaded)).toEqual([]);
	});
});

describe("draftsFromOcr", () => {
	const line: ExtractedReceiptLine = {
		description: "Capacitor 45/5",
		quantity: 2,
		unit_price: 24.99,
		line_total: 49.98,
		confidence: null,
		applied: false,
	};

	test("arrives unconfirmed however the provider scored it", () => {
		// A provider that reports no score at all must not
		// produce a line that reads as the technician's own already-checked typing.
		expect(draftsFromOcr([line])[0]).toMatchObject({
			acknowledged: false,
			description: "Capacitor 45/5",
			quantity: "2",
			unit_price: "24.99",
		});
	});

	test("lands on the job the sheet is already showing", () => {
		expect(draftsFromOcr([line], "alloc-a")[0]!.allocationKey).toBe("alloc-a");
	});

	test("keys each line on its own, so seeding twice cannot collide", () => {
		const [a] = draftsFromOcr([line]);
		const [b] = draftsFromOcr([line]);
		expect(a!.key).not.toBe(b!.key);
	});
});

/**
 * A destination the technician can no longer stock reaches the sheet from a draft
 * saved off another truck. The control offers two answers, so a third would render
 * as nothing selected and fail on submit.
 */
describe("clamping a stale destination", () => {
	const stocked = (vehicle: string) => ({
		...blankLine(),
		disposition: "receive" as const,
		disposition_vehicle_id: vehicle,
	});

	test("rewrites another truck to the technician's own", () => {
		const [line] = clampDestinations([stocked("veh-other")], "veh-mine");
		expect(line!.disposition_vehicle_id).toBe("veh-mine");
	});

	test("sends it to the warehouse when they are signed onto no truck", () => {
		const [line] = clampDestinations([stocked("veh-other")], null);
		expect(line!.disposition_vehicle_id).toBe("");
	});

	test("leaves the warehouse alone", () => {
		const [line] = clampDestinations([stocked("")], "veh-mine");
		expect(line!.disposition_vehicle_id).toBe("");
	});

	// Identity is what stops the clamping effect re-setting state every render.
	test("returns the same array when nothing needed rewriting", () => {
		const drafts = [stocked("veh-mine"), stocked("")];
		expect(clampDestinations(drafts, "veh-mine")).toBe(drafts);
	});
});
