import { randomBytes, randomUUID } from "crypto";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "./appLogger.js";

type TransactionClient = Prisma.TransactionClient;

/**
 * Per-unit serial tracking + lot/batch traceability. This module is the tracking
 * arm of the single-writer stock ledger: recordMovements() calls applyTracking()
 * inside its transaction, so serial_unit / stock_batch / vehicle_stock_batch are
 * mutated in exactly one place, under the same row locks as the item cache.
 *
 * Lock order (deadlock-safe, continues stockMovements' item → … chain):
 *   inventory_item (locked by caller) → stock_batch (sorted) → serial_unit (sorted).
 */

// ── Errors ──────────────────────────────────────────────────────────────────

export class InsufficientBatchStockError extends Error {
	/** batch_id → available qty at check time. */
	readonly available: Record<string, number>;
	constructor(available: Record<string, number>) {
		super("Insufficient batch stock for requested allocations");
		this.name = "InsufficientBatchStockError";
		this.available = available;
	}
}

export class TrackingValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TrackingValidationError";
	}
}

// ── Input shapes (mirrored onto MovementInput in stockMovements.ts) ───────────

export interface SerialMovementInput {
	/** Existing serial_unit ids being moved (must already exist, org+item scoped). */
	unit_ids?: string[];
	/** New units to create — only when from_location_type is external | adjustment. */
	create?: { serial_number: string; batch_id?: string; note?: string }[];
}

export interface BatchAllocationInput {
	batch_id: string;
	qty: number;
}

/** Location → resting serial status. */
export type SerialLocation = "warehouse" | "vehicle" | "consumed" | "adjustment" | "external";

const LOCATION_STATUS: Record<SerialLocation, "in_warehouse" | "on_vehicle" | "consumed" | "lost" | "returned"> = {
	warehouse: "in_warehouse",
	vehicle: "on_vehicle",
	consumed: "consumed",
	adjustment: "lost",
	external: "returned",
};

export interface ItemTrackingFlags {
	is_serialized: boolean;
	is_batch_tracked: boolean;
}

// ── buildTrackingInputs (raw caller input → MovementInput tracking fields) ────

export interface RawTrackingInput {
	serial_unit_ids?: string[];
	new_serials?: string[];
	batch_id?: string;
	batch_picks?: BatchAllocationInput[];
}

export interface TrackingLineInput {
	inventory_item_id: string;
	/** Requested/target qty for this line (qty_to_restock, qty_used, abs(delta), etc). */
	qty: number;
	raw: RawTrackingInput;
}

export type TrackingReasonCode = "ok" | "no_tracking_gap" | "cache_drift_detected";

export interface ResolvedTrackingLine {
	inventory_item_id: string;
	/** Reconciled qty to actually move. */
	qty: number;
	shortfall: number;
	reasonCode: TrackingReasonCode;
	/** Spread directly onto a MovementInput. */
	tracking: { serial?: SerialMovementInput; batch_allocations?: BatchAllocationInput[] };
}

export interface BuildTrackingOpts {
	/**
	 * Cache-derived warehouse qty available per inventory_item_id. Present ONLY
	 * for restock-style callers (completeRestock, applyFill) that clamp a
	 * multi-line deduction against the warehouse cache. Omit for single-line,
	 * exact-qty callers (addPartsUsed, adjustStock, adjustInventoryStock,
	 * receiveInventoryItem) — those enforce an exact serial/batch match instead
	 * of clamping, and throw TrackingValidationError on a mismatch.
	 * MUTATED in place (decremented per line) to mirror the original callers'
	 * imperative running-balance behavior.
	 */
	available?: Map<string, number>;
	/** Field name for existing-unit references in error text. Default "serial_unit_ids". */
	serialIdField?: string;
	/** Whether creating brand-new serials via `new_serials` is legal for this caller (adjustStock: yes). */
	allowNewSerials?: boolean;
}

/**
 * Single seam translating raw serial/batch input into MovementInput tracking
 * fields, replacing four copy-pasted fetch+map blocks across vehiclesController
 * and the duplicated pre-validation in inventoryController. In capped mode this
 * is also where the cache-drift shortfall bug dies (see phase 0 of the 2026-07-14
 * audit-fixes plan): a serialized line with real scan input is never clamped to
 * the inventory_item.quantity cache, and a batch-tracked line clamps against the
 * real non-recalled stock_batch sum instead of the cache.
 */
export async function buildTrackingInputs(
	tx: TransactionClient,
	organizationId: string,
	flags: Map<string, ItemTrackingFlags>,
	lines: TrackingLineInput[],
	opts: BuildTrackingOpts = {},
): Promise<ResolvedTrackingLine[]> {
	const capped = !!opts.available;
	const serialIdField = opts.serialIdField ?? "serial_unit_ids";
	const results: ResolvedTrackingLine[] = [];

	let batchAvailByItem: Map<string, number> | undefined;
	if (capped) {
		const batchItemIds = [
			...new Set(
				lines
					.filter((l) => flags.get(l.inventory_item_id)?.is_batch_tracked)
					.map((l) => l.inventory_item_id),
			),
		];
		if (batchItemIds.length > 0) {
			const rows = await tx.stock_batch.findMany({
				where: {
					organization_id: organizationId,
					inventory_item_id: { in: batchItemIds },
					recalled_at: null,
				},
				select: { inventory_item_id: true, qty_in_warehouse: true },
			});
			batchAvailByItem = new Map();
			for (const r of rows) {
				batchAvailByItem.set(
					r.inventory_item_id,
					(batchAvailByItem.get(r.inventory_item_id) ?? 0) + Number(r.qty_in_warehouse),
				);
			}
		}
	}

	for (const line of lines) {
		const f = flags.get(line.inventory_item_id) ?? { is_serialized: false, is_batch_tracked: false };
		const cacheAvail = () => Math.max(0, opts.available?.get(line.inventory_item_id) ?? 0);
		const decrementCache = (used: number) => {
			if (opts.available) opts.available.set(line.inventory_item_id, cacheAvail() - used);
		};
		const clampToCache = (line: TrackingLineInput, reasonCode: TrackingReasonCode): ResolvedTrackingLine => {
			const qty = Math.min(line.qty, cacheAvail());
			decrementCache(qty);
			return {
				inventory_item_id: line.inventory_item_id,
				qty,
				shortfall: line.qty - qty,
				reasonCode,
				tracking: {},
			};
		};

		if (f.is_serialized) {
			const hasIds = !!line.raw.serial_unit_ids?.length;
			const hasNew = !!line.raw.new_serials?.length;

			if (!hasIds && !hasNew) {
				if (capped) {
					results.push(clampToCache(line, "no_tracking_gap"));
					continue;
				}
				const fields = opts.allowNewSerials ? `${serialIdField} or new_serials` : serialIdField;
				throw new TrackingValidationError(
					`Serialized item ${line.inventory_item_id} requires ${fields} for this movement`,
				);
			}

			const providedCount = hasIds ? line.raw.serial_unit_ids!.length : line.raw.new_serials!.length;
			if (!capped && providedCount !== line.qty) {
				// Bug fix (see task-1 report): a caller that repurposes the
				// `new_serials` slot under its own field name (receiveInventoryItem's
				// `serial_numbers`, mapped in without allowNewSerials) needs THIS
				// label too, not a hardcoded "new_serials" — that literal is only
				// correct for a caller (adjustStock) that has a real, distinct
				// new_serials field alongside serial_unit_ids (allowNewSerials: true).
				const label = hasIds ? serialIdField : opts.allowNewSerials ? "new_serials" : serialIdField;
				throw new TrackingValidationError(
					`${label} must have exactly ${line.qty} entries for item ${line.inventory_item_id}`,
				);
			}

			if (capped && providedCount > cacheAvail()) {
				log.warn(
					{ inventory_item_id: line.inventory_item_id, cache: cacheAvail(), scanned: providedCount },
					"[buildTrackingInputs] serial scan count exceeds cached quantity — cache drift",
				);
			}
			const reasonCode: TrackingReasonCode =
				capped && providedCount > cacheAvail() ? "cache_drift_detected" : "ok";

			decrementCache(line.qty);
			results.push({
				inventory_item_id: line.inventory_item_id,
				qty: line.qty,
				shortfall: 0,
				reasonCode,
				tracking: {
					serial: hasIds
						? { unit_ids: line.raw.serial_unit_ids }
						: {
								create: line.raw.new_serials!.map((sn) => ({
									serial_number: sn,
									batch_id: line.raw.batch_id,
								})),
							},
				},
			});
			continue;
		}

		if (f.is_batch_tracked) {
			const hasPicks = !!line.raw.batch_picks?.length;
			const hasSingleBatch = !!line.raw.batch_id;

			if (!capped) {
				const allocations = hasSingleBatch
					? [{ batch_id: line.raw.batch_id!, qty: line.qty }]
					: hasPicks
						? line.raw.batch_picks!
						: undefined;
				results.push({
					inventory_item_id: line.inventory_item_id,
					qty: line.qty,
					shortfall: 0,
					reasonCode: "ok",
					tracking: { batch_allocations: allocations },
				});
				continue;
			}

			const realAvail = Math.max(0, batchAvailByItem?.get(line.inventory_item_id) ?? 0);
			const qty = Math.min(line.qty, realAvail);
			const cacheBefore = cacheAvail();
			if (realAvail !== cacheBefore) {
				log.warn(
					{ inventory_item_id: line.inventory_item_id, cache: cacheBefore, lotSum: realAvail },
					"[buildTrackingInputs] batch lot sum disagrees with cached quantity — cache drift",
				);
			}

			let allocations: BatchAllocationInput[] | undefined;
			if (hasPicks) {
				allocations = [];
				let remaining = qty;
				for (const pick of line.raw.batch_picks!) {
					if (remaining <= 0) break;
					const take = Math.min(Number(pick.qty), remaining);
					if (take > 0) allocations.push({ batch_id: pick.batch_id, qty: take });
					remaining -= take;
				}
			}

			decrementCache(qty);
			results.push({
				inventory_item_id: line.inventory_item_id,
				qty,
				shortfall: line.qty - qty,
				reasonCode:
					qty < line.qty && !hasPicks
						? "no_tracking_gap"
						: realAvail !== cacheBefore
							? "cache_drift_detected"
							: "ok",
				tracking: { batch_allocations: allocations },
			});
			continue;
		}

		// Untracked: existing cache-clamp behavior, unchanged.
		if (capped) {
			results.push(clampToCache(line, "ok"));
		} else {
			results.push({
				inventory_item_id: line.inventory_item_id,
				qty: line.qty,
				shortfall: 0,
				reasonCode: "ok",
				tracking: {},
			});
		}
	}

	return results;
}

/** A movement enriched with its pre-generated ledger id + tracking inputs. */
export interface TrackedMovement {
	/** Pre-generated stock_movement.id (createMany returns no ids). */
	_id: string;
	inventory_item_id: string;
	qty: number;
	from_location_type: SerialLocation;
	from_vehicle_id?: string;
	to_location_type: SerialLocation;
	to_vehicle_id?: string;
	reason: string;
	visit_id?: string;
	visit_line_item_id?: string;
	note?: string;
	serial?: SerialMovementInput;
	batch_allocations?: BatchAllocationInput[];
}

export interface ApplyTrackingOpts {
	/**
	 * When true (completion path only), a tracked item that arrives with no
	 * serial/batch inputs is allowed through: no serial/batch rows are written and
	 * "[TRACKING_GAP]" is appended to the movement note (surfaced by reconciliation).
	 */
	allowUntracked?: boolean;
	/** Skip batch stock-underflow guard (mirrors recordMovements allowNegative). */
	allowNegative?: boolean;
}

export interface ApplyTrackingResult {
	movementSerials: { movement_id: string; serial_unit_id: string }[];
	movementBatches: { movement_id: string; batch_id: string; qty: Prisma.Decimal }[];
	/** inventory_item_ids whose movement was let through with an unresolved tracking gap. */
	gapItemIds: string[];
}

// ── Batch header helper (controllers pre-create headers; qty stays 0) ─────────

export interface GetOrCreateBatchArgs {
	inventory_item_id: string;
	batch_number: string;
	expires_at?: Date | null;
	/** Legacy free-text vendor. Callers set it alongside supplier_id, never alone. */
	supplier?: string | null;
	supplier_id?: string | null;
	note?: string | null;
	/** Per-unit cost paid for this lot. Only recorded when the header is created. */
	unit_cost?: number | null;
}

/**
 * Idempotent batch-header creation. Does NOT touch any quantity — only
 * recordMovements moves stock into/out of a batch. Safe to call before recording
 * a receive movement so the movement can reference batch_id.
 */
export async function getOrCreateBatch(
	tx: TransactionClient,
	organizationId: string,
	args: GetOrCreateBatchArgs,
): Promise<{ id: string; code: string }> {
	const existing = await tx.stock_batch.findFirst({
		where: {
			organization_id: organizationId,
			inventory_item_id: args.inventory_item_id,
			batch_number: args.batch_number,
		},
		select: { id: true, code: true },
	});
	if (existing) return existing;

	return tx.stock_batch.create({
		data: {
			organization_id: organizationId,
			inventory_item_id: args.inventory_item_id,
			batch_number: args.batch_number,
			code: shortCode("LOT"),
			expires_at: args.expires_at ?? null,
			supplier: args.supplier ?? null,
			supplier_id: args.supplier_id ?? null,
			unit_cost: args.unit_cost ?? null,
			note: args.note ?? null,
		},
		select: { id: true, code: true },
	});
}

// ── Short human-readable codes (QR payload, not uuid) ─────────────────────────

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford-ish, no I/L/O/U

// 10 base32 chars * 5 bits/char = 50 bits of entropy. Previously this drew 8
// chars from a v4 UUID's hex pairs — only ~37 effective bits, since the UUID
// version/variant bits (fixed nibbles at fixed positions) aren't free entropy.
// randomBytes is uniform full-entropy input with no such format constraints,
// and 256 (byte range) is evenly divisible by 32, so `byte % 32` is unbiased.
const CODE_LENGTH = 10;

/** e.g. "SU-7K2M9QWX3F" — short, scannable, ~50 bits of entropy. */
export function shortCode(prefix: "SU" | "LOT" | "ITM" | "AUTO"): string {
	const bytes = randomBytes(CODE_LENGTH);
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		out += BASE32[bytes[i] % 32];
	}
	return `${prefix}-${out}`;
}

// ── Locks ─────────────────────────────────────────────────────────────────────

export async function lockBatchRows(tx: TransactionClient, batchIds: string[]): Promise<void> {
	if (batchIds.length === 0) return;
	await tx.$queryRaw`SELECT id FROM stock_batch WHERE id = ANY(${batchIds}::text[]) FOR UPDATE`;
}

export async function lockSerialRows(tx: TransactionClient, serialIds: string[]): Promise<void> {
	if (serialIds.length === 0) return;
	await tx.$queryRaw`SELECT id FROM serial_unit WHERE id = ANY(${serialIds}::text[]) FOR UPDATE`;
}

// ── Core ────────────────────────────────────────────────────────────────────

/**
 * Validates + applies serial/batch effects for a batch of ledger movements.
 * Assumes inventory_item rows are already locked by recordMovements. Returns the
 * allocation-join rows for recordMovements to insert AFTER the movement rows
 * (join FKs reference stock_movement.id + serial_unit/stock_batch.id).
 */
export async function applyTracking(
	tx: TransactionClient,
	organizationId: string,
	flags: Map<string, ItemTrackingFlags>,
	movements: TrackedMovement[],
	opts: ApplyTrackingOpts = {},
): Promise<ApplyTrackingResult> {
	const result: ApplyTrackingResult = { movementSerials: [], movementBatches: [], gapItemIds: [] };

	// 1. Guard: non-tracked items must not carry tracking inputs.
	for (const m of movements) {
		const f = flags.get(m.inventory_item_id) ?? { is_serialized: false, is_batch_tracked: false };
		const hasSerial = !!(m.serial?.unit_ids?.length || m.serial?.create?.length);
		const hasBatch = !!m.batch_allocations?.length;
		if (hasSerial && !f.is_serialized)
			throw new TrackingValidationError(
				`Serial inputs supplied for non-serialized item ${m.inventory_item_id}`,
			);
		if (hasBatch && !f.is_batch_tracked)
			throw new TrackingValidationError(
				`Batch allocations supplied for non-batch-tracked item ${m.inventory_item_id}`,
			);
	}

	// 2. Pre-lock every batch + serial row we will read or mutate (sorted).
	const { batchIds, serialIds } = await collectLockTargets(tx, organizationId, flags, movements);
	await lockBatchRows(tx, batchIds);
	await lockSerialRows(tx, serialIds);

	// 3. Per-movement effects.
	for (const m of movements) {
		const f = flags.get(m.inventory_item_id) ?? { is_serialized: false, is_batch_tracked: false };
		if (!f.is_serialized && !f.is_batch_tracked) continue;

		const hasSerial = !!(m.serial?.unit_ids?.length || m.serial?.create?.length);

		// Completion gap: serialized item let through with no inputs.
		if (f.is_serialized && !hasSerial) {
			if (opts.allowUntracked) {
				result.gapItemIds.push(m.inventory_item_id);
				markGap(m);
				continue;
			}
			throw new TrackingValidationError(
				`Serialized item ${m.inventory_item_id} requires serial units for this movement`,
			);
		}

		if (f.is_serialized) {
			const batchAllocsFromSerials = await applySerialMovement(tx, organizationId, m, result);
			// Serialized + batch-tracked: derive batch allocations from the units' batch_id.
			if (f.is_batch_tracked && batchAllocsFromSerials.length > 0) {
				await applyBatchAllocations(tx, organizationId, m, batchAllocsFromSerials, result, opts);
			}
			continue;
		}

		// Batch-only item.
		if (f.is_batch_tracked) {
			const hasBatch = !!m.batch_allocations?.length;
			const allocs = hasBatch
				? m.batch_allocations!.map((a) => ({ batch_id: a.batch_id, qty: new Prisma.Decimal(a.qty) }))
				: await autoAllocateFifo(tx, organizationId, m, opts);
			if (allocs.length === 0) {
				if (opts.allowUntracked) {
					result.gapItemIds.push(m.inventory_item_id);
					markGap(m);
					continue;
				}
				throw new TrackingValidationError(
					`Batch-tracked item ${m.inventory_item_id} requires a batch allocation`,
				);
			}
			assertAllocationSum(m, allocs);
			await applyBatchAllocations(tx, organizationId, m, allocs, result, opts);
		}
	}

	return result;
}

function isDeduction(m: TrackedMovement): boolean {
	// Removes stock from a real (non-virtual) location.
	return m.from_location_type === "warehouse" || m.from_location_type === "vehicle";
}

function markGap(m: TrackedMovement): void {
	m.note = `${m.note ? m.note + " " : ""}[TRACKING_GAP]`;
}

function assertAllocationSum(m: TrackedMovement, allocs: { qty: Prisma.Decimal }[]): void {
	const sum = allocs.reduce((acc, a) => acc.plus(a.qty), new Prisma.Decimal(0));
	if (!sum.equals(new Prisma.Decimal(m.qty)))
		throw new TrackingValidationError(
			`Batch allocations (${sum.toString()}) must sum to movement qty (${m.qty}) for item ${m.inventory_item_id}`,
		);
}

// ── Serial effects ────────────────────────────────────────────────────────────

/**
 * Applies a serialized-item movement: creates new units (external/adjustment
 * sources only), transitions existing units through the state machine, records
 * the consumption snapshot on consume and clears it on reversal. Returns implied
 * batch allocations (grouped by batch_id) so batch-carrying serialized items also
 * emit stock_movement_batch rows.
 */
async function applySerialMovement(
	tx: TransactionClient,
	organizationId: string,
	m: TrackedMovement,
	result: ApplyTrackingResult,
): Promise<{ batch_id: string; qty: Prisma.Decimal }[]> {
	if (!Number.isInteger(m.qty))
		throw new TrackingValidationError(
			`Serialized item ${m.inventory_item_id} requires integer qty; got ${m.qty}`,
		);

	const unitIds = m.serial?.unit_ids ?? [];
	const creates = m.serial?.create ?? [];
	const total = unitIds.length + creates.length;
	if (total !== m.qty)
		throw new TrackingValidationError(
			`Serial count (${total}) must equal qty (${m.qty}) for item ${m.inventory_item_id}`,
		);

	// Dup detection.
	if (new Set(unitIds).size !== unitIds.length)
		throw new TrackingValidationError(`Duplicate serial unit ids for item ${m.inventory_item_id}`);
	const newSerials = creates.map((c) => c.serial_number);
	if (new Set(newSerials).size !== newSerials.length)
		throw new TrackingValidationError(`Duplicate serial numbers for item ${m.inventory_item_id}`);

	const toStatus = LOCATION_STATUS[m.to_location_type];
	const toVehicle = m.to_location_type === "vehicle" ? (m.to_vehicle_id ?? null) : null;
	const batchTally = new Map<string, number>();
	const touched: { id: string; batch_id: string | null }[] = [];

	// Create new units — only from a virtual source.
	if (creates.length > 0) {
		if (m.from_location_type !== "external" && m.from_location_type !== "adjustment")
			throw new TrackingValidationError(
				`New serial units may only be created from external/adjustment sources (item ${m.inventory_item_id})`,
			);
		const clientId = toStatus === "consumed" ? await resolveClientId(tx, m.visit_id) : null;
		// createMany returns no ids, so pre-generate them client-side (same approach
		// as TrackedMovement._id) — the pre-generated id is what we push into `touched`.
		const createRows = creates.map((c) => {
			const batch_id = c.batch_id ?? null;
			return {
				id: randomUUID(),
				organization_id: organizationId,
				inventory_item_id: m.inventory_item_id,
				serial_number: c.serial_number,
				code: shortCode("SU"),
				status: toStatus,
				current_vehicle_id: toVehicle,
				batch_id,
				note: c.note ?? null,
				...(toStatus === "consumed"
					? {
							consumed_at: new Date(),
							consumed_visit_id: m.visit_id ?? null,
							consumed_line_item_id: m.visit_line_item_id ?? null,
							client_id: clientId,
						}
					: {}),
			};
		});

		await tx.serial_unit.createMany({ data: createRows });
		for (const row of createRows) touched.push({ id: row.id, batch_id: row.batch_id });
	}

	// Transition existing units.
	if (unitIds.length > 0) {
		const rows = await tx.serial_unit.findMany({
			where: { id: { in: unitIds }, organization_id: organizationId, inventory_item_id: m.inventory_item_id },
			select: { id: true, status: true, current_vehicle_id: true, batch_id: true },
		});
		if (rows.length !== unitIds.length)
			throw new TrackingValidationError(
				`Some serial units not found for item ${m.inventory_item_id} (org-scoped)`,
			);

		const expectedFrom = LOCATION_STATUS[m.from_location_type];
		const isReversal = m.reason === "reversal";
		const clientId = toStatus === "consumed" ? await resolveClientId(tx, m.visit_id) : null;

		// Validate every row before any write — a failure here must abort with zero
		// mutation, so the update is issued only after the full loop passes.
		for (const row of rows) {
			// Skip the from-status check for virtual sources (external/adjustment).
			const checkFrom = m.from_location_type === "warehouse" || m.from_location_type === "vehicle";
			if (checkFrom && row.status !== expectedFrom)
				throw new TrackingValidationError(
					`Serial unit ${row.id} is ${row.status}, expected ${expectedFrom} for this movement`,
				);
			if (m.from_location_type === "vehicle" && row.current_vehicle_id !== (m.from_vehicle_id ?? null))
				throw new TrackingValidationError(
					`Serial unit ${row.id} is not on vehicle ${m.from_vehicle_id}`,
				);
		}

		// Every surviving row gets an identical payload (derived from the movement,
		// not per-row) — collapse the writes into a single updateMany.
		await tx.serial_unit.updateMany({
			where: { id: { in: rows.map((row) => row.id) } },
			data: {
				status: toStatus,
				current_vehicle_id: toVehicle,
				...(isReversal
					? { consumed_at: null, consumed_visit_id: null, consumed_line_item_id: null, client_id: null }
					: toStatus === "consumed"
						? {
								consumed_at: new Date(),
								consumed_visit_id: m.visit_id ?? null,
								consumed_line_item_id: m.visit_line_item_id ?? null,
								client_id: clientId,
							}
						: {}),
			},
		});
		for (const row of rows) {
			touched.push({ id: row.id, batch_id: row.batch_id });
		}
	}

	// Emit serial-join rows + tally batches.
	for (const t of touched) {
		result.movementSerials.push({ movement_id: m._id, serial_unit_id: t.id });
		if (t.batch_id) batchTally.set(t.batch_id, (batchTally.get(t.batch_id) ?? 0) + 1);
	}

	return [...batchTally.entries()].map(([batch_id, qty]) => ({ batch_id, qty: new Prisma.Decimal(qty) }));
}

async function resolveClientId(tx: TransactionClient, visitId?: string): Promise<string | null> {
	if (!visitId) return null;
	const visit = await tx.job_visit.findUnique({
		where: { id: visitId },
		select: { job: { select: { client_id: true } } },
	});
	return visit?.job?.client_id ?? null;
}

// ── Batch effects ─────────────────────────────────────────────────────────────

const RECEIVE_REASONS = new Set(["receive", "initial", "supplier_purchase"]);

/**
 * A recalled lot may only move *out* of circulation: back to the warehouse, written
 * off to an adjustment, or returned to the supplier (external). Anything that puts it
 * on a truck, consumes it on a job, or receives more of it is rejected.
 *
 * Derived from the movement's shape rather than passed in by the caller — the call
 * sites are exactly where the recall check drifted before.
 */
function allowsRecalledLot(m: TrackedMovement): boolean {
	if (RECEIVE_REASONS.has(m.reason)) return false;
	return m.to_location_type !== "vehicle" && m.to_location_type !== "consumed";
}

/**
 * The tracking invariant for every explicit or derived batch pick: the lot exists,
 * belongs to this org AND this inventory item, and is not recalled (unless the
 * movement is taking it out of circulation). autoAllocateFifo enforced this via its
 * candidate query; explicit picks bypassed it entirely, which is the bug class this
 * choke point closes.
 */
async function loadBatchForMovement(
	tx: TransactionClient,
	organizationId: string,
	m: TrackedMovement,
	batchId: string,
): Promise<{ code?: string | null; recalled_at: Date | null; qty_in_warehouse: Prisma.Decimal }> {
	const batch = await tx.stock_batch.findFirst({
		where: { id: batchId, organization_id: organizationId, inventory_item_id: m.inventory_item_id },
		select: { code: true, inventory_item_id: true, recalled_at: true, qty_in_warehouse: true },
	});
	if (!batch)
		throw new TrackingValidationError(
			`Batch ${batchId} not found for item ${m.inventory_item_id} in this organization`,
		);

	if (batch.inventory_item_id !== m.inventory_item_id)
		throw new TrackingValidationError(
			`Lot ${batch.code ?? batchId} belongs to a different inventory item and cannot be allocated to item ${m.inventory_item_id}`,
		);

	if (batch.recalled_at && !allowsRecalledLot(m))
		throw new TrackingValidationError(
			`Lot ${batch.code ?? batchId} was recalled on ${batch.recalled_at.toISOString().slice(0, 10)} and cannot be issued`,
		);

	return batch;
}

/**
 * The one seam every batch allocation flows through — explicit picks, FIFO picks, and
 * the allocations derived from a serialized unit's batch_id alike. Validates the lot
 * (see loadBatchForMovement), applies batch cache deltas mirroring the item/vehicle
 * deltas, and emits stock_movement_batch join rows. Guards warehouse + vehicle
 * batch underflow.
 */
async function applyBatchAllocations(
	tx: TransactionClient,
	organizationId: string,
	m: TrackedMovement,
	allocs: { batch_id: string; qty: Prisma.Decimal }[],
	result: ApplyTrackingResult,
	opts: ApplyTrackingOpts,
): Promise<void> {
	const isReceive = RECEIVE_REASONS.has(m.reason);

	for (const a of allocs) {
		const batch = await loadBatchForMovement(tx, organizationId, m, a.batch_id);

		const fromWarehouse = m.from_location_type === "warehouse";
		const toWarehouse = m.to_location_type === "warehouse";

		if (fromWarehouse || toWarehouse) {
			const delta = toWarehouse ? a.qty : a.qty.negated();
			const projected = new Prisma.Decimal(batch.qty_in_warehouse).plus(delta);
			if (!opts.allowNegative && projected.lessThan(0))
				throw new InsufficientBatchStockError({ [a.batch_id]: Number(batch.qty_in_warehouse) });
			await tx.stock_batch.update({
				where: { id: a.batch_id },
				data: {
					qty_in_warehouse: { increment: delta },
					...(isReceive && toWarehouse ? { qty_received: { increment: a.qty } } : {}),
				},
			});
		}

		if (m.from_location_type === "vehicle" && m.from_vehicle_id) {
			await decrementVehicleBatch(tx, m.from_vehicle_id, a.batch_id, a.qty, opts);
		}
		if (m.to_location_type === "vehicle" && m.to_vehicle_id) {
			await tx.vehicle_stock_batch.upsert({
				where: { vehicle_id_batch_id: { vehicle_id: m.to_vehicle_id, batch_id: a.batch_id } },
				create: { vehicle_id: m.to_vehicle_id, batch_id: a.batch_id, qty_on_hand: a.qty },
				update: { qty_on_hand: { increment: a.qty } },
			});
		}

		result.movementBatches.push({ movement_id: m._id, batch_id: a.batch_id, qty: a.qty });
	}
}

async function decrementVehicleBatch(
	tx: TransactionClient,
	vehicleId: string,
	batchId: string,
	qty: Prisma.Decimal,
	opts: ApplyTrackingOpts,
): Promise<void> {
	const row = await tx.vehicle_stock_batch.findFirst({
		where: { vehicle_id: vehicleId, batch_id: batchId },
		select: { id: true, qty_on_hand: true },
	});
	const available = row ? new Prisma.Decimal(row.qty_on_hand) : new Prisma.Decimal(0);
	if (!opts.allowNegative && available.lessThan(qty))
		throw new InsufficientBatchStockError({ [batchId]: Number(available) });
	if (row) {
		await tx.vehicle_stock_batch.update({
			where: { id: row.id },
			data: { qty_on_hand: { increment: qty.negated() } },
		});
	} else {
		await tx.vehicle_stock_batch.create({
			data: { vehicle_id: vehicleId, batch_id: batchId, qty_on_hand: qty.negated() },
		});
	}
}

/** FIFO auto-allocation for a deduction with no explicit picks. */
async function autoAllocateFifo(
	tx: TransactionClient,
	organizationId: string,
	m: TrackedMovement,
	opts: ApplyTrackingOpts,
): Promise<{ batch_id: string; qty: Prisma.Decimal }[]> {
	if (RECEIVE_REASONS.has(m.reason))
		throw new TrackingValidationError(
			`Receiving into a batch-tracked item ${m.inventory_item_id} must name a batch`,
		);
	if (!isDeduction(m)) return [];

	let remaining = new Prisma.Decimal(m.qty);
	const picks: { batch_id: string; qty: Prisma.Decimal }[] = [];

	if (m.from_location_type === "warehouse") {
		const batches = await tx.stock_batch.findMany({
			where: {
				organization_id: organizationId,
				inventory_item_id: m.inventory_item_id,
				recalled_at: null,
				qty_in_warehouse: { gt: 0 },
			},
			orderBy: [{ received_at: "asc" }, { id: "asc" }],
			select: { id: true, qty_in_warehouse: true },
		});
		for (const b of batches) {
			if (remaining.lessThanOrEqualTo(0)) break;
			const take = Prisma.Decimal.min(remaining, new Prisma.Decimal(b.qty_in_warehouse));
			picks.push({ batch_id: b.id, qty: take });
			remaining = remaining.minus(take);
		}
	} else {
		// from vehicle — FIFO across the truck's batches OF THIS ITEM by batch
		// received_at. vehicle_stock_batch has no item column of its own, so the
		// item filter must go through the batch relation; without it a truck
		// carrying lots of two batch-tracked items hands item B's deduction to
		// item A's older lot (then fails loadBatchForMovement's item check).
		const rows = await tx.vehicle_stock_batch.findMany({
			where: {
				vehicle_id: m.from_vehicle_id,
				qty_on_hand: { gt: 0 },
				batch: { inventory_item_id: m.inventory_item_id, recalled_at: null },
			},
			orderBy: [{ batch: { received_at: "asc" } }, { batch_id: "asc" }],
			select: { batch_id: true, qty_on_hand: true },
		});
		for (const r of rows) {
			if (remaining.lessThanOrEqualTo(0)) break;
			const take = Prisma.Decimal.min(remaining, new Prisma.Decimal(r.qty_on_hand));
			picks.push({ batch_id: r.batch_id, qty: take });
			remaining = remaining.minus(take);
		}
	}

	if (remaining.greaterThan(0)) {
		if (!opts.allowNegative)
			throw new InsufficientBatchStockError({
				[m.inventory_item_id]: Number(new Prisma.Decimal(m.qty).minus(remaining)),
			});

		// Shortfall permitted: charge it to a batch so the allocation still sums to
		// m.qty. Keep draining the last lot we already picked from, negative;
		// if nothing had any stock at all, fall back to the oldest non-recalled
		// lot for this item/vehicle so the movement still has somewhere to post.
		const last = picks[picks.length - 1];
		if (last) {
			last.qty = last.qty.plus(remaining);
		} else {
			const sinkBatchId = await findSinkBatch(tx, organizationId, m);
			if (!sinkBatchId)
				throw new TrackingValidationError(
					`Batch-tracked item ${m.inventory_item_id} has no batch to allocate the shortfall against`,
				);
			picks.push({ batch_id: sinkBatchId, qty: remaining });
		}
		remaining = new Prisma.Decimal(0);
	}

	return picks;
}

/**
 * Oldest non-recalled lot to charge a negative shortfall against when every
 * candidate batch is already at zero (so the FIFO loop above picked nothing).
 */
async function findSinkBatch(
	tx: TransactionClient,
	organizationId: string,
	m: TrackedMovement,
): Promise<string | null> {
	if (m.from_location_type === "warehouse") {
		const batch = await tx.stock_batch.findFirst({
			where: { organization_id: organizationId, inventory_item_id: m.inventory_item_id, recalled_at: null },
			orderBy: [{ received_at: "asc" }, { id: "asc" }],
			select: { id: true },
		});
		return batch?.id ?? null;
	}
	const row = await tx.vehicle_stock_batch.findFirst({
		where: {
			vehicle_id: m.from_vehicle_id,
			batch: { inventory_item_id: m.inventory_item_id, recalled_at: null },
		},
		orderBy: [{ batch: { received_at: "asc" } }, { batch_id: "asc" }],
		select: { batch_id: true },
	});
	return row?.batch_id ?? null;
}

// ── Lock-target collection ────────────────────────────────────────────────────

async function collectLockTargets(
	tx: TransactionClient,
	organizationId: string,
	flags: Map<string, ItemTrackingFlags>,
	movements: TrackedMovement[],
): Promise<{ batchIds: string[]; serialIds: string[] }> {
	const batchIds = new Set<string>();
	const serialIds = new Set<string>();

	for (const m of movements) {
		const f = flags.get(m.inventory_item_id);
		if (!f) continue;
		for (const id of m.serial?.unit_ids ?? []) serialIds.add(id);
		for (const a of m.batch_allocations ?? []) batchIds.add(a.batch_id);

		// Serialized + batch-tracked: applySerialMovement derives batch allocations from
		// each unit's batch_id, so those stock_batch rows are mutated too and must be in
		// the lock set. Costs one extra read of rows applySerialMovement re-reads later;
		// the lock-order contract is worth more than the query.
		if (f.is_serialized && f.is_batch_tracked) {
			for (const c of m.serial?.create ?? []) if (c.batch_id) batchIds.add(c.batch_id);
			const unitIds = m.serial?.unit_ids ?? [];
			if (unitIds.length > 0) {
				const rows = await tx.serial_unit.findMany({
					where: {
						id: { in: unitIds },
						organization_id: organizationId,
						inventory_item_id: m.inventory_item_id,
					},
					select: { batch_id: true },
				});
				for (const r of rows) if (r.batch_id) batchIds.add(r.batch_id);
			}
		}

		// FIFO candidates for batch-only deductions without explicit picks.
		if (f.is_batch_tracked && !m.batch_allocations?.length && isDeduction(m)) {
			if (m.from_location_type === "warehouse") {
				const rows = await tx.stock_batch.findMany({
					where: {
						organization_id: organizationId,
						inventory_item_id: m.inventory_item_id,
						recalled_at: null,
						qty_in_warehouse: { gt: 0 },
					},
					select: { id: true },
				});
				for (const r of rows) batchIds.add(r.id);
			} else if (m.from_vehicle_id) {
				// Same item + recall predicate as autoAllocateFifo's candidate query,
				// so the lock set is exactly the rows FIFO may pick.
				const rows = await tx.vehicle_stock_batch.findMany({
					where: {
						vehicle_id: m.from_vehicle_id,
						qty_on_hand: { gt: 0 },
						batch: { inventory_item_id: m.inventory_item_id, recalled_at: null },
					},
					select: { batch_id: true },
				});
				for (const r of rows) batchIds.add(r.batch_id);
			}
		}
	}

	return {
		batchIds: [...batchIds].sort(),
		serialIds: [...serialIds].sort(),
	};
}
