import { describe, test, expect } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
	getStockStatus,
	withStockStatus,
	unitBasis,
	mergeUnitBases,
	CONSUMPTION_MOVEMENT_PREDICATE,
	CONSUMPTION_SIGNED_QTY,
} from "../inventory.js";

const dec = (v: string | number) => new Prisma.Decimal(v);

// inventory_item.quantity and low_stock_threshold are numeric(10,2), so Prisma
// hands these in as Decimal objects, not numbers. Comparing a Decimal with `===`
// or `<` does NOT do what it looks like: `===` is object identity, and `<` coerces
// via valueOf() to a STRING, so "9" < "10" is false. Both failures are silent —
// no throw, no type error at the call site — which is why every case below is
// pinned with values whose lexicographic order differs from their numeric order.
describe("getStockStatus with Decimal inputs", () => {
	test("reports low when a Decimal quantity is under a Decimal threshold", () => {
		expect(getStockStatus(dec(9), dec(10))).toBe("low");
	});

	test("reports out_of_stock for a Decimal zero quantity", () => {
		expect(getStockStatus(dec(0), dec(5))).toBe("out_of_stock");
	});

	test("reports sufficient when a Decimal quantity is over a Decimal threshold", () => {
		expect(getStockStatus(dec(100), dec(20))).toBe("sufficient");
	});

	test("treats a Decimal quantity equal to its threshold as sufficient", () => {
		expect(getStockStatus(dec(5), dec(5))).toBe("sufficient");
	});

	test("reports low for a fractional Decimal quantity under its threshold", () => {
		expect(getStockStatus(dec("0.50"), dec("2.00"))).toBe("low");
	});

	test("reports sufficient for a fractional Decimal quantity over its threshold", () => {
		expect(getStockStatus(dec("12.50"), dec("2.00"))).toBe("sufficient");
	});

	test("returns null when the threshold is null, whatever the quantity type", () => {
		expect(getStockStatus(dec(9), null)).toBeNull();
	});
});

describe("getStockStatus with number inputs (regression)", () => {
	test("still reports low below the threshold", () => {
		expect(getStockStatus(9, 10)).toBe("low");
	});

	test("still reports out_of_stock at zero", () => {
		expect(getStockStatus(0, 5)).toBe("out_of_stock");
	});

	test("still reports sufficient above the threshold", () => {
		expect(getStockStatus(100, 20)).toBe("sufficient");
	});

	test("still returns null with no threshold", () => {
		expect(getStockStatus(9, null)).toBeNull();
	});
});

// withStockStatus is the serialization boundary for the two quantity columns.
// Decimal(10,2) columns serialize as strings, but clients declare `number`, so
// these assert the converted type rather than the raw Prisma value.
describe("withStockStatus", () => {
	test("derives the status from Decimal fields and preserves the rest of the row", () => {
		const row = { id: "abc", quantity: dec(9), low_stock_threshold: dec(10) };
		expect(withStockStatus(row)).toEqual({
			id: "abc",
			quantity: 9,
			low_stock_threshold: 10,
			stock_status: "low",
		});
	});

	test("converts Decimal quantities to numbers so they serialize as numbers", () => {
		const row = { quantity: dec("12.50"), low_stock_threshold: null };
		const result = withStockStatus(row);
		expect(result.quantity).toBe(12.5);
		expect(typeof result.quantity).toBe("number");
		expect(result.stock_status).toBeNull();
	});

	test("keeps a null threshold null rather than turning it into 0", () => {
		const result = withStockStatus({ quantity: dec(3), low_stock_threshold: null });
		expect(result.low_stock_threshold).toBeNull();
	});

	test("survives a JSON round trip as numbers", () => {
		const parsed = JSON.parse(
			JSON.stringify(withStockStatus({ quantity: dec("12.50"), low_stock_threshold: dec(15) })),
		);
		expect(parsed.quantity).toBe(12.5);
		expect(parsed.low_stock_threshold).toBe(15);
	});

	test("leaves an already-numeric row alone", () => {
		const result = withStockStatus({ quantity: 9, low_stock_threshold: 10 });
		expect(result.quantity).toBe(9);
		expect(result.stock_status).toBe("low");
	});
});

// A movement's unit is STAMPED, so the basis is only ever derived from the rows that
// fed an aggregate. These cases pin the two ways a caller hands them over — a
// Postgres text[] from array_agg (null when the aggregate matched nothing) and the
// per-row unit values off a findMany — plus the two states that must NOT read as a
// unit break, because either one would flag a clean series.
describe("unitBasis", () => {
	test("one distinct unit is a single basis, not a mixed one", () => {
		expect(unitBasis(["each", "each", "each"])).toEqual({
			units: ["each"],
			unit: "each",
			mixed: false,
		});
	});

	test("two distinct units withhold the unit and flag the basis", () => {
		expect(unitBasis(["each", "box", "each"])).toEqual({
			units: ["box", "each"],
			unit: null,
			mixed: true,
		});
	});

	test("no rows is not a unit break — array_agg returns null over an empty match", () => {
		expect(unitBasis(null)).toEqual({ units: [], unit: null, mixed: false });
		expect(unitBasis([])).toEqual({ units: [], unit: null, mixed: false });
	});

	test("blanks are missing information, not a second denomination", () => {
		expect(unitBasis(["each", "", null, undefined, "  "])).toEqual({
			units: ["each"],
			unit: "each",
			mixed: false,
		});
	});

	// inventory_item.unit was freetext before the catalog, and the 20260805
	// migration backfilled stock_movement.unit verbatim — so "Each" next to "each"
	// (or "gallon" next to "gal") is one denomination spelled two ways, not a unit
	// change. Treating it as mixed withheld every total on a perfectly summable item.
	test("collapses catalog aliases and casing to one basis instead of flagging a unit break", () => {
		expect(unitBasis(["Each", "each", "EACH "])).toEqual({ units: ["each"], unit: "each", mixed: false });
		expect(unitBasis(["gallon", "gal", "Gallons"])).toEqual({ units: ["gal"], unit: "gal", mixed: false });
	});

	test("reports the canonical code, so a legacy spelling can't leak into a display label", () => {
		expect(unitBasis(["feet"]).unit).toBe("ft");
	});

	test("still flags two different real units even when both are legacy spellings", () => {
		expect(unitBasis(["Each", "gallon"])).toEqual({ units: ["each", "gal"], unit: null, mixed: true });
	});

	test("keeps a spelling the catalog does not know, as its own distinct unit", () => {
		expect(unitBasis(["widgets", "each"])).toEqual({
			units: ["each", "widgets"],
			unit: null,
			mixed: true,
		});
	});

	test("merges page-level bases so one column can flag what its rows cannot", () => {
		const perRow = [unitBasis(["each"]), unitBasis(["box"]), unitBasis(["each"])];
		expect(perRow.every((b) => !b.mixed)).toBe(true);
		expect(mergeUnitBases(perRow)).toEqual({ units: ["box", "each"], unit: null, mixed: true });
	});
});

// The one definition of "consumption" shared by every aggregate over the ledger.
// Asserted as text because callers splice it into $queryRaw templates — a typo
// here would silently change every report at once.
describe("CONSUMPTION_MOVEMENT_PREDICATE / CONSUMPTION_SIGNED_QTY", () => {
	const flat = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, " ").trim();

	test("selects parts_used + direct_consumption, consumed-sourced reversals and consumed field purchases, on alias sm", () => {
		expect(flat(CONSUMPTION_MOVEMENT_PREDICATE)).toBe(
			"( sm.reason IN ('parts_used', 'direct_consumption') OR (sm.reason = 'reversal' AND sm.from_location_type = 'consumed') OR (sm.reason = 'supplier_purchase' AND sm.to_location_type = 'consumed') )",
		);
		expect(CONSUMPTION_MOVEMENT_PREDICATE.values).toEqual([]);
	});

	// A supplier_purchase that stocks a warehouse or vehicle is a receipt, not
	// consumption — only the to_location_type = 'consumed' shape is demand.
	test("matches a consumed field purchase but not one that stocks a location", () => {
		const sql = flat(CONSUMPTION_MOVEMENT_PREDICATE);
		expect(sql).toContain("sm.reason = 'supplier_purchase' AND sm.to_location_type = 'consumed'");
		expect(sql).not.toContain("sm.reason IN ('parts_used', 'direct_consumption', 'supplier_purchase')");
	});

	test("signs reversals negative so SUM() nets them", () => {
		expect(flat(CONSUMPTION_SIGNED_QTY)).toBe(
			"CASE WHEN sm.reason = 'reversal' THEN -sm.qty ELSE sm.qty END",
		);
	});

	test("embeds into a $queryRaw template as SQL text, not a bound parameter", () => {
		const q = Prisma.sql`SELECT SUM(${CONSUMPTION_SIGNED_QTY}) FROM stock_movement sm WHERE ${CONSUMPTION_MOVEMENT_PREDICATE} AND sm.inventory_item_id = ${"item-1"}`;
		expect(flat(q)).toContain("SUM(CASE WHEN sm.reason = 'reversal' THEN -sm.qty ELSE sm.qty END)");
		expect(flat(q)).toContain("WHERE ( sm.reason IN");
		expect(q.values).toEqual(["item-1"]);
	});
});
