/**
 * Stock moves in exactly two places: visit completion
 * (deductInventoryForVisit) and the technician parts-used / vehicle-stock
 * paths. Linking a quote, job, plan or invoice line is REFERENCE ONLY.
 *
 * Now those tables carry inventory_item_id, "the line knows which item it
 * is, so deduct it" is a natural-looking one-line addition — and an invoice
 * raised from a completed visit would deduct a second time.
 *
 * A source scan because the failure mode is someone ADDING a call; no input
 * to today's code makes tomorrow's mistake appear.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "..", "..");

/** Relative to backend/src. */
const REFERENCE_ONLY = [
	"controllers/quotesController.ts",
	"controllers/jobsController.ts",
	"controllers/invoicesController.ts",
	"controllers/recurringPlansController.ts",
	"services/invoiceService.ts",
];

const LEDGER_SYMBOLS = [
	"recordMovements",
	"deductInventoryForVisit",
	"stock_movement.create",
	"stock_movement.createMany",
];

describe("stock movement invariant", () => {
	it.each(REFERENCE_ONLY)("%s never touches the stock ledger", (relative) => {
		const source = readFileSync(resolve(src, relative), "utf8");
		const offenders = LEDGER_SYMBOLS.filter((symbol) => source.includes(symbol));
		expect(offenders).toEqual([]);
	});

	it("visit completion is still the path that does deduct", () => {
		const source = readFileSync(
			resolve(src, "controllers/jobVisitsController.ts"),
			"utf8",
		);
		expect(source).toContain("deductInventoryForVisit");
	});
});
