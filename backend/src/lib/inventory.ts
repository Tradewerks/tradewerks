import { Prisma } from "../../generated/prisma/client.js";
import { normalizeUnitCode } from "./units.js";

export type StockStatus = "sufficient" | "low" | "out_of_stock" | null;

/** Accepts the singleton client and a transaction client alike. */
interface InventoryItemReader {
	inventory_item: {
		findMany(args: {
			where: { id: { in: string[] }; organization_id: string };
			select: { id: true };
		}): Promise<{ id: string }[]>;
	};
}

/**
 * Inventory item ids not in this org. Zod can only prove the id is a UUID;
 * without this a crafted payload links one tenant's line to another
 * tenant's catalog item, leaking its name and cost back through detail
 * reads. Returns rather than throws so callers keep their own error shape.
 */
export async function findForeignInventoryItemIds(
	client: InventoryItemReader,
	organizationId: string,
	ids: readonly (string | null | undefined)[],
): Promise<string[]> {
	const wanted = [...new Set(ids.filter((id): id is string => !!id))];
	if (wanted.length === 0) return [];
	const found = await client.inventory_item.findMany({
		where: { id: { in: wanted }, organization_id: organizationId },
		select: { id: true },
	});
	const ok = new Set(found.map((i) => i.id));
	return wanted.filter((id) => !ok.has(id));
}

/**
 * Vehicle ids not in this org. A `receive` pointed at another tenant's van
 * would deposit our stock onto their truck.
 */
export async function foreignDispositionVehicleIds(
	client: { vehicle: { findMany(args: unknown): Promise<{ id: string }[]> } },
	organizationId: string,
	ids: readonly (string | null | undefined)[],
): Promise<string[]> {
	const wanted = [...new Set(ids.filter((id): id is string => !!id))];
	if (wanted.length === 0) return [];
	const found = await client.vehicle.findMany({
		where: { id: { in: wanted }, organization_id: organizationId },
		select: { id: true },
	});
	const ok = new Set(found.map((v) => v.id));
	return wanted.filter((id) => !ok.has(id));
}

/**
 * Avoids the words "not found": every route file maps that substring to a
 * 404, and a bad id in a payload is a bad request.
 */
export function unknownInventoryItemsMessage(ids: readonly string[]): string {
	return `Validation failed: unknown inventory item ${ids.join(", ")}`;
}

/** Throwing form of {@link findForeignInventoryItemIds}. */
export async function assertInventoryItemsInOrg(
	client: InventoryItemReader,
	organizationId: string,
	ids: readonly (string | null | undefined)[],
): Promise<void> {
	const foreign = await findForeignInventoryItemIds(client, organizationId, ids);
	if (foreign.length > 0) {
		throw new Error(unknownInventoryItemsMessage(foreign));
	}
}

/** Throwing form of {@link foreignDispositionVehicleIds}. */
export async function assertDispositionVehiclesInOrg(
	client: { vehicle: { findMany(args: unknown): Promise<{ id: string }[]> } },
	organizationId: string,
	ids: readonly (string | null | undefined)[],
): Promise<void> {
	const foreign = await foreignDispositionVehicleIds(client, organizationId, ids);
	if (foreign.length > 0) {
		throw new Error(`Validation failed: unknown vehicle ${foreign.join(", ")}`);
	}
}

/**
 * Lifecycle columns for a visit line, derived from its catalog link. A
 * freetext line gets NULLs so it stays outside the fulfillment lifecycle
 * rather than sitting in it permanently unreconcilable. Shared by dispatch
 * entry and plan generation, so both land in the same state.
 */
export function plannedLineItemFields(
	inventoryItemId: string | null | undefined,
	quantity: number,
	disposition?: LineDispositionInput,
) {
	if (!inventoryItemId) {
		return {
			inventory_item_id: null,
			fulfillment_status: null,
			qty_planned: null,
			...NO_DISPOSITION,
		} as const;
	}
	return {
		inventory_item_id: inventoryItemId,
		fulfillment_status: "planned" as const,
		qty_planned: quantity,
		...dispositionFields(disposition),
	};
}

/**
 * Stock intent for a recurring-plan line, which is only ever copied into a
 * generated visit. Dropping the part has to clear the intent with it.
 */
export function templateDispositionFields(
	inventoryItemId: string | null | undefined,
	disposition?: LineDispositionInput,
) {
	return inventoryItemId ? dispositionFields(disposition) : NO_DISPOSITION;
}

/**
 * Loose on purpose: satisfied by a validated request body and by a
 * recurring_plan_line_item row read straight from the database, which is
 * what lets a generated visit inherit its template's intent untranslated.
 */
export interface LineDispositionInput {
	disposition?: LineDisposition | null;
	disposition_location?: StockLocation | null;
	disposition_vehicle_id?: string | null;
}

type LineDisposition = "consume" | "receive" | "non_stock";
type StockLocation = "warehouse" | "vehicle" | "consumed" | "adjustment" | "external";

const NO_DISPOSITION = {
	disposition: null,
	disposition_location: null,
	disposition_vehicle_id: null,
} as const;

/**
 * Stock intent for a line that HAS a catalog link.
 *
 * A destination only means something for `receive`; carrying one elsewhere
 * leaves a stale vehicle behind after a change. Absent intent stays NULL
 * rather than defaulting to `consume` — NULL is what every pre-2026-08-20
 * row holds and the completion path reads the two identically.
 */
export function dispositionFields(input?: LineDispositionInput) {
	const disposition = input?.disposition ?? null;
	if (disposition !== "receive") {
		return { ...NO_DISPOSITION, disposition };
	}
	const vehicleId = input?.disposition_vehicle_id ?? null;
	return {
		disposition,
		disposition_location: (vehicleId ? "vehicle" : "warehouse") as StockLocation,
		disposition_vehicle_id: vehicleId,
	};
}

/**
 * Visit lines meaning "this part must be on the van tomorrow". Shared by
 * readiness and tomorrow-requirements so the two cannot drift apart again.
 * `receive` brings stock in and `non_stock` never enters inventory, so neither
 * is something to load; NULL spells `consume`.
 */
export const READINESS_LINE_ITEM_WHERE = {
	inventory_item_id: { not: null },
	fulfillment_status: { not: "voided" },
	OR: [{ disposition: null }, { disposition: "consume" }],
} satisfies Prisma.job_visit_line_itemWhereInput;

/**
 * A stock quantity as it can arrive here: a plain number from a validated request
 * body, or a Prisma `Decimal` read out of a `numeric(10,2)` column.
 *
 * Both shapes are accepted rather than forcing callers to convert, because the
 * conversion is exactly what kept getting forgotten. Comparing a `Decimal` with
 * `===` or `<` compiles, runs, and is wrong: `===` tests object identity, and the
 * relational operators coerce through `valueOf()` to a STRING, so `"9" < "10"` is
 * false and `"100" < "20"` is true. Nothing throws. Before `inventory_item.quantity`
 * became `numeric(10,2)` these fields were `Int`, so the old `number` signature was
 * safe; the moment they widened, every comparison in here became a silent
 * misordering — a low item reporting `sufficient` (missed reorder) or a full one
 * reporting `low` (false alert). See lib/__tests__/inventory.test.ts.
 */
export type StockQty = number | Prisma.Decimal;

/** Numeric value of a quantity, whichever shape it arrived in. */
function toNumber(v: StockQty): number {
	return typeof v === "number" ? v : v.toNumber();
}

export function getStockStatus(quantity: StockQty, threshold: StockQty | null): StockStatus {
	if (threshold === null) return null;
	const qty = toNumber(quantity);
	if (qty === 0) return "out_of_stock";
	if (qty < toNumber(threshold)) return "low";
	return "sufficient";
}

/**
 * Adds `stock_status` to an item row and NORMALIZES its two quantity columns to
 * plain numbers.
 *
 * The normalization is not incidental: every caller hands the result straight to
 * an API response, so this is the serialization boundary for `quantity` and
 * `low_stock_threshold` whether it wants to be or not. Both are `numeric(10,2)`,
 * which Prisma returns as a `Decimal` and `JSON.stringify` renders as a STRING —
 * while every client type declares them `number`. Nothing type-checks across the
 * wire, so the mismatch surfaces only as downstream oddities: `.toFixed()` throwing,
 * or `unitLabel`'s `qty === 1` test failing against `"1"` and printing "1 units".
 *
 * This passed the values through verbatim until 2026-08-05, which was correct while
 * the columns were `Int` and became wrong the moment the fractional-quantity
 * migration widened them. `Number()` is exact here — `numeric(10,2)` tops out at
 * 99999999.99, far inside what a double represents without loss.
 */
export function withStockStatus<T extends { quantity: StockQty; low_stock_threshold: StockQty | null }>(
	item: T,
): Omit<T, "quantity" | "low_stock_threshold"> & {
	quantity: number;
	low_stock_threshold: number | null;
	stock_status: StockStatus;
} {
	return {
		...item,
		quantity: toNumber(item.quantity),
		low_stock_threshold:
			item.low_stock_threshold === null ? null : toNumber(item.low_stock_threshold),
		stock_status: getStockStatus(item.quantity, item.low_stock_threshold),
	};
}

// ---------------------------------------------------------------------------
// Mixed-unit aggregates
// ---------------------------------------------------------------------------

/**
 * How an aggregated quantity is DENOMINATED — the one shape every endpoint that
 * sums `stock_movement.qty` returns alongside its numbers.
 *
 * `stock_movement.unit` is stamped at write time by recordMovements() and frozen,
 * so a ledger that spans a unit change (item edited from `each` to `box`) is now
 * DETECTABLE. It is still not summable: `3 each + 2 box` has no value, and there is
 * no conversion to fall back on — multi-UOM conversion was declined deliberately
 * (D4), because inventing a factor here would rebuild the silent wrongness that
 * stamping the unit exists to end.
 *
 * So aggregates FLAG rather than fail. When `mixed` is true the endpoint returns
 * `null` for every quantity (and for anything derived from one — value, weighted
 * average cost, usage rate, runway) and lets the UI say why. Three rules make that
 * honest rather than merely quiet:
 *
 *  1. The basis is derived ONLY from the stamped units of the rows that actually
 *     fed the aggregate. Never from `inventory_item.unit` — the item's current unit
 *     is exactly the wrong answer, since it is what silently reinterpreted history
 *     before the column existed.
 *  2. The basis covers every row the aggregate touched, including rows outside a
 *     display window that were folded into an opening balance or a running average.
 *     A window that looks internally consistent is still contaminated if its
 *     starting level was summed across the seam.
 *  3. Nothing is truncated to "just the current unit". Dropping the older
 *     denomination would produce a plausible number that quietly disagrees with the
 *     ledger — worse than no number.
 *
 * `units` is SORTED, not chronological: it comes from `array_agg(DISTINCT …)`, which
 * has no cheap chronological form. Copy must therefore say "spans 2 units (box,
 * each)" and never imply a direction ("each → box") the basis cannot support.
 */
export interface UnitBasis {
	/**
	 * Distinct stamped units across the aggregated rows, sorted, as CATALOG CODES
	 * where the stamp is a recognised spelling (see {@link unitBasis}). Empty if no rows.
	 */
	units: string[];
	/** The unit every row shares. `null` when the rows are mixed OR there are none. */
	unit: string | null;
	/** More than one distinct stamped unit — totals over these rows are withheld. */
	mixed: boolean;
}

/**
 * Builds a {@link UnitBasis} from the stamped units of the aggregated rows.
 *
 * Accepts what the two query styles actually hand back: a `text[]` from
 * `array_agg(DISTINCT sm.unit)` (null when the aggregate matched no rows), or the
 * per-row `unit` values off a `findMany`. Blanks are ignored rather than counted as
 * a distinct unit — a blank is missing information, and treating it as a second
 * denomination would flag a clean series.
 *
 * Each stamp is normalised through the unit catalog before de-duplication:
 * `inventory_item.unit` was freetext before the catalog existed, and the
 * 20260805 migration backfilled `stock_movement.unit` verbatim, so a ledger can
 * legitimately carry "Each" beside "each", or "gallon" beside "gal". Those are the
 * SAME denomination spelled two ways, not a unit change, and flagging them as
 * mixed would withhold every total for an item whose history is perfectly
 * summable. A spelling the catalog does not know is kept as-is (still distinct).
 */
export function unitBasis(units: Iterable<string | null | undefined> | null | undefined): UnitBasis {
	const seen = new Set<string>();
	for (const u of units ?? []) {
		if (typeof u === "string" && u.trim() !== "") seen.add(normalizeUnitCode(u) ?? u);
	}
	const sorted = [...seen].sort();
	return {
		units: sorted,
		unit: sorted.length === 1 ? sorted[0] : null,
		mixed: sorted.length > 1,
	};
}

/** Union of several bases — e.g. one page of per-group aggregates sharing a column. */
export function mergeUnitBases(bases: UnitBasis[]): UnitBasis {
	return unitBasis(bases.flatMap((b) => b.units));
}

// ---------------------------------------------------------------------------
// Consumption aggregates
// ---------------------------------------------------------------------------

/**
 * The one definition of "consumption" every aggregate over `stock_movement`
 * shares (item usage, consumption trend, reorder forecast, usage-by-item).
 *
 * Consumption is `parts_used` + `direct_consumption`, NET of reversals: a
 * `reversal` whose `from_location_type` is `consumed` (updatePartsUsedQty
 * decreasing or deleting a parts-used line) cancels demand that never happened
 * and must be subtracted, not ignored — otherwise the item page says 5 were
 * used while the reorder forecast (which already nets) says 2.
 *
 * Both fragments expect the `stock_movement` table to be aliased **`sm`** in
 * the surrounding query. Embed them in a `$queryRaw` tagged template directly:
 *
 *   SUM(${CONSUMPTION_SIGNED_QTY}) … WHERE ${CONSUMPTION_MOVEMENT_PREDICATE}
 *
 * Keep the two in lockstep: rows selected by the predicate are exactly the rows
 * the signed qty knows how to sign. If a new reversal writer appears, extend
 * the predicate here rather than in any one caller.
 */
export const CONSUMPTION_MOVEMENT_PREDICATE = Prisma.sql`(
	sm.reason IN ('parts_used', 'direct_consumption')
	OR (sm.reason = 'reversal' AND sm.from_location_type = 'consumed')
)`;

/** Signed qty for a row matched by {@link CONSUMPTION_MOVEMENT_PREDICATE}: reversals subtract. */
export const CONSUMPTION_SIGNED_QTY = Prisma.sql`CASE WHEN sm.reason = 'reversal' THEN -sm.qty ELSE sm.qty END`;
