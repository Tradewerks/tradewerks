import { randomUUID } from "crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { STOCK_QTY_MESSAGE, isStorableStockQty } from "../lib/validate/shared.js";
import { SupplierValidationError } from "./suppliers.js";
import {
	applyTracking,
	type ItemTrackingFlags,
	type TrackedMovement,
	type SerialMovementInput,
	type BatchAllocationInput,
} from "./inventoryTracking.js";

export {
	InsufficientBatchStockError,
	TrackingValidationError,
	getOrCreateBatch,
	shortCode,
	buildTrackingInputs,
	type RawTrackingInput,
	type TrackingLineInput,
	type TrackingReasonCode,
	type ResolvedTrackingLine,
	type BuildTrackingOpts,
	type ItemTrackingFlags,
} from "./inventoryTracking.js";

type TransactionClient = Prisma.TransactionClient;

export class InsufficientStockError extends Error {
	/** Per-item available quantities at the time of the check. */
	readonly available: Record<string, number>;

	constructor(available: Record<string, number>) {
		super("Insufficient warehouse stock for requested movements");
		this.name = "InsufficientStockError";
		this.available = available;
	}
}

/** Throws instead of defaulting — a guessed unit would silently misdenominate the ledger. */
function mustGetUnit(units: Map<string, string>, itemId: string): string {
	const unit = units.get(itemId);
	if (unit === undefined) {
		throw new Error(`Cannot stamp movement unit: inventory item ${itemId} not found in org scope`);
	}
	return unit;
}

export interface ActorInfo {
	actor_type: "technician" | "dispatcher" | "system";
	actor_id?: string;
}

export interface MovementInput {
	inventory_item_id: string;
	/** Must be > 0, with at most 2 decimal places (every qty column is numeric(10,2)). */
	qty: number;
	from_location_type: "warehouse" | "vehicle" | "consumed" | "adjustment" | "external";
	from_vehicle_id?: string;
	to_location_type: "warehouse" | "vehicle" | "consumed" | "adjustment" | "external";
	to_vehicle_id?: string;
	reason:
		| "receive"
		| "restock"
		| "return_to_warehouse"
		| "parts_used"
		| "direct_consumption"
		| "loss"
		| "audit_correction"
		| "transfer"
		| "reversal"
		| "initial"
		| "supplier_purchase";
	note?: string;
	/** Per-unit cost paid, for intake movements only (reason "receive"/"supplier_purchase"); omit elsewhere. */
	unit_cost?: number;
	/**
	 * Who the stock was bought FROM, for intake movements only. Unlike unit_cost
	 * above (whose contract is caller-enforced), this one is enforced here: it's
	 * dropped on every non-intake reason, so an internal transfer can never
	 * inherit a vendor and inflate that vendor's purchase history.
	 */
	supplier_id?: string;
	visit_id?: string;
	visit_line_item_id?: string;
	restock_record_id?: string;
	adjustment_id?: string;
	/** Receipt line an approved field purchase brought in, for reversal and audit. */
	field_purchase_line_id?: string;
	purchase_line_id?: string;
	/** Serial units to move/create (serialized items only). */
	serial?: SerialMovementInput;
	/** Explicit batch picks (batch-tracked items); omitted → FIFO auto-allocate on deductions. */
	batch_allocations?: BatchAllocationInput[];
}

/** The only reasons that represent stock arriving from outside the org. */
export const INTAKE_REASONS: ReadonlySet<MovementInput["reason"]> = new Set([
	"receive",
	"supplier_purchase",
]);

export interface RecordMovementsOpts {
	/** Allow warehouse qty to go negative. Default: false (throws InsufficientStockError). */
	allowNegative?: boolean;
	/**
	 * Let a tracked movement through even when serial/batch inputs are missing
	 * (visit-completion path only). Records a "[TRACKING_GAP]" note instead of
	 * throwing; surfaced by the reconciliation report.
	 */
	allowUntracked?: boolean;
}

/**
 * SELECT ... FOR UPDATE on inventory_item rows before reading warehouse quantities.
 * Prevents TOCTOU races in EOD cap math. itemIds must be sorted by caller.
 */
export async function lockInventoryRows(tx: TransactionClient, itemIds: string[]): Promise<void> {
	if (itemIds.length === 0) return;
	await tx.$queryRaw`
		SELECT id FROM inventory_item
		WHERE id = ANY(${itemIds}::text[])
		FOR UPDATE
	`;
}

/**
 * Single-writer service — the only place that updates inventory_item.quantity
 * and vehicle_stock_item.qty_on_hand. All callers use this inside a transaction.
 *
 * Deterministic sort on (inventory_item_id, from_vehicle_id, to_vehicle_id) prevents
 * deadlocks when multiple callers run concurrently.
 *
 * Returns lowStockItemIds for callers to fire alerts post-commit.
 */
export async function recordMovements(
	tx: TransactionClient,
	orgId: string,
	actor: ActorInfo,
	movements: MovementInput[],
	opts: RecordMovementsOpts = {},
): Promise<{ lowStockItemIds: string[]; gapItemIds: string[]; movementIds: string[] }> {
	if (movements.length === 0) return { lowStockItemIds: [], gapItemIds: [], movementIds: [] };

	// 1. Validate qty
	for (const m of movements) {
		if (m.qty <= 0) throw new Error(`Movement qty must be > 0; got ${m.qty}`);

		// A third decimal is refused here rather than silently rounded by Postgres,
		// which would desync the cached on-hand from this ledger.
		if (!isStorableStockQty(m.qty)) {
			throw new Error(
				`Movement qty (${m.qty}) on item ${m.inventory_item_id} is not storable: ${STOCK_QTY_MESSAGE}`,
			);
		}
	}

	// 2. Deterministic sort — prevents deadlocks
	const sorted = [...movements].sort((a, b) => {
		const item = a.inventory_item_id.localeCompare(b.inventory_item_id);
		if (item !== 0) return item;
		const from = (a.from_vehicle_id ?? "").localeCompare(b.from_vehicle_id ?? "");
		if (from !== 0) return from;
		return (a.to_vehicle_id ?? "").localeCompare(b.to_vehicle_id ?? "");
	});

	// 2b. Pre-generate ledger ids — createMany returns none, and serial/batch
	// allocation joins must reference stock_movement.id. Note may be mutated later
	// by the tracking pass (TRACKING_GAP), so insert reads from these same objects.
	const withIds: (MovementInput & { _id: string })[] = sorted.map((m) => ({
		...m,
		_id: randomUUID(),
	}));

	// 3. Aggregate cache deltas — in Decimal, not float. Quantities are 2-dp
	// decimals, and summing them as doubles (0.1 + 0.2 = 0.30000000000000004)
	// produced a third decimal that made the overdraw guard below report a false
	// InsufficientStock (0.3 on hand minus 0.1 and 0.2 is -5.5e-17 < 0).
	const ZERO = new Prisma.Decimal(0);
	const itemDeltas = new Map<string, Prisma.Decimal>(); // inventory_item.quantity
	// vehicle key = `${vehicle_id}::${item_id}`
	const vehicleItemDeltaMap = new Map<
		string,
		{ vehicle_id: string; inventory_item_id: string; delta: Prisma.Decimal }
	>();

	for (const m of withIds) {
		const qty = new Prisma.Decimal(m.qty);
		if (m.from_location_type === "warehouse") {
			itemDeltas.set(m.inventory_item_id, (itemDeltas.get(m.inventory_item_id) ?? ZERO).minus(qty));
		}
		if (m.to_location_type === "warehouse") {
			itemDeltas.set(m.inventory_item_id, (itemDeltas.get(m.inventory_item_id) ?? ZERO).plus(qty));
		}
		if (m.from_vehicle_id) {
			const key = `${m.from_vehicle_id}::${m.inventory_item_id}`;
			const e = vehicleItemDeltaMap.get(key);
			if (e) e.delta = e.delta.minus(qty);
			else vehicleItemDeltaMap.set(key, { vehicle_id: m.from_vehicle_id, inventory_item_id: m.inventory_item_id, delta: qty.negated() });
		}
		if (m.to_vehicle_id) {
			const key = `${m.to_vehicle_id}::${m.inventory_item_id}`;
			const e = vehicleItemDeltaMap.get(key);
			if (e) e.delta = e.delta.plus(qty);
			else vehicleItemDeltaMap.set(key, { vehicle_id: m.to_vehicle_id, inventory_item_id: m.inventory_item_id, delta: qty });
		}
	}

	// 4. Lock warehouse-touched item rows (SELECT FOR UPDATE)
	const itemIds = [...itemDeltas.keys()].sort();
	await lockInventoryRows(tx, itemIds);

	// 5. Warehouse overdraw guard
	if (!opts.allowNegative) {
		const deductions = itemIds.filter((id) => (itemDeltas.get(id) ?? ZERO).lessThan(0));
		if (deductions.length > 0) {
			const rows = await tx.inventory_item.findMany({
				where: { id: { in: deductions } },
				select: { id: true, quantity: true },
			});

			const insufficient: Record<string, number> = {};
			for (const row of rows) {
				const projected = new Prisma.Decimal(row.quantity).plus(itemDeltas.get(row.id)!);
				if (projected.lessThan(0)) insufficient[row.id] = Number(row.quantity);
			}
			if (Object.keys(insufficient).length > 0) throw new InsufficientStockError(insufficient);
		}
	}

	// 6. Apply inventory_item deltas (deterministic order)
	for (const itemId of itemIds) {
		const delta = itemDeltas.get(itemId)!;
		if (delta.isZero()) continue;
		await tx.inventory_item.update({
			where: { id: itemId },
			data: { quantity: { increment: delta } },
		});
	}

	// 7. Apply vehicle_stock_item deltas (upsert — row may not exist for new restocks)
	const vehicleEntries = [...vehicleItemDeltaMap.values()].sort((a, b) => {
		const v = a.vehicle_id.localeCompare(b.vehicle_id);
		return v !== 0 ? v : a.inventory_item_id.localeCompare(b.inventory_item_id);
	});

	for (const entry of vehicleEntries) {
		if (entry.delta.isZero()) continue;
		await tx.vehicle_stock_item.upsert({
			where: {
				vehicle_id_inventory_item_id: {
					vehicle_id: entry.vehicle_id,
					inventory_item_id: entry.inventory_item_id,
				},
			},
			create: {
				vehicle_id: entry.vehicle_id,
				inventory_item_id: entry.inventory_item_id,
				qty_on_hand: entry.delta,
				qty_min: 0,
			},
			update: {
				qty_on_hand: { increment: entry.delta },
			},
		});
	}

	// 7b. Auto-resolve pending/acknowledged restock requests for items restocked onto a vehicle
	const inboundVehicleEntries = [...vehicleItemDeltaMap.values()].filter((e) => e.delta.greaterThan(0));
	if (inboundVehicleEntries.length > 0) {
		// Find stock_item IDs for (vehicle_id, inventory_item_id) pairs receiving stock
		const stockItemRows = await tx.vehicle_stock_item.findMany({
			where: {
				OR: inboundVehicleEntries.map((e) => ({
					vehicle_id: e.vehicle_id,
					inventory_item_id: e.inventory_item_id,
				})),
			},
			select: { id: true },
		});
		const stockItemIds = stockItemRows.map((s: { id: string }) => s.id);
		if (stockItemIds.length > 0) {
			const resolvedNote = `Auto-resolved by stock movement (${actor.actor_type}${actor.actor_id ? ` · ${actor.actor_id}` : ""})`;
			await tx.vehicle_restock_request.updateMany({
				where: {
					stock_item_id: { in: stockItemIds },
					status: { in: ["pending", "acknowledged"] },
				},
				data: {
					status: "resolved",
					resolved_at: new Date(),
					resolved_note: resolvedNote,
				},
			});
		}
	}

	// 7c. Serial + batch tracking pass (locks batch → serial rows, mutates
	// serial_unit / stock_batch / vehicle_stock_batch, and returns allocation-join
	// rows to insert after the movement rows). May append TRACKING_GAP to notes.
	const allItemIds = [...new Set(withIds.map((m) => m.inventory_item_id))];
	const flags = new Map<string, ItemTrackingFlags>();
	// Read alongside tracking flags (no second round trip), inside the transaction
	// so the stamp matches the unit the item had when the stock moved.
	const units = new Map<string, string>();
	if (allItemIds.length > 0) {
		const flagRows = await tx.inventory_item.findMany({
			where: { id: { in: allItemIds }, organization_id: orgId },
			select: { id: true, is_serialized: true, is_batch_tracked: true, unit: true },
		});
		for (const r of flagRows) {
			flags.set(r.id, {
				is_serialized: !!r.is_serialized,
				is_batch_tracked: !!r.is_batch_tracked,
			});
			units.set(r.id, r.unit);
		}
	}

	const tracking = await applyTracking(tx, orgId, flags, withIds as TrackedMovement[], {
		allowUntracked: opts.allowUntracked,
		allowNegative: opts.allowNegative,
	});

	// 7d. Validate caller-supplied supplier_id against org scope, the same way
	// inventory_item_id was validated above via flagRows. Every current caller
	// resolves supplier_id through resolveSupplier() first, so this never trips
	// in practice — but nothing else here stops a cross-tenant id from being
	// written to stock_movement/supplier_item if a future caller skipped that.
	const intakeSupplierIds = [
		...new Set(
			withIds
				.filter((m) => INTAKE_REASONS.has(m.reason) && m.supplier_id)
				.map((m) => m.supplier_id!),
		),
	];
	if (intakeSupplierIds.length > 0) {
		const orgSuppliers = await tx.supplier.findMany({
			where: { id: { in: intakeSupplierIds }, organization_id: orgId },
			select: { id: true },
		});
		const validIds = new Set(orgSuppliers.map((s) => s.id));
		const foreign = intakeSupplierIds.find((id) => !validIds.has(id));
		if (foreign) {
			// SupplierValidationError, not a plain Error: every other supplier
			// validation path in this feature (resolveSupplier, inventoryController,
			// vehiclesController) throws this class so callers can map it to a
			// friendly 4xx; a plain Error here would 500 instead if this path is
			// ever reached other than through resolveSupplier().
			throw new SupplierValidationError(`Supplier ${foreign} not found in org scope`);
		}
	}

	// 8. Insert movement rows (explicit ids so allocation joins can reference them)
	await tx.stock_movement.createMany({
		data: withIds.map((m) => ({
			id: m._id,
			organization_id: orgId,
			inventory_item_id: m.inventory_item_id,
			qty: new Prisma.Decimal(m.qty),
			unit: mustGetUnit(units, m.inventory_item_id),
			from_location_type: m.from_location_type,
			from_vehicle_id: m.from_vehicle_id ?? null,
			to_location_type: m.to_location_type,
			to_vehicle_id: m.to_vehicle_id ?? null,
			reason: m.reason,
			note: m.note ?? null,
			unit_cost: m.unit_cost != null ? new Prisma.Decimal(m.unit_cost) : null,
			supplier_id: INTAKE_REASONS.has(m.reason) ? (m.supplier_id ?? null) : null,
			actor_type: actor.actor_type,
			actor_id: actor.actor_id ?? null,
			visit_id: m.visit_id ?? null,
			visit_line_item_id: m.visit_line_item_id ?? null,
			restock_record_id: m.restock_record_id ?? null,
			adjustment_id: m.adjustment_id ?? null,
			field_purchase_line_id: m.field_purchase_line_id ?? null,
			purchase_line_id: m.purchase_line_id ?? null,
		})),
	});

	// 8b. Insert allocation joins (FKs → stock_movement.id + serial_unit/stock_batch.id)
	if (tracking.movementSerials.length > 0) {
		await tx.stock_movement_serial.createMany({ data: tracking.movementSerials });
	}
	if (tracking.movementBatches.length > 0) {
		await tx.stock_movement_batch.createMany({ data: tracking.movementBatches });
	}

	// 8c. Keep the vendor price list current.
	//
	// A price list maintained by hand goes stale the week after someone builds
	// it, so this one maintains itself: every purchase that names a vendor AND
	// records what was paid updates that pair's last price. Only intake reasons
	// qualify (same rule as supplier_id above) — an internal transfer is not a
	// purchase and has no price to learn from.
	//
	// Deliberately NOT touching contract_price: that's a negotiated figure, and
	// one unusual counter purchase must not overwrite it.
	// Dedup by (supplier_id, inventory_item_id) first — a batch can carry
	// several movements for the same vendor+item (e.g. a multi-line vehicle
	// restock), and upserting the same pair once per movement instead of once
	// per pair is redundant round-trips for no different end state. Last
	// observation in the batch wins, same as the update clause always did.
	const priceObservations = new Map<
		string,
		{ supplier_id: string; inventory_item_id: string; unit_cost: number }
	>();
	for (const m of withIds) {
		if (!INTAKE_REASONS.has(m.reason) || !m.supplier_id || m.unit_cost == null) continue;
		priceObservations.set(`${m.supplier_id}::${m.inventory_item_id}`, {
			supplier_id: m.supplier_id,
			inventory_item_id: m.inventory_item_id,
			unit_cost: m.unit_cost,
		});
	}
	// One statement for the whole batch, not one round trip per pair: a 20-line
	// delivery naming one vendor would otherwise hold this transaction's row
	// locks for 20 sequential upserts. unnest() turns the arrays into a rowset
	// Postgres can INSERT ... ON CONFLICT DO UPDATE in a single pass.
	if (priceObservations.size > 0) {
		const obs = [...priceObservations.values()];
		const now = new Date();
		const ids = obs.map(() => randomUUID());
		const orgIds = obs.map(() => orgId);
		const supplierIds = obs.map((o) => o.supplier_id);
		const itemIds = obs.map((o) => o.inventory_item_id);
		const prices = obs.map((o) => o.unit_cost);
		const timestamps = obs.map(() => now);

		await tx.$executeRaw`
			INSERT INTO "supplier_item"
				(id, organization_id, supplier_id, inventory_item_id, last_price, last_purchased_at, created_at, updated_at)
			SELECT * FROM unnest(
				${ids}::text[],
				${orgIds}::text[],
				${supplierIds}::text[],
				${itemIds}::text[],
				${prices}::numeric[],
				${timestamps}::timestamp[],
				${timestamps}::timestamp[],
				${timestamps}::timestamp[]
			)
			ON CONFLICT (supplier_id, inventory_item_id) DO UPDATE SET
				last_price = EXCLUDED.last_price,
				last_purchased_at = EXCLUDED.last_purchased_at,
				updated_at = EXCLUDED.updated_at
		`;
	}

	// 9. Return low-stock item IDs for caller to fire alerts post-commit
	const movementIds = withIds.map((m) => m._id);
	if (itemIds.length === 0) return { lowStockItemIds: [], gapItemIds: tracking.gapItemIds, movementIds };

	const updatedItems = await tx.inventory_item.findMany({
		where: { id: { in: itemIds } },
		select: { id: true, quantity: true, low_stock_threshold: true },
	});

	const lowStockItemIds = updatedItems
		.filter(
			(item) =>
				item.low_stock_threshold !== null &&
				// Both sides coerced explicitly: these are Decimals, and `<=` between
				// them compares their string forms, making "9" <= "10" false.
				Number(item.quantity) <= Number(item.low_stock_threshold),
		)
		.map((item) => item.id);

	return { lowStockItemIds, gapItemIds: tracking.gapItemIds, movementIds };
}
