import { z, ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { logActivity, buildChanges } from "../services/logger.js";
import { db } from "../db.js";
import { getScopedDb, UserContext } from "../lib/context.js";
import { resolveSupplier, SupplierValidationError } from "../services/suppliers.js";
import { supplierCaptureFields } from "../lib/validate/suppliers.js";
import { utcDayRange, localDateString } from "../lib/dayRange.js";
import {
	recordMovements,
	lockInventoryRows,
	InsufficientStockError,
	InsufficientBatchStockError,
	TrackingValidationError,
	getOrCreateBatch,
	buildTrackingInputs,
	type ActorInfo,
	type MovementInput,
	type ItemTrackingFlags,
	type TrackingReasonCode,
	type ResolvedTrackingLine,
} from "../services/stockMovements.js";
import { fireLowStockAlerts } from "../services/lowStockAlerts.js";
import { expiresAtField } from "../lib/validate/inventoryTracking.js";
import { READINESS_LINE_ITEM_WHERE } from "../lib/inventory.js";
import { isStorableStockQty, STOCK_QTY_MESSAGE } from "../lib/validate/shared.js";
import { emitInventoryUpdated } from "../services/socketService.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import {
	mapVehicleStockItemWithInventory,
	mapRestockHistoryRecord,
	mapStockAdjustmentRecord,
	mapRestockRequest,
	mapStockMovement,
	mapMaintenanceRecord,
	mapMaintenanceReminder,
} from "../types/dto/vehicles.js";
import { createMaintenanceRecordSchema, createMaintenanceReminderSchema, updateMaintenanceRecordSchema, updateMaintenanceReminderSchema } from "../lib/validate/vehicles.js";
import { classifyReminder, resolveDueTargets } from "../lib/validate/vehicleMaintenanceStatus.js";
import { applyRecordOdometer } from "../lib/vehicleMileage.js";
import { parentBreadcrumb } from "./logsController.js";
import { notifyDispatchers } from "./notificationsController.js";

// Stock-item quantities nested under a restock request only carry a partial
// inventory_item select (id/name/unit/quantity, no Decimal fields) — convert
// just the Decimal quantities here rather than the full DTO mapper, which
// expects a complete inventory_item to map.
function mapStockItemForRequest<T extends { qty_on_hand: unknown; qty_min: unknown; qty_standard: unknown }>(
	stockItem: T,
): Omit<T, "qty_on_hand" | "qty_min" | "qty_standard"> & {
	qty_on_hand: number;
	qty_min: number;
	qty_standard: number | null;
} {
	return {
		...stockItem,
		qty_on_hand: Number(stockItem.qty_on_hand),
		qty_min: Number(stockItem.qty_min),
		qty_standard: stockItem.qty_standard == null ? null : Number(stockItem.qty_standard),
	};
}

export type ReadinessState = "not_applicable" | "unknown" | "auto_ready" | "needs_action" | "confirmed";

export type ReadinessGap = {
	inventory_item_id: string;
	name: string;
	qty_needed: number;
	qty_on_hand: number;
	gap: number;
	visit_ids: string[];
};

export type ReadinessResult = {
	state: ReadinessState;
	date: string;
	gaps: ReadinessGap[];
	confirmed?: {
		id: string;
		confirmed_by: string;
		confirmed_by_type: "dispatcher" | "technician" | "restock_auto";
		confirmed_at: string;
		notes: string | null;
	};
};

function toActor(context?: UserContext): ActorInfo {
	return {
		actor_type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
		actor_id: context?.techId || context?.dispatcherId,
	};
}

function getActorInfo(context?: UserContext) {
	return { ...toActor(context), ip_address: context?.ipAddress, user_agent: context?.userAgent };
}

function formatZodError(e: ZodError): string {
	return e.issues.map((i) => i.message).join(", ");
}

/**
 * Shared catch-block handling for the tracking errors (InsufficientBatchStockError,
 * TrackingValidationError) that applyFill / completeRestock / adjustStock / addPartsUsed /
 * all surface the same way. Returns null when `e` isn't one of these,
 * so callers fall through to their own remaining checks.
 */
function trackingErrorResponse(e: unknown): { err: string; available?: Record<string, number> } | null {
	if (e instanceof InsufficientBatchStockError) {
		return { err: "insufficient_batch_stock", available: e.available };
	}
	if (e instanceof TrackingValidationError || e instanceof SupplierValidationError) {
		return { err: e.message };
	}
	return null;
}

async function requireVehicle(
	sdb: ReturnType<typeof getScopedDb>,
	vehicleId: string,
): Promise<string | null> {
	const v = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	return v ? null : "Vehicle not found";
}

// ── Return type helpers ───────────────────────────────────────────────────────

interface RestockRequestRow {
	id: string;
	organization_id: string;
	stock_item_id: string;
	technician_id: string;
	qty_requested: number | null;
	note: string | null;
	status: string;
	created_at: string;
	stock_item: {
		id: string;
		inventory_item: { id: string; name: string; unit: string; quantity: unknown };
		vehicle: { id: string; name: string };
	} | null;
	technician: { id: string; name: string } | null;
}

interface RestockHistoryRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	completed_at: string;
	mode: string;
	notes: string | null;
	restock_lines: { id: string; stock_item_id: string; qty_restocked: number; qty_shortfall: number }[];
	completed_by: { id: string; name: string } | null;
	completed_by_tech: { id: string; name: string } | null;
}

interface StockAdjustmentRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	type: string;
	note: string | null;
	created_at: string;
	lines: { id: string; stock_item_id: string; qty_before: number; qty_after: number; inventory_impact: number }[];
	created_by: { id: string; name: string } | null;
	created_by_tech: { id: string; name: string } | null;
}

type RestockRecord = Prisma.vehicle_restock_recordGetPayload<{
	include: {
		restock_lines: true;
		completed_by: { select: { id: true; name: true } };
		completed_by_tech: { select: { id: true; name: true } };
	}
}>;

// ── Tracking line detail (Phase 2b: 2026-07-14 audit-fixes plan) ─────────────
//
// completeRestock / applyFill both call buildTrackingInputs (Task 1) and, on
// success, need to tell the dispatcher/tech what actually happened per line —
// not just requested/moved/short, but *why* a line came up short and which
// physical units/lots moved. `reason_code` is Task 1's TrackingReasonCode
// as-shipped (do not rename/extend it — reviewed and approved); `message` is
// built here in the controller, per the plan's guidance, not in the helper.

/** Shared response shape for both completeRestock's sibling array and applyFill's extended line. */
export interface RestockLineDetail {
	stock_item_id: string;
	reason_code: TrackingReasonCode;
	message?: string;
	/** Serial codes that moved, for serialized lines (explicit scans only — these two callers never create new serials). */
	serial_codes?: string[];
	/** Lot codes that moved, for batch-tracked lines (explicit picks or FIFO auto-allocation). */
	lot_codes?: string[];
}

function trackingLineMessage(
	reasonCode: TrackingReasonCode,
	requested: number,
	moved: number,
): string | undefined {
	if (reasonCode === "no_tracking_gap") {
		return "No units scanned — recorded as a tracking gap; verify what actually went out.";
	}
	if (reasonCode === "cache_drift_detected") {
		return "Scanned/lot quantity did not match the cached stock count — investigate a possible data drift.";
	}
	// reasonCode === "ok" — Task 1 review Finding B: a batch-tracked edge case can
	// report "ok" with a real shortfall against genuine lot availability, so
	// shortfall (not reasonCode) is what decides whether there's a message here.
	return moved < requested ? `Only ${moved} of ${requested} available in the warehouse.` : undefined;
}

/**
 * A line needs dispatcher/tech attention whenever it came up short OR its
 * reasonCode flags something noteworthy — independently of each other.
 * reasonCode === "ok" does NOT imply "nothing to show" (Task 1 review Finding B).
 */
function trackingNeedsAttention(reasonCode: TrackingReasonCode, shortfall: number): boolean {
	return shortfall > 0 || reasonCode !== "ok";
}

/**
 * Resolves human-readable codes for lines where the caller supplied explicit
 * serial_unit_ids / batch_picks — one batched query each, across all lines,
 * rather than a query per line.
 */
async function resolveExplicitTrackingCodes(
	tx: Prisma.TransactionClient,
	lines: Pick<ResolvedTrackingLine, "tracking">[],
): Promise<{ serialCodeById: Map<string, string>; batchCodeById: Map<string, string> }> {
	const serialIds = new Set<string>();
	const batchIds = new Set<string>();
	for (const l of lines) {
		for (const id of l.tracking.serial?.unit_ids ?? []) serialIds.add(id);
		for (const a of l.tracking.batch_allocations ?? []) batchIds.add(a.batch_id);
	}
	const [serialRows, batchRows] = await Promise.all([
		serialIds.size
			? tx.serial_unit.findMany({ where: { id: { in: [...serialIds] } }, select: { id: true, code: true } })
			: Promise.resolve([] as { id: string; code: string }[]),
		batchIds.size
			? tx.stock_batch.findMany({ where: { id: { in: [...batchIds] } }, select: { id: true, code: true } })
			: Promise.resolve([] as { id: string; code: string }[]),
	]);
	return {
		serialCodeById: new Map(serialRows.map((r) => [r.id, r.code])),
		batchCodeById: new Map(batchRows.map((r) => [r.id, r.code])),
	};
}

/**
 * Lot codes for batch-tracked lines that went through with NO explicit picks
 * (FIFO auto-allocation — decided later, inside recordMovements -> applyTracking,
 * which this function never touches or threads a signature change through).
 * Read-after-write: the movement rows recordMovements just created inside this
 * same transaction are the only record of which lot(s) FIFO chose.
 */
async function resolveFifoLotCodes(
	tx: Prisma.TransactionClient,
	where: Prisma.stock_movementWhereInput,
): Promise<Map<string, string[]>> {
	const rows = await tx.stock_movement.findMany({
		where,
		select: { inventory_item_id: true, movement_batches: { select: { batch: { select: { code: true } } } } },
	});
	const byItem = new Map<string, string[]>();
	for (const row of rows) {
		if (row.movement_batches.length === 0) continue;
		const codes = byItem.get(row.inventory_item_id) ?? [];
		for (const mb of row.movement_batches) codes.push(mb.batch.code);
		byItem.set(row.inventory_item_id, codes);
	}
	return byItem;
}

/**
 * Serial/lot codes that actually moved for a set of resolved tracking lines —
 * shared by applyFill and completeRestock (Phase 2b). Explicit picks resolve
 * straight from buildTrackingInputs's output; FIFO auto-allocated batch lines
 * (no explicit picks) resolve via a read-after-write on EXACTLY the movement
 * rows recordMovements just wrote (`movementIds` it returns) — no wall-clock
 * `created_at` filter, so a DB/app clock skew can't silently drop lot codes.
 * Returns a per-line map keyed by index into `resolvedLines`.
 */
async function resolveMovedTrackingCodes(
	tx: Prisma.TransactionClient,
	resolvedLines: ResolvedTrackingLine[],
	flags: Map<string, ItemTrackingFlags>,
	movementIds: string[],
): Promise<Map<number, { serial_codes?: string[]; lot_codes?: string[] }>> {
	const { serialCodeById, batchCodeById } = await resolveExplicitTrackingCodes(tx, resolvedLines);
	const fifoItemIds = [
		...new Set(
			resolvedLines
				.filter(
					(r) =>
						flags.get(r.inventory_item_id)?.is_batch_tracked &&
						r.qty > 0 &&
						!r.tracking.batch_allocations?.length,
				)
				.map((r) => r.inventory_item_id),
		),
	];
	const fifoLotCodesByItem =
		fifoItemIds.length && movementIds.length
			? await resolveFifoLotCodes(tx, { id: { in: movementIds }, inventory_item_id: { in: fifoItemIds } })
			: new Map<string, string[]>();

	const byIndex = new Map<number, { serial_codes?: string[]; lot_codes?: string[] }>();
	resolvedLines.forEach((r, i) => {
		const out: { serial_codes?: string[]; lot_codes?: string[] } = {};
		const serialIds = r.tracking.serial?.unit_ids;
		if (serialIds?.length) {
			const codes = serialIds.map((id) => serialCodeById.get(id)).filter((c): c is string => !!c);
			if (codes.length) out.serial_codes = codes;
		}
		const explicitLots = r.tracking.batch_allocations
			?.map((a) => batchCodeById.get(a.batch_id))
			.filter((c): c is string => !!c);
		const lots = explicitLots?.length ? explicitLots : fifoLotCodesByItem.get(r.inventory_item_id);
		if (lots?.length) out.lot_codes = [...new Set(lots)];
		byIndex.set(i, out);
	});
	return byIndex;
}

/**
 * Loads is_serialized/is_batch_tracked flags for a set of inventory items,
 * keyed by id — shared by applyFill, completeRestock, and adjustStock.
 */
async function loadTrackingFlags(
	tx: Prisma.TransactionClient,
	itemIds: string[],
): Promise<Map<string, ItemTrackingFlags>> {
	const flagRows = itemIds.length
		? await tx.inventory_item.findMany({
				where: { id: { in: itemIds } },
				select: { id: true, is_serialized: true, is_batch_tracked: true },
			})
		: [];
	return new Map<string, ItemTrackingFlags>(
		flagRows.map((r: { id: string; is_serialized: boolean; is_batch_tracked: boolean }) => [
			r.id,
			{ is_serialized: r.is_serialized, is_batch_tracked: r.is_batch_tracked },
		]),
	);
}

/** Serial/batch tracking to splice into a MovementInput for a single resolved line. */
type LineTracking = { serial?: MovementInput["serial"]; batch_allocations?: MovementInput["batch_allocations"] };

// ── Validation schemas ────────────────────────────────────────────────────────

// Stock quantities are numeric(10,2) everywhere (see lib/validate/shared.ts):
// bound them here so a third decimal or an overflow is a clean 400 rather than
// an opaque error from recordMovements or Postgres. Takes the base number
// schema because .refine() yields a ZodEffects that loses .min()/.positive().
const stockQtyField = (base: z.ZodNumber) => base.refine(isStorableStockQty, STOCK_QTY_MESSAGE);

const createVehicleSchema = z.object({
	name:          z.string().min(1).max(100),
	type:          z.string().min(1).max(50),
	license_plate: z.string().min(1).max(50),
	year:          z.number().int().min(1900).max(2100).nullable().optional(),
	make:          z.string().max(50).nullable().optional(),
	model:         z.string().max(50).nullable().optional(),
	color:         z.string().max(50).nullable().optional(),
	status:        z.enum(["active", "inactive"]).default("active"),
	notes:         z.string().max(1000).nullable().optional(),
	current_odometer_mi: z.number().int().min(0).nullable().optional(),
	stored_at: z.string().nullable().optional(),
	stored_at_coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.nullable()
		.optional()
		// Prisma Json columns reject plain null
		.transform((v) => (v === null ? Prisma.DbNull : v)),
});

const updateVehicleSchema = createVehicleSchema.partial();

const addStockItemSchema = z.object({
	inventory_item_id: z.string().uuid(),
	qty_on_hand:       stockQtyField(z.number().min(0)).default(0),
	qty_min:           stockQtyField(z.number().min(0)).default(0),
	qty_standard:      stockQtyField(z.number().min(0)).nullable().optional(),
});

const updateStockItemSchema = z.object({
	qty_on_hand:  stockQtyField(z.number().min(0)).optional(),
	qty_min:      stockQtyField(z.number().min(0)).optional(),
	qty_standard: stockQtyField(z.number().min(0)).nullable().optional(),
});

const restockRequestSchema = z.object({
	qty_requested: z.number().positive().nullable().optional(),
	note:          z.string().max(500).nullable().optional(),
});

const completeRestockSchema = z.object({
	notes: z.string().max(500).nullable().optional(),
	mode: z.enum(["restock", "prepare"]).optional().default("restock"),
	restock_lines: z
		.array(
			z.object({
				stock_item_id:  z.string().uuid(),
				qty_to_restock: z.number().int().min(0),
				// Serial/batch tracking (B-T4) — optional pass-through; a technician who
				// scans supplies real per-unit/lot tracking, otherwise the movement goes
				// through untracked (allowUntracked) and records a gap instead of blocking.
				serial_unit_ids: z.array(z.string().uuid()).optional(),
				batch_picks:     z
					.array(z.object({ batch_id: z.string().uuid(), qty: stockQtyField(z.number().positive()) }))
					.optional(),
			}),
		)
		.refine(
			(lines) => new Set(lines.map((l) => l.stock_item_id)).size === lines.length,
			{ message: "Duplicate stock_item_id entries are not allowed" },
		),
});

// Single source of truth — prevents silent divergence from the Prisma enum
// `supplier_purchase` is deliberately absent: buying externally is a field
// purchase now, which carries a grant, a limit, a receipt and a review. It stays
// in the Prisma enum so historical adjustments still read.
export const ADJUSTMENT_TYPES = ["warehouse_exchange", "field_loss", "transfer", "audit"] as const;
export type VehicleAdjustmentType = typeof ADJUSTMENT_TYPES[number];

const adjustStockSchema = z
	.object({
		type: z.enum(ADJUSTMENT_TYPES),
		note: z.string().max(500).nullable().optional(),
		// Transfer counterparty — when set, transfer adjustments move stock
		// vehicle↔vehicle instead of vehicle↔adjustment
		target_vehicle_id: z.string().uuid().optional(),
		lines: z
			.array(
				z
					.object({
						stock_item_id:     z.string().uuid().optional(),
						inventory_item_id: z.string().uuid().optional(),
						qty_after:         stockQtyField(z.number().min(0)),
						// Serial/batch tracking (B-T3) — which fields apply depends on the
						// resolved item's is_serialized/is_batch_tracked flags, which Zod
						// can't see; the controller validates that once the item is loaded.
						serial_unit_ids: z.array(z.string().uuid()).optional(),
						batch_picks:     z
							.array(z.object({ batch_id: z.string().uuid(), qty: stockQtyField(z.number().positive()) }))
							.optional(),
					})
					.refine(
						(l) => (l.stock_item_id ? 1 : 0) + (l.inventory_item_id ? 1 : 0) === 1,
						{ message: "Each line needs exactly one of stock_item_id or inventory_item_id" },
					),
			)
			.min(1, "At least one line required")
			.refine(
				(lines) => {
					const ids = lines.map((l) => l.stock_item_id ?? l.inventory_item_id);
					return new Set(ids).size === ids.length;
				},
				{ message: "Duplicate line entries are not allowed" },
			),
	})
	.superRefine((data, ctx) => {
		// No whole-number rule for warehouse_exchange: inventory_item.quantity is
		// numeric(10,2) like every other qty column, so a fractional target is a
		// perfectly storable warehouse movement (qty_after above bounds it to 2 dp).
		//
		// Naming a catalog item rather than an existing stock row only means
		// something when stock moves to or from the warehouse.
		if (data.type !== "warehouse_exchange") {
			data.lines.forEach((line, i) => {
				if (line.inventory_item_id) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						path: ["lines", i, "inventory_item_id"],
						message: "Adding a new item is only allowed for warehouse exchange",
					});
				}
			});
		}
	});

// ── Vehicle CRUD ──────────────────────────────────────────────────────────────

export const listVehicles = async (organizationId: string, status?: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.vehicle.findMany({
		where: {
			...(status && { status }),
		},
		include: {
			stock_items: {
				include: { inventory_item: true },
			},
			current_technicians: {
				select: { id: true, name: true },
			},
		},
		orderBy: { name: "asc" },
	});
};

export const getVehicleById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.vehicle.findFirst({
		where: { id },
		include: {
			stock_items: {
				include: { inventory_item: true },
				orderBy: [
					{ inventory_item: { category: "asc" } },
					{ inventory_item: { name: "asc" } },
				],
			},
			current_technicians: {
				select: { id: true, name: true },
			},
		},
	});
};

export const createVehicle = async (data: unknown, organizationId: string, context?: UserContext) => {
	try {
		const parsed = createVehicleSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const vehicle = await sdb.vehicle.create({
			data: {
				...parsed,
				organization_id: organizationId,
				...(parsed.current_odometer_mi != null ? { odometer_updated_at: new Date() } : {}),
			},
		});
		await logActivity({
			event_type: "vehicle.created",
			action: "created",
			entity_type: "vehicle",
			entity_id: vehicle.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				name:          { old: null, new: vehicle.name },
				type:          { old: null, new: vehicle.type },
				license_plate: { old: null, new: vehicle.license_plate },
				status:        { old: null, new: vehicle.status },
				stored_at: 	   { old: null, new: vehicle.stored_at },
			},
		});
		return { err: "", item: vehicle };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		log.error({ err: e }, "Failed to create vehicle");
		return { err: "Failed to create vehicle" };
	}
};

export const updateVehicle = async (id: string, data: unknown, organizationId: string, context?: UserContext) => {
	try {
		const parsed = updateVehicleSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.vehicle.findFirst({ where: { id } });
		if (!existing) return { err: "Vehicle not found" };
		const vehicle = await sdb.vehicle.update({
			where: { id },
			data: {
				...parsed,
				...(parsed.current_odometer_mi != null ? { odometer_updated_at: new Date() } : {})
			}
		});
		await logActivity({
			event_type: "vehicle.updated",
			action: "updated",
			entity_type: "vehicle",
			entity_id: vehicle.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: buildChanges(existing, parsed, [
				"name", "type", "license_plate", "year", "make",
				"model", "color", "status", "notes", "current_odometer_mi", "stored_at"
			] as const),
		});
		return { err: "", item: vehicle };
	} catch (e: unknown) {
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return { err: "Vehicle not found" };
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		log.error({ err: e }, "Failed to update vehicle");
		return { err: "Failed to update vehicle" };
	}
};

// ── Vehicle Stock ─────────────────────────────────────────────────────────────

export const listVehicleStock = async (vehicleId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found", items: null };

	const items = await sdb.vehicle_stock_item.findMany({
		where: { vehicle_id: vehicleId },
		include: { inventory_item: true },
		orderBy: [
			{ inventory_item: { category: "asc" } },
			{ inventory_item: { name: "asc" } },
		],
	});
	return { err: "", items: items.map(mapVehicleStockItemWithInventory) };
};

export const addVehicleStockItem = async (vehicleId: string, data: unknown, organizationId: string, context?: UserContext) => {
	try {
		const parsed = addStockItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
		if (!vehicle) return { err: "Vehicle not found" };

		const invItem = await sdb.inventory_item.findFirst({ where: { id: parsed.inventory_item_id } });
		if (!invItem) return { err: "Inventory item not found" };

		const existing = await sdb.vehicle_stock_item.findFirst({
			where: { vehicle_id: vehicleId, inventory_item_id: parsed.inventory_item_id },
		});
		if (existing) return { err: "This item is already in the vehicle's stock" };

		const item = await sdb.$transaction(async (tx) => {
			const created = await tx.vehicle_stock_item.create({
				data: {
					vehicle_id:        vehicleId,
					inventory_item_id: parsed.inventory_item_id,
					qty_on_hand:       0,
					qty_min:           parsed.qty_min,
					...(parsed.qty_standard != null && { qty_standard: parsed.qty_standard }),
				},
			});

			// Initial qty is ledgered as an audit correction (no warehouse impact —
			// matches prior UX where adding an item never deducted the warehouse)
			if (parsed.qty_on_hand > 0) {
				await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, toActor(context), [
					{
						inventory_item_id:  parsed.inventory_item_id,
						qty:                parsed.qty_on_hand,
						from_location_type: "adjustment",
						to_location_type:   "vehicle",
						to_vehicle_id:      vehicleId,
						reason:             "audit_correction",
						note:               "Initial quantity on stock item add",
					},
				]);
			}

			return tx.vehicle_stock_item.findUniqueOrThrow({
				where: { id: created.id },
				include: { inventory_item: true },
			});
		});
		await logActivity({
			event_type: "vehicle_stock.created",
			action: "created",
			entity_type: "vehicle_stock_item",
			entity_id: item.id,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				qty_on_hand: { old: null, new: item.qty_on_hand },
				qty_min:     { old: null, new: item.qty_min },
			},
		});
		return { err: "", item: mapVehicleStockItemWithInventory(item) };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		log.error({ err: e }, "Failed to add vehicle stock item");
		return { err: "Failed to add stock item" };
	}
};

export const updateVehicleStockItem = async (vehicleId: string, itemId: string, data: unknown, organizationId: string, context?: UserContext) => {
	try {
		const parsed = updateStockItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.vehicle_stock_item.findFirst({
			where: { id: itemId, vehicle_id: vehicleId },
		});
		if (!existing) return { err: "Stock item not found" };

		const item = await sdb.$transaction(async (tx) => {
			// qty_min / qty_standard are metadata — direct writes are fine.
			// qty_on_hand changes go through the ledger as audit corrections
			// (no warehouse impact — manual edit asserts physical truth).
			await tx.vehicle_stock_item.update({
				where: { id: itemId },
				data: {
					...(parsed.qty_min !== undefined && { qty_min: parsed.qty_min }),
					...(parsed.qty_standard !== undefined && { qty_standard: parsed.qty_standard }),
				},
			});

			const delta =
				parsed.qty_on_hand !== undefined
					? parsed.qty_on_hand - Number(existing.qty_on_hand)
					: 0;
			if (delta !== 0) {
				await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, toActor(context), [
					{
						inventory_item_id:  existing.inventory_item_id,
						qty:                Math.abs(delta),
						from_location_type: delta > 0 ? "adjustment" : "vehicle",
						from_vehicle_id:    delta > 0 ? undefined : vehicleId,
						to_location_type:   delta > 0 ? "vehicle" : "adjustment",
						to_vehicle_id:      delta > 0 ? vehicleId : undefined,
						reason:             "audit_correction",
						note:               "Manual stock edit",
					},
				]);
			}

			return tx.vehicle_stock_item.findUniqueOrThrow({
				where: { id: itemId },
				include: { inventory_item: true },
			});
		});
		const changes = buildChanges(existing, parsed as Record<string, unknown>, ["qty_on_hand", "qty_min", "qty_standard"] as const);
		if (Object.keys(changes).length > 0) {
			await logActivity({
				event_type: "vehicle_stock.updated",
				action: "updated",
				entity_type: "vehicle_stock_item",
				entity_id: itemId,
				organization_id: organizationId,
				...getActorInfo(context),
				changes,
			});
		}
		return { err: "", item: mapVehicleStockItemWithInventory(item) };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		log.error({ err: e }, "Failed to update vehicle stock item");
		return { err: "Failed to update stock item" };
	}
};

export const deleteVehicleStockItem = async (vehicleId: string, itemId: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.vehicle_stock_item.findFirst({
			where: { id: itemId, vehicle_id: vehicleId },
		});
		if (!existing) return { err: "Stock item not found" };

		await sdb.$transaction(async (tx) => {
			// Zero out remaining on-hand qty before deletion so the ledger stays
			// consistent — deleted rows leave no trace without this movement.
			const qty = Number(existing.qty_on_hand);
			if (qty > 0) {
				await recordMovements(tx as unknown as Prisma.TransactionClient, organizationId, toActor(context), [
					{
						inventory_item_id:  existing.inventory_item_id,
						qty,
						from_location_type: "vehicle",
						from_vehicle_id:    vehicleId,
						to_location_type:   "adjustment",
						reason:             "audit_correction",
						note:               "Stock item removed from vehicle",
					},
				]);
			}
			await tx.vehicle_stock_item.delete({ where: { id: itemId } });
		});

		await logActivity({
			event_type: "vehicle_stock.deleted",
			action: "deleted",
			entity_type: "vehicle_stock_item",
			entity_id: itemId,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: { ...parentBreadcrumb("vehicle", vehicleId) },
		});
		return { err: "" };
	} catch (e: unknown) {
		if (e instanceof InsufficientStockError) {
			return { err: "Stock quantity mismatch — run an audit adjustment before removing this item" };
		}
		log.error({ err: e }, "Failed to delete vehicle stock item");
		return { err: "Failed to delete stock item" };
	}
};

// Shared by the single and bulk restock request paths
async function notifyRestockRequested(vehicleId: string, orgId: string, count: number) {
	const vehicle = await db.vehicle.findFirst({ where: { id: vehicleId, organization_id: orgId }, select: { name: true } });
	await notifyDispatchers({
		type: "vehicle_restock_requested",
		title: `Restock requested — ${vehicle?.name ?? "a vehicle"}`,
		body: `${count} item${count === 1 ? "" : "s"} requested.`,
		actionUrl: `/dispatch/vehicles/${vehicleId}/stock`,
	}, orgId);
}

export const createRestockRequest = async (
	vehicleId: string,
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = restockRequestSchema.parse(data);

		const ownershipErr = await requireTechOnVehicle(vehicleId, organizationId, context);
		if (ownershipErr) return { err: ownershipErr };
		const technicianId = context?.techId;
		if (!technicianId) return { err: "Technician context required" };

		const stockItem = await db.vehicle_stock_item.findFirst({
			where: { id: itemId, vehicle_id: vehicleId, vehicle: { organization_id: organizationId } },
		});
		if (!stockItem) return { err: "Stock item not found" };

		// Best-effort dup guard — findFirst→create is not atomic; a partial unique
		// index on (stock_item_id) WHERE status='pending' would close the window
		const existing = await db.vehicle_restock_request.findFirst({
			where: { stock_item_id: itemId, status: "pending" },
		});
		if (existing) return { err: "Restock already requested for this item" };

		const request = await db.vehicle_restock_request.create({
			data: {
				organization_id: organizationId,
				stock_item_id:  itemId,
				technician_id:  technicianId,
				qty_requested:  parsed.qty_requested ?? null,
				note:           parsed.note ?? null,
				status:         "pending",
			},
		});
		await logActivity({
			event_type: "vehicle_restock.created",
			action: "created",
			entity_type: "vehicle_restock_request",
			entity_id: request.id,
			organization_id: organizationId,
			actor_type: "technician",
			actor_id: technicianId,
			changes: {
				qty_requested: { old: null, new: request.qty_requested },
				status:        { old: null, new: request.status },
			},
		});
		notifyRestockRequested(vehicleId, organizationId, 1).catch(() => {});
		return { err: "", item: request };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			return { err: "Restock already requested for this item" };
		}
		log.error({ err: e }, "Failed to create restock request");
		return { err: "Failed to create restock request" };
	}
};

const RESTOCK_BATCH_MAX = 50; // max items per bulk restock call

const bulkRestockRequestSchema = z.object({
	items: z
		.array(
			z.object({
				stock_item_id: z.string().uuid(),
				qty_requested: z.number().positive().nullable().optional(),
				note:          z.string().max(500).nullable().optional(),
			}),
		)
		.min(1)
		.max(RESTOCK_BATCH_MAX)
		.refine(
			(items) => new Set(items.map((i) => i.stock_item_id)).size === items.length,
			{ message: "Duplicate stock_item_id entries are not allowed" },
		),
});

export async function createRestockRequestsBulk(
	vehicleId: string,
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{
	err?: string;
	created?: object[];
	skipped?: { stock_item_id: string; reason: string }[];
}> {
	try {
		const parsed = bulkRestockRequestSchema.parse(data);

		const ownershipErr = await requireTechOnVehicle(vehicleId, orgId, context);
		if (ownershipErr) return { err: ownershipErr };
		const technicianId = context?.techId;
		if (!technicianId) return { err: "Technician context required" };

		const result = await db.$transaction(async (tx) => {
			const ids = parsed.items.map((i) => i.stock_item_id);
			const stockItems = await tx.vehicle_stock_item.findMany({
				where: { id: { in: ids }, vehicle_id: vehicleId, vehicle: { organization_id: orgId } },
				select: { id: true },
			});
			const foundIds = new Set(stockItems.map((s: { id: string }) => s.id));

			const pending = await tx.vehicle_restock_request.findMany({
				where: { stock_item_id: { in: [...foundIds] }, status: "pending" },
				select: { stock_item_id: true },
			});
			const pendingIds = new Set(pending.map((p: { stock_item_id: string }) => p.stock_item_id));

			const skipped: { stock_item_id: string; reason: string }[] = [];
			const toCreate: {
				organization_id: string;
				stock_item_id: string;
				technician_id: string;
				qty_requested: number | null;
				note: string | null;
				status: string;
			}[] = [];
			for (const item of parsed.items) {
				if (pendingIds.has(item.stock_item_id)) {
					skipped.push({ stock_item_id: item.stock_item_id, reason: "already_pending" });
				} else if (!foundIds.has(item.stock_item_id)) {
					skipped.push({ stock_item_id: item.stock_item_id, reason: "not_found" });
				} else {
					toCreate.push({
						organization_id: orgId,
						stock_item_id: item.stock_item_id,
						technician_id: technicianId,
						qty_requested: item.qty_requested ?? null,
						note:          item.note ?? null,
						status:        "pending",
					});
				}
			}

			const created = toCreate.length
				? await tx.vehicle_restock_request.createManyAndReturn({ data: toCreate })
				: [];
			return { created, skipped };
		});

		if (result.created.length > 0) {
			await logActivity({
				event_type: "vehicle_restock.created",
				action: "created",
				entity_type: "vehicle_restock_request",
				entity_id: vehicleId, // batch — keyed to the vehicle
				organization_id: orgId,
				actor_type: "technician",
				actor_id: technicianId,
				changes: { batch_count: { old: null, new: result.created.length } },
			});
			notifyRestockRequested(vehicleId, orgId, result.created.length).catch(() => {});
		}
		return { err: "", created: result.created, skipped: result.skipped };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
			return { err: "Restock already requested for one or more items" };
		}
		log.error({ err: e }, "Failed to create restock requests");
		return { err: "Failed to create restock requests" };
	}
}

// ── Restock request lifecycle (list / fulfill / dismiss) ──────────────────────

async function requireTechOnVehicle(
	vehicleId: string,
	orgId: string,
	context?: UserContext,
): Promise<string | null> {
	if (!context?.techId) return "Only technicians can perform this action";
	const tech = await db.technician.findFirst({
		where: { id: context.techId, organization_id: orgId },
		select: { current_vehicle_id: true },
	});
	if (!tech || tech.current_vehicle_id !== vehicleId) {
		return "Technician is not assigned to this vehicle";
	}
	return null;
}


export async function listRestockRequests(
	orgId: string,
	status?: string,
	vehicleId?: string,
): Promise<{ err?: string; requests?: RestockRequestRow[] }> {
	try {
		const requests = await db.vehicle_restock_request.findMany({
			where: {
				organization_id: orgId,
				...(status ? { status } : {}),
				...(vehicleId
					? { stock_item: { vehicle_id: vehicleId } }
					: {}),
			},
			include: {
				stock_item: {
					include: {
						inventory_item: { select: { id: true, name: true, unit: true, quantity: true } },
						vehicle: { select: { id: true, name: true } },
					},
				},
			},
			orderBy: { created_at: "desc" },
			take: 100,
		});

		// No technician relation on the model — merge names with a second query
		const techIds = [...new Set(requests.map((r) => r.technician_id))];
		const techs = techIds.length
			? await db.technician.findMany({
					where: { id: { in: techIds }, organization_id: orgId },
					select: { id: true, name: true },
				})
			: [];
		const techById = new Map(techs.map((t) => [t.id, t]));

		return {
			requests: requests.map((r) => ({
				...mapRestockRequest(r),
				stock_item: mapStockItemForRequest(r.stock_item),
				technician: techById.get(r.technician_id) ?? null,
			})),
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to list restock requests");
		return { err: "Failed to list restock requests" };
	}
}

export async function listVehicleRestockRequests(
	vehicleId: string,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; requests?: object[] }> {
	try {
		// Technicians must be on the vehicle; dispatch perms pass through unchecked
		if (context?.techId) {
			const ownershipErr = await requireTechOnVehicle(vehicleId, orgId, context);
			if (ownershipErr) return { err: ownershipErr };
		}

		// Resolved/dismissed alerts are same-day only — they're operational signals,
		// not audit records. Stock movements carry the audit trail.
		const todayMidnightUtc = new Date();
		todayMidnightUtc.setUTCHours(0, 0, 0, 0);

		const requests = await db.vehicle_restock_request.findMany({
			where: {
				stock_item: { vehicle: { id: vehicleId, organization_id: orgId } },
				OR: [
					{ status: "pending" },
					{ status: "acknowledged" },
					{ status: "resolved", resolved_at: { gte: todayMidnightUtc } },
					{ status: "dismissed", created_at: { gte: todayMidnightUtc } },
				],
			},
			include: {
				stock_item: {
					include: {
						inventory_item: { select: { id: true, name: true, unit: true, quantity: true } },
					},
				},
			},
			orderBy: { created_at: "desc" },
			take: 200,
		});

		return {
			requests: requests.map((r) => ({
				...mapRestockRequest(r),
				stock_item: mapStockItemForRequest(r.stock_item),
			})),
		};
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to list vehicle restock requests");
		return { err: "Failed to list vehicle restock requests" };
	}
}


export async function dismissRestockRequest(
	requestId: string,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; request?: object }> {
	try {
		const claimed = await db.vehicle_restock_request.updateMany({
			where: {
				id: requestId,
				status: { in: ["pending", "acknowledged"] },
				organization_id: orgId,
			},
			data: { status: "dismissed", dismissed_reason: "dispatch" },
		});
		if (claimed.count === 0) {
			const existing = await db.vehicle_restock_request.findFirst({
				where: { id: requestId, organization_id: orgId },
			});
			if (!existing) return { err: "Restock request not found" };
			return { err: `Request is already ${existing.status}` };
		}

		const updated = await db.vehicle_restock_request.findFirst({
			where: { id: requestId, organization_id: orgId },
		});

		await logActivity({
			event_type: "vehicle_restock.dismissed",
			action: "updated",
			entity_type: "vehicle_restock_request",
			entity_id: requestId,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { status: { old: null, new: "dismissed" } },
		});

		return { request: updated! };
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to dismiss restock request");
		return { err: "Failed to dismiss restock request" };
	}
}


export async function acknowledgeRestockRequest(
	requestId: string,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; request?: object }> {
	try {
		const dispatcherId = context?.dispatcherId;
		if (!dispatcherId) return { err: "Dispatcher context required" };

		const updated = await db.vehicle_restock_request.updateMany({
			where: {
				id: requestId,
				organization_id: orgId,
				status: "pending",
			},
			data: {
				status: "acknowledged",
				acknowledged_at: new Date(),
				acknowledged_by_id: dispatcherId,
			},
		});
		if (updated.count === 0) {
			const existing = await db.vehicle_restock_request.findFirst({
				where: { id: requestId, organization_id: orgId },
			});
			if (!existing) return { err: "Restock request not found" };
			return { err: "Request is not in pending state" };
		}
		// Org-filtered — the prior unscoped findUnique here could return another
		// org's request once the updateMany above confirmed ownership by id alone.
		const request = await db.vehicle_restock_request.findUnique({
			where: { id: requestId, organization_id: orgId },
		});
		if (!request) return { err: "Restock request not found" };
		await logActivity({
			event_type: "vehicle_restock_request.acknowledged",
			action: "updated",
			entity_type: "vehicle_restock_request",
			entity_id: requestId,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { status: { old: "pending", new: "acknowledged" } },
		});
		return { request };
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to acknowledge restock request");
		return { err: "Failed to acknowledge restock request" };
	}
}


// ── Technician vehicle assignment ─────────────────────────────────────────────

export const setTechnicianVehicle = async (technicianId: string, vehicleId: string | null, organizationId: string) => {
	try {
		const sdb = getScopedDb(organizationId);
		if (vehicleId !== null) {
			const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
			if (!vehicle) return { err: "Vehicle not found" };
		}

		const technician = await sdb.technician.update({
			where: { id: technicianId },
			data: { current_vehicle_id: vehicleId },
			select: { id: true, name: true, current_vehicle_id: true, current_vehicle: true },
		});
		await logActivity({
			event_type: "technician.vehicle_assigned",
			action: "updated",
			entity_type: "technician",
			entity_id: technicianId,
			organization_id: organizationId,
			actor_type: "system",
			actor_id: null,
			changes: { current_vehicle_id: { old: null, new: vehicleId } },
		});
		return { err: "", item: technician };
	} catch (e: unknown) {
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return { err: "Technician not found" };
		log.error({ err: e }, "Failed to set technician vehicle");
		return { err: "Failed to set vehicle" };
	}
};

// ── Parts used (visit-level stock deduction) ──────────────────────────────────

const addPartsUsedSchema = z.object({
	stock_item_id:   z.string().uuid(),
	qty_used:        stockQtyField(z.number().positive()),
	technician_id:   z.string().uuid(),
	serial_unit_ids: z.array(z.string().uuid()).optional(),
	batch_id:        z.string().uuid().optional(),
});

export const addPartsUsed = async (visitId: string, data: unknown, organizationId: string) => {
	try {
		const parsed = addPartsUsedSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const stockItem = await sdb.vehicle_stock_item.findFirst({
			where: { id: parsed.stock_item_id },
			include: { inventory_item: true },
		});
		if (!stockItem) return { err: "Stock item not found" };

		const visit = await sdb.job_visit.findFirst({ where: { id: visitId } });
		if (!visit) return { err: "Visit not found" };

		// Serial/batch tracking (B-T2) — uncapped/strict single line. Resolved
		// BEFORE the transaction opens so a validation failure never opens one
		// (addPartsUsed.test.ts "...without opening a transaction"). Uncapped mode
		// never dereferences `tx` (no tx.stock_batch query happens unless capped),
		// so a throwaway value is safe here — see task-1 report for why the
		// signature keeps `tx` non-nullable rather than widening it.
		const [partsUsedTracking] = await buildTrackingInputs(
			null as unknown as Prisma.TransactionClient,
			organizationId,
			new Map<string, ItemTrackingFlags>([
				[
					stockItem.inventory_item_id,
					{
						is_serialized: stockItem.inventory_item.is_serialized,
						is_batch_tracked: stockItem.inventory_item.is_batch_tracked,
					},
				],
			]),
			[
				{
					inventory_item_id: stockItem.inventory_item_id,
					qty: parsed.qty_used,
					raw: { serial_unit_ids: parsed.serial_unit_ids, batch_id: parsed.batch_id },
				},
			],
		);

		const result = await sdb.$transaction(async (tx) => {
			// Create line item first — the movement links to it
			const unitPrice = stockItem.inventory_item.unit_price ?? 0;
			const qty = parsed.qty_used;
			const lineItem = await tx.job_visit_line_item.create({
				data: {
					visit_id:           visitId,
					name:               stockItem.inventory_item.name,
					quantity:           qty,
					unit_price:         unitPrice,
					total:              Number(unitPrice) * qty,
					source:             "field_addition",
					item_type:          "material",
					sort_order:         0,
					inventory_item_id:  stockItem.inventory_item_id,
					fulfillment_status: "used",
				},
			});

			// Vehicle decrement happens inside recordMovements. allowNegative: field
			// truth wins — negatives surface as dispatcher discrepancies.
			await recordMovements(
				tx as unknown as Prisma.TransactionClient,
				organizationId,
				{ actor_type: "technician", actor_id: parsed.technician_id },
				[
					{
						inventory_item_id:  stockItem.inventory_item_id,
						qty:                parsed.qty_used,
						from_location_type: "vehicle",
						from_vehicle_id:    stockItem.vehicle_id,
						to_location_type:   "consumed",
						reason:             "parts_used",
						visit_id:           visitId,
						visit_line_item_id: lineItem.id,
						serial:             partsUsedTracking.tracking.serial,
						batch_allocations:  partsUsedTracking.tracking.batch_allocations,
					},
				],
				{ allowNegative: true },
			);

			// Record usage
			const usage = await tx.vehicle_stock_usage.create({
				data: {
					stock_item_id:      parsed.stock_item_id,
					visit_id:           visitId,
					technician_id:      parsed.technician_id,
					qty_used:           qty,
					visit_line_item_id: lineItem.id,
				},
			});

			await recomputeVisitTotals(visitId, organizationId, tx as unknown as Prisma.TransactionClient);

			return { lineItem, usage };
		});

		await logActivity({
			event_type: "vehicle_stock.parts_used",
			action: "updated",
			entity_type: "vehicle_stock_item",
			entity_id: parsed.stock_item_id,
			organization_id: organizationId,
			actor_type: "technician",
			actor_id: parsed.technician_id,
			changes: { qty_used: { old: null, new: parsed.qty_used } },
		});
		return { err: "", item: result };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		const t = trackingErrorResponse(e);
		if (t) return t;
		log.error({ err: e }, "Failed to add parts used");
		return { err: "Failed to add parts used" };
	}
};

// ── Update parts used quantity (reverses/extends the stock ledger) ────────────

const updatePartsUsedQtySchema = z.object({
	// Optional ATTRIBUTION only (which tech the part is credited to); the ledger
	// actor is always the authenticated caller — see updatePartsUsedQty.
	technician_id: z.string().uuid().optional(),
	quantity:       stockQtyField(z.number().min(0)),
});

// Business-rule failure raised inside the parts-used transaction (line item
// missing, not stock-linked, serialized increase, …). Thrown so nothing
// commits, then mapped to a { err } result in the catch below.
class PartsUsedEditError extends Error {}

// Visit states in which billed parts are frozen: the completion transition has
// already consumed the visit's stock and rolled its total up to the job, and a
// cancelled visit bills nothing.
const PARTS_FROZEN_VISIT_STATUSES: ReadonlySet<string> = new Set(["Completed", "Cancelled"]);

/**
 * Edit-Parts qty +/-/delete for a line item that came from addPartsUsed
 * (inventory_item_id set, fulfillment_status "used"). A plain field update here
 * would desync the line's displayed quantity from the serial/batch ledger that
 * was written when the part was first added — this mirrors that ledger instead:
 * increases deduct more from the same vehicle, decreases (incl. to zero) write a
 * "reversal" movement back onto it, releasing the exact consumed serials/batch
 * qty tied to this line so the audit trail always matches what's billed.
 *
 * Tenancy: job_visit_line_item carries no org column, so the visit is resolved
 * through the scoped client FIRST (404 for a foreign/missing visit) and the line
 * is then read by (id, visit_id) — no foreign line can be returned. The current
 * quantity and the delta are computed inside the transaction after SELECT … FOR
 * UPDATE on the line, so two concurrent edits can't both reverse the same stock.
 */
export const updatePartsUsedQty = async (
	visitId: string,
	lineItemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updatePartsUsedQtySchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const actor = toActor(context);

		const visit = await sdb.job_visit.findFirst({
			where: { id: visitId },
			select: { id: true, status: true, _count: { select: { invoice_visits: true } } },
		});
		if (!visit) return { err: "Visit not found" };
		if (PARTS_FROZEN_VISIT_STATUSES.has(visit.status)) {
			return { err: `Parts can't be changed on a ${visit.status} visit` };
		}
		if (visit._count.invoice_visits > 0) {
			return { err: "Parts can't be changed on a visit that has been invoiced" };
		}

		// Body technician_id is attribution only, and only if it's one of ours.
		if (parsed.technician_id) {
			const tech = await sdb.technician.findFirst({
				where: { id: parsed.technician_id },
				select: { id: true },
			});
			if (!tech) return { err: "Technician not found" };
		}

		const outcome = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;

			// Lock the line before reading it: the delta below is derived from the
			// quantity we read, and a concurrent edit must wait for this one to commit.
			await txc.$queryRaw`SELECT id FROM job_visit_line_item WHERE id = ${lineItemId} FOR UPDATE`;

			const lineItem = await tx.job_visit_line_item.findFirst({
				where: { id: lineItemId, visit_id: visitId },
				include: { inventory_item: true },
			});
			if (!lineItem) throw new PartsUsedEditError("Line item not found");
			// "used" alone no longer proves the stock came off a van: since
			// 2026-08-20 completion also stamps `receive` and `non_stock` lines
			// used, and reversing vehicle stock for a part that was received
			// into the warehouse (or never ours at all) would invent movements.
			const fromVehicleStock = (lineItem.disposition ?? "consume") === "consume";
			if (
				!lineItem.inventory_item_id ||
				!lineItem.inventory_item ||
				lineItem.fulfillment_status !== "used" ||
				!fromVehicleStock
			) {
				throw new PartsUsedEditError(
					"This line isn't linked to vehicle stock — edit it as a regular line item",
				);
			}

			const currentQty = Number(lineItem.quantity);
			const newQty = parsed.quantity;
			const delta = newQty - currentQty;
			if (delta === 0) return { lineItem, currentQty, newQty, changed: false as const };

			const isSerialized = lineItem.inventory_item.is_serialized;
			const isBatchTracked = lineItem.inventory_item.is_batch_tracked;

			// Increasing a serialized line needs a specific new unit picked off the
			// vehicle — Edit Parts has no picker for that, so it must be re-added via
			// Vehicle Stock instead of silently understating what's on hand.
			if (delta > 0 && isSerialized) {
				throw new PartsUsedEditError(
					"Serialized items can't be increased here — remove this line and re-add the units from Vehicle Stock.",
				);
			}

			const amount = Math.abs(delta);

			// A serialized decrease releases whole units; `take` below can't be fractional.
			if (isSerialized && !Number.isInteger(amount)) {
				throw new PartsUsedEditError(
					"Serialized items can only be changed by whole units",
				);
			}

			const originMovement = await tx.stock_movement.findFirst({
				where: { visit_line_item_id: lineItemId, from_location_type: "vehicle" },
				select: { from_vehicle_id: true },
				orderBy: { created_at: "asc" },
			});
			const vehicleId = originMovement?.from_vehicle_id;
			if (!vehicleId) {
				throw new PartsUsedEditError("Could not determine the originating vehicle for this part");
			}

			if (delta > 0) {
				// Increase: additional deduction from the same vehicle. Batch-tracked
				// items auto-allocate FIFO (recordMovements → applyTracking); untracked
				// items just deduct. Serialized items were rejected above. allowNegative
				// matches addPartsUsed: field truth wins, a negative surfaces as a
				// dispatcher discrepancy rather than blocking the tech.
				await recordMovements(
					txc,
					organizationId,
					actor,
					[
						{
							inventory_item_id:  lineItem.inventory_item_id,
							qty:                amount,
							from_location_type: "vehicle",
							from_vehicle_id:    vehicleId,
							to_location_type:   "consumed",
							reason:             "parts_used",
							visit_id:           visitId,
							visit_line_item_id: lineItemId,
							batch_allocations:  undefined,
						},
					],
					{ allowNegative: true },
				);
			} else {
				// Decrease (incl. to zero): release exactly `amount` of what this line
				// actually consumed back onto the vehicle.
				let serial: { unit_ids: string[] } | undefined;
				let batch_allocations: { batch_id: string; qty: number }[] | undefined;

				if (isSerialized) {
					const released = await tx.serial_unit.findMany({
						where: { consumed_line_item_id: lineItemId },
						select: { id: true },
						orderBy: { consumed_at: "asc" },
						take: amount,
					});
					if (released.length !== amount) {
						throw new TrackingValidationError(
							`Only ${released.length} consumed unit(s) on record for this line — cannot release ${amount}`,
						);
					}
					serial = { unit_ids: released.map((s) => s.id) };
				} else if (isBatchTracked) {
					// Net every movement this line has ever produced (reversals cancel
					// their original) to find what's still attributed to it per batch.
					const movements = await tx.stock_movement.findMany({
						where: { visit_line_item_id: lineItemId },
						include: { movement_batches: true },
						orderBy: { created_at: "asc" },
					});
					const net = new Map<string, Prisma.Decimal>();
					for (const mv of movements) {
						for (const b of mv.movement_batches) {
							const signedQty =
								mv.reason === "reversal"
									? new Prisma.Decimal(b.qty).negated()
									: new Prisma.Decimal(b.qty);
							net.set(b.batch_id, (net.get(b.batch_id) ?? new Prisma.Decimal(0)).plus(signedQty));
						}
					}

					let remaining = new Prisma.Decimal(amount);
					batch_allocations = [];
					for (const [batch_id, qty] of net) {
						if (remaining.lessThanOrEqualTo(0) || qty.lessThanOrEqualTo(0)) continue;
						const take = Prisma.Decimal.min(remaining, qty);
						batch_allocations.push({ batch_id, qty: Number(take) });
						remaining = remaining.minus(take);
					}
					if (remaining.greaterThan(0)) {
						throw new TrackingValidationError(
							`Only ${amount - Number(remaining)} unit(s) of batch stock on record for this line — cannot release ${amount}`,
						);
					}
				}

				await recordMovements(
					txc,
					organizationId,
					actor,
					[
						{
							inventory_item_id:  lineItem.inventory_item_id,
							qty:                amount,
							from_location_type: "consumed",
							to_location_type:   "vehicle",
							to_vehicle_id:      vehicleId,
							reason:             "reversal",
							visit_id:           visitId,
							visit_line_item_id: lineItemId,
							serial,
							batch_allocations,
						},
					],
				);
			}

			let result: typeof lineItem | null;
			if (newQty <= 0) {
				await tx.job_visit_line_item.delete({ where: { id: lineItemId } });
				result = null;
			} else {
				result = await tx.job_visit_line_item.update({
					where: { id: lineItemId },
					data: {
						quantity: newQty,
						total:    Number(lineItem.unit_price) * newQty,
					},
					include: { inventory_item: true },
				});
			}

			await recomputeVisitTotals(visitId, organizationId, txc);

			return { lineItem: result, currentQty, newQty, changed: true as const };
		});

		if (!outcome.changed) return { err: "", item: outcome.lineItem };

		await logActivity({
			event_type: "vehicle_stock.parts_used_adjusted",
			action: "updated",
			entity_type: "job_visit_line_item",
			entity_id: lineItemId,
			organization_id: organizationId,
			...getActorInfo(context),
			changes: {
				quantity: { old: outcome.currentQty, new: outcome.newQty },
				...(parsed.technician_id
					? { technician_id: { old: null, new: parsed.technician_id } }
					: {}),
			},
		});

		return { err: "", item: outcome.lineItem };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		if (e instanceof PartsUsedEditError) return { err: e.message };
		const t = trackingErrorResponse(e);
		if (t) return t;
		log.error({ err: e }, "Failed to update parts used quantity");
		return { err: "Failed to update parts used quantity" };
	}
};

// ── Apply Fill ────────────────────────────────────────────────────────────────

export interface FillToStandardLine {
	inventory_item_id: string;
	qty_moved: number;
	shortfall: number;
	reason_code: TrackingReasonCode;
	message?: string;
	serial_codes?: string[];
	lot_codes?: string[];
}

const applyFillSchema = z.object({
	lines: z
		.array(
			z.object({
				inventory_item_id: z.string().uuid(),
				qty:               z.number().int().positive(),
				// Serial/batch tracking (B-T4) — see completeRestockSchema comment above.
				serial_unit_ids: z.array(z.string().uuid()).optional(),
				batch_picks:     z
					.array(z.object({ batch_id: z.string().uuid(), qty: stockQtyField(z.number().positive()) }))
					.optional(),
			}),
		)
		.min(1, "At least one line required"),
});

export async function applyFill(
	vehicleId: string,
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; available?: Record<string, number>; lines?: FillToStandardLine[] }> {
	try {
		const parsed = applyFillSchema.parse(data);
		const sdb = getScopedDb(orgId);
		const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
		if (!vehicle) return { err: "Vehicle not found" };

		let lowStockItemIds: string[] = [];
		const lines = await sdb.$transaction(async (tx) => {
			const itemIds = [...new Set(parsed.lines.map((l) => l.inventory_item_id))].sort();
			await lockInventoryRows(tx as unknown as Prisma.TransactionClient, itemIds);
			const items = await tx.inventory_item.findMany({
				where: { id: { in: itemIds } },
				select: { id: true, quantity: true },
			});
			// quantity is inferred from the select — a Decimal now, coerced right here.
			const availableById = new Map<string, number>(
				items.map((i) => [i.id, Number(i.quantity)]),
			);

			// Serial/batch tracking (B-T4) — warn-don't-block: allowUntracked lets a
			// gap be recorded instead of throwing when nothing was scanned. Capped
			// mode — availableById (the warehouse cache) is mutated in place by
			// buildTrackingInputs to mirror this loop's original running-balance
			// behavior. A serialized line with real scan input is never clamped to
			// the cache (phase 0 cache-drift fix); a batch-tracked line clamps
			// against the real stock_batch lot sum instead.
			const flags = await loadTrackingFlags(tx as unknown as Prisma.TransactionClient, itemIds);

			const resolvedLines = await buildTrackingInputs(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				flags,
				parsed.lines.map((line) => ({
					inventory_item_id: line.inventory_item_id,
					qty: line.qty,
					raw: { serial_unit_ids: line.serial_unit_ids, batch_picks: line.batch_picks },
				})),
				{ available: availableById },
			);

			const computed: FillToStandardLine[] = resolvedLines.map((r, i) => {
				const requested = parsed.lines[i].qty;
				const detail: FillToStandardLine = {
					inventory_item_id: r.inventory_item_id,
					qty_moved: r.qty,
					shortfall: r.shortfall,
					reason_code: r.reasonCode,
				};
				const message = trackingLineMessage(r.reasonCode, requested, r.qty);
				if (message) detail.message = message;
				return detail;
			});
			const movements: MovementInput[] = resolvedLines
				.filter((r) => r.qty > 0)
				.map((r) => ({
					inventory_item_id: r.inventory_item_id,
					qty: r.qty,
					from_location_type: "warehouse",
					to_location_type: "vehicle",
					to_vehicle_id: vehicleId,
					reason: "restock",
					...r.tracking,
				}));
			const result = await recordMovements(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				toActor(context),
				movements,
				{ allowUntracked: true },
			);
			lowStockItemIds = result.lowStockItemIds;

			// Phase 2b — serial/lot codes that actually moved (see resolveMovedTrackingCodes).
			const movedCodes = await resolveMovedTrackingCodes(
				tx as unknown as Prisma.TransactionClient,
				resolvedLines,
				flags,
				result.movementIds,
			);
			computed.forEach((line, i) => {
				const codes = movedCodes.get(i);
				if (codes?.serial_codes) line.serial_codes = codes.serial_codes;
				if (codes?.lot_codes) line.lot_codes = codes.lot_codes;
			});

			return computed;
		});

		fireLowStockAlerts(lowStockItemIds, orgId).catch(() => {});
		if (lines.some((l) => l.qty_moved > 0)) {
			emitInventoryUpdated(orgId, { vehicleId });
			const linesNeedingAttention = lines
				.filter((l) => trackingNeedsAttention(l.reason_code, l.shortfall))
				.map((l) => ({ item: l.inventory_item_id, reason: l.reason_code, message: l.message }));
			await logActivity({
				event_type: "vehicle_stock.fill_to_standard",
				action: "updated",
				entity_type: "vehicle",
				entity_id: vehicleId,
				organization_id: orgId,
				...getActorInfo(context),
				changes: {
					lines_filled: { old: null, new: lines.filter((l) => l.qty_moved > 0).length },
					...(linesNeedingAttention.length > 0
						? { lines_needing_attention: { old: null, new: linesNeedingAttention } }
						: {}),
				},
			});
		}

		return { lines };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		const t = trackingErrorResponse(e);
		if (t) return t;
		log.error({ err: e }, "Failed to apply fill");
		return { err: "Failed to apply fill" };
	}
}

// ── Fill Plan (dry-run) ───────────────────────────────────────────────────────

export interface FillPlanLine {
	inventory_item_id: string;
	name: string;
	unit: string;
	on_hand: number;
	target: number;
	suggested_qty: number;
	warehouse_available: number;
}

export interface FillPlan {
	standard: FillPlanLine[];
	visits: FillPlanLine[];
}

export async function getFillPlan(
	vehicleId: string,
	orgId: string,
	getReadiness: typeof getVehicleReadiness = getVehicleReadiness,
): Promise<{ err?: string; plan?: FillPlan }> {
	try {
		const sdb = getScopedDb(orgId);
		const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
		if (!vehicle) return { err: "Vehicle not found" };

		const stockItems = await sdb.vehicle_stock_item.findMany({
			where: { vehicle_id: vehicleId },
			include: { inventory_item: { select: { id: true, name: true, unit: true, quantity: true } } },
		});

		// Visit demand for today
		const today = new Date().toISOString().slice(0, 10);
		const readiness = await getReadiness(vehicleId, orgId, today);
		if (readiness.err) return { err: readiness.err };
		const needByItem = new Map<string, { name: string; qty_needed: number }>();
		for (const g of readiness.item?.gaps ?? []) {
			needByItem.set(g.inventory_item_id, { name: g.name, qty_needed: g.qty_needed });
		}

		const standard: FillPlanLine[] = [];
		const visits: FillPlanLine[] = [];
		const seen = new Set<string>();

		for (const s of stockItems) {
			const invId = s.inventory_item.id;
			seen.add(invId);
			const onHand = Number(s.qty_on_hand);
			const std = s.qty_standard !== null ? Number(s.qty_standard) : null;
			const warehouse = Number(s.inventory_item.quantity);
			const standardFill = std !== null && onHand < std ? Math.ceil(std - onHand) : 0;
			const afterStandard = onHand + standardFill;
			const visitNeed = needByItem.get(invId)?.qty_needed ?? 0;
			const visitExtra = visitNeed > afterStandard ? Math.ceil(visitNeed - afterStandard) : 0;

			if (standardFill > 0) {
				standard.push({
					inventory_item_id: invId,
					name: s.inventory_item.name,
					unit: s.inventory_item.unit,
					on_hand: onHand,
					target: std!,
					suggested_qty: standardFill,
					warehouse_available: warehouse,
				});
			}
			if (visitExtra > 0) {
				visits.push({
					inventory_item_id: invId,
					name: s.inventory_item.name,
					unit: s.inventory_item.unit,
					on_hand: onHand,
					target: visitNeed,
					suggested_qty: visitExtra,
					warehouse_available: warehouse,
				});
			}
		}

		// Items needed by visits that aren't on the truck at all
		const missingIds = [...needByItem.keys()].filter((id) => !seen.has(id));
		if (missingIds.length) {
			const invs = await sdb.inventory_item.findMany({
				where: { id: { in: missingIds }, provisional: false },
				select: { id: true, name: true, unit: true, quantity: true },
			});
			for (const inv of invs) {
				const need = needByItem.get(inv.id)!.qty_needed;
				visits.push({
					inventory_item_id: inv.id,
					name: inv.name,
					unit: inv.unit,
					on_hand: 0,
					target: need,
					suggested_qty: Math.ceil(need),
					warehouse_available: Number(inv.quantity),
				});
			}
		}

		return { plan: { standard, visits } };
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to compute fill plan");
		return { err: "Failed to compute fill plan" };
	}
}

// ── Complete Restock ──────────────────────────────────────────────────────────

export async function completeRestock(
	vehicleId: string,
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{
	err?: string;
	available?: Record<string, number>;
	record?: RestockRecord;
	line_details?: RestockLineDetail[];
}> {
	try {
		const parsed = completeRestockSchema.parse(data);
		const sdb = getScopedDb(orgId);

		const [vehicle, org] = await Promise.all([
			sdb.vehicle.findFirst({ where: { id: vehicleId } }),
			sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true, name: true } }),
		]);
		if (!vehicle) return { err: "Vehicle not found" };
		const orgTz = org?.timezone ?? "UTC";

		const actorId = context?.dispatcherId ?? context?.techId;
		if (!actorId) return { err: "Actor context required" };

		type RestockComputedLine = {
			stock_item_id:     string;
			inventory_item_id: string;
			qty_restocked:     number;
			qty_shortfall:     number;
		};

		let lowStockItemIds: string[] = [];
		const stockItemInventoryItemId = new Map<string, string>();

		const { record, lineDetails } = (await sdb.$transaction(async (tx) => {
			// Record created first — the (vehicle_id, day) unique constraint is the
			// duplicate-EOD guard, raced-safe unlike a pre-tx findFirst.
			const restockRecord = await tx.vehicle_restock_record.create({
				data: {
					vehicle_id:           vehicleId,
					organization_id:      orgId,
					completed_at:         new Date(),
					// `day` is a DateTime @db.Date column — it keeps only the UTC date
					// component, so it needs the org-local calendar date as a string, not
					// the local-midnight instant (which a zone east of UTC would truncate
					// to the wrong date).
					day:                  new Date(localDateString(new Date(), orgTz) + "T00:00:00.000Z"),
					mode:                 parsed.mode ?? "restock",
					completed_by_id:      context?.dispatcherId ?? null,
					completed_by_tech_id: context?.dispatcherId ? null : (context?.techId ?? null),
					notes:                parsed.notes ?? null,
				},
			});

			// Validate and compute inside the transaction to avoid TOCTOU
			const stockItemIds = parsed.restock_lines.map((l) => l.stock_item_id);
			const stockItems = await tx.vehicle_stock_item.findMany({
				where: { id: { in: stockItemIds }, vehicle_id: vehicleId },
			});

			// Validate all requested items belong to this vehicle
			if (stockItems.length !== new Set(stockItemIds).size) {
				throw new Error("One or more stock items not found on this vehicle");
			}

			// Lock warehouse rows, then read availability for cap math
			const itemIds = [...new Set(stockItems.map((s) => s.inventory_item_id))].sort();
			await lockInventoryRows(tx as unknown as Prisma.TransactionClient, itemIds);
			const items = await tx.inventory_item.findMany({
				where: { id: { in: itemIds } },
				select: { id: true, quantity: true },
			});
			const availableById = new Map(items.map((i) => [i.id, Number(i.quantity)]));

			// Resolve each line's stock item up front (throws for an unknown
			// stock_item_id, same as the original per-line .find() did).
			const lineMeta = parsed.restock_lines.map((line) => {
				const stockItem = stockItems.find((s) => s.id === line.stock_item_id);
				if (!stockItem) throw new Error(`Stock item ${line.stock_item_id} not found`);
				return { stock_item_id: line.stock_item_id, inventory_item_id: stockItem.inventory_item_id, raw: line };
			});
			for (const l of lineMeta) stockItemInventoryItemId.set(l.stock_item_id, l.inventory_item_id);

			// Serial/batch tracking (B-T4) — warn-don't-block: allowUntracked lets a
			// gap be recorded instead of throwing when nothing was scanned. Capped
			// against the warehouse cache (availableById), mutated in place by
			// buildTrackingInputs. Zero-qty_to_restock lines are excluded from the
			// helper call (nothing to reconcile) and reconstituted afterward so
			// index-alignment with parsed.restock_lines survives (a zero-qty line
			// must not shift or drop a later line's tracking — see "multi-line
			// restock: tracking lands on the correct line despite a zero-qty line
			// being filtered out").
			const flagItemIds = [...new Set(lineMeta.map((l) => l.inventory_item_id))].sort();
			const flags = await loadTrackingFlags(tx as unknown as Prisma.TransactionClient, flagItemIds);

			const nonZeroIdx: number[] = [];
			const nonZeroLines: { inventory_item_id: string; qty: number; raw: { serial_unit_ids?: string[]; batch_picks?: MovementInput["batch_allocations"] } }[] = [];
			lineMeta.forEach((l, i) => {
				if (l.raw.qty_to_restock <= 0) return;
				nonZeroIdx.push(i);
				nonZeroLines.push({
					inventory_item_id: l.inventory_item_id,
					qty: l.raw.qty_to_restock,
					raw: { serial_unit_ids: l.raw.serial_unit_ids, batch_picks: l.raw.batch_picks },
				});
			});

			const resolvedLines = await buildTrackingInputs(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				flags,
				nonZeroLines,
				{ available: availableById },
			);

			const computedLines: RestockComputedLine[] = lineMeta.map((l) => ({
				stock_item_id:     l.stock_item_id,
				inventory_item_id: l.inventory_item_id,
				qty_restocked:     0,
				qty_shortfall:     0,
			}));
			const trackingByLine: LineTracking[] = lineMeta.map(() => ({}));
			nonZeroIdx.forEach((origIdx, k) => {
				const r = resolvedLines[k];
				computedLines[origIdx] = {
					stock_item_id:     lineMeta[origIdx].stock_item_id,
					inventory_item_id: lineMeta[origIdx].inventory_item_id,
					qty_restocked:     r.qty,
					qty_shortfall:     r.shortfall,
				};
				trackingByLine[origIdx] = r.tracking;
			});

			const movements: MovementInput[] = [];
			for (let i = 0; i < computedLines.length; i++) {
				const l = computedLines[i];
				if (l.qty_restocked <= 0) continue;
				movements.push({
					inventory_item_id:  l.inventory_item_id,
					qty:                l.qty_restocked,
					from_location_type: "warehouse",
					to_location_type:   "vehicle",
					to_vehicle_id:      vehicleId,
					reason:             "restock",
					restock_record_id:  restockRecord.id,
					...trackingByLine[i],
				});
			}
			const result = await recordMovements(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				toActor(context),
				movements,
				{ allowUntracked: true },
			);
			lowStockItemIds = result.lowStockItemIds;

			// Phase 2b — per-line reason codes + serial/lot codes that moved, for the
			// response payload and activity log. Zero-qty lines never ran through
			// buildTrackingInputs, so they default to "ok" with no message (nothing
			// requested, nothing to report).
			const movedCodes = await resolveMovedTrackingCodes(
				tx as unknown as Prisma.TransactionClient,
				resolvedLines,
				flags,
				result.movementIds,
			);

			const lineDetails: RestockLineDetail[] = lineMeta.map((l) => ({
				stock_item_id: l.stock_item_id,
				reason_code: "ok",
			}));
			nonZeroIdx.forEach((origIdx, k) => {
				const r = resolvedLines[k];
				const requested = lineMeta[origIdx].raw.qty_to_restock;
				const detail: RestockLineDetail = {
					stock_item_id: lineMeta[origIdx].stock_item_id,
					reason_code: r.reasonCode,
				};
				const message = trackingLineMessage(r.reasonCode, requested, r.qty);
				if (message) detail.message = message;
				const codes = movedCodes.get(k);
				if (codes?.serial_codes) detail.serial_codes = codes.serial_codes;
				if (codes?.lot_codes) detail.lot_codes = codes.lot_codes;
				lineDetails[origIdx] = detail;
			});

			await tx.vehicle_restock_line.createMany({
				data: computedLines.map((l) => ({
					restock_record_id: restockRecord.id,
					stock_item_id: l.stock_item_id,
					qty_restocked: l.qty_restocked,
					qty_shortfall: l.qty_shortfall,
				})),
			});

			const restockRecordWithLines = await tx.vehicle_restock_record.findUniqueOrThrow({
				where: { id: restockRecord.id },
				include: {
					restock_lines: true,
					completed_by: { select: { id: true, name: true } },
					completed_by_tech: { select: { id: true, name: true } },
				},
			});
			return { record: restockRecordWithLines, lineDetails };
		})) as unknown as { record: RestockRecord; lineDetails: RestockLineDetail[] };

		fireLowStockAlerts(lowStockItemIds, orgId).catch(() => {});
		emitInventoryUpdated(orgId, { vehicleId });

		// Re-key by stock_item_id (the join key) rather than trusting the DB read's
		// row order to match lineDetails' construction order.
		const detailsByStockItemId = new Map(lineDetails.map((d) => [d.stock_item_id, d]));
		const line_details: RestockLineDetail[] = record.restock_lines.map(
			(rl) => detailsByStockItemId.get(rl.stock_item_id) ?? { stock_item_id: rl.stock_item_id, reason_code: "ok" },
		);

		// G6: alert dispatchers when any item couldn't be fully restocked
		const shortfallLines = record.restock_lines.filter((l) => Number(l.qty_shortfall) > 0);
		if (shortfallLines.length > 0) {
			const shortfallStockItems = await sdb.vehicle_stock_item.findMany({
				where: { id: { in: shortfallLines.map((l) => l.stock_item_id) } },
				select: { id: true, inventory_item: { select: { name: true } } },
			});
			const nameByStockItemId = new Map(shortfallStockItems.map((s) => [s.id, s.inventory_item.name]));
			const items = shortfallLines.map(
				(l) => `${nameByStockItemId.get(l.stock_item_id) ?? "Unknown item"} (-${Number(l.qty_shortfall)})`,
			);
			notifyDispatchers({
				type: "restock_shortfall",
				title: `Restock shortfall — ${vehicle.name}`,
				body: `Couldn't fully restock: ${items.slice(0, 3).join(", ")}${items.length > 3 ? ` and ${items.length - 3} more` : ""}.`,
				actionUrl: `/dispatch/vehicles/${vehicleId}/stock`,
			}, orgId).catch(() => {});
		}

		// G10: zero-shortfall EOD auto-confirms readiness for tomorrow
		if (shortfallLines.length === 0 && context?.techId) {
			const tomorrowDateStr = localDateString(new Date(), orgTz, 1);
			const tomorrowDate = new Date(tomorrowDateStr + "T00:00:00.000Z");
			await sdb.vehicle_readiness.upsert({
				where: { vehicle_id_date: { vehicle_id: vehicleId, date: tomorrowDate } },
				create: {
					vehicle_id:           vehicleId,
					organization_id:      orgId,
					date:                 tomorrowDate,
					confirmed_by_id:      null,
					confirmed_by_tech_id: context.techId,
					restock_record_id:    record.id,
				},
				update: {}, // Don't overwrite an explicit dispatcher confirmation
			});
		}

		const linesNeedingAttention = record.restock_lines
			.map((rl) => {
				const detail = detailsByStockItemId.get(rl.stock_item_id);
				const reasonCode = detail?.reason_code ?? "ok";
				if (!trackingNeedsAttention(reasonCode, Number(rl.qty_shortfall))) return null;
				return {
					item: stockItemInventoryItemId.get(rl.stock_item_id) ?? rl.stock_item_id,
					reason: reasonCode,
					message: detail?.message,
				};
			})
			.filter((x): x is { item: string; reason: TrackingReasonCode; message: string | undefined } => x !== null);

		await logActivity({
			event_type: "vehicle_restock.completed",
			action: "created",
			entity_type: "vehicle_restock_record",
			entity_id: record.id,
			organization_id: orgId,
			...getActorInfo(context),
			changes: {
				restock_line_count: { old: null, new: record.restock_lines.length },
				...(linesNeedingAttention.length > 0
					? { lines_needing_attention: { old: null, new: linesNeedingAttention } }
					: {}),
			},
		});

		return { record, line_details };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		const t = trackingErrorResponse(e);
		if (t) return t;
		log.error({ err: e }, "Failed to complete restock");
		return { err: "Failed to complete restock" };
	}
}

// ── Get Restock Today ─────────────────────────────────────────────────────────

export async function getRestockToday(
	vehicleId: string,
	orgId: string,
): Promise<{ err?: string; record?: object | null }> {
	const sdb = getScopedDb(orgId);

	const [vehicle, org] = await Promise.all([
		sdb.vehicle.findFirst({ where: { id: vehicleId } }),
		sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } }),
	]);
	if (!vehicle) return { err: "Vehicle not found" };
	const orgTz = org?.timezone ?? "UTC";

	const { start: startUTC, end: endUTC } = utcDayRange(new Date(), 1, orgTz);

	const record = await sdb.vehicle_restock_record.findFirst({
		where: { vehicle_id: vehicleId, completed_at: { gte: startUTC, lt: endUTC } },
		orderBy: { completed_at: "desc" },
		include: {
			restock_lines: true,
			completed_by: { select: { id: true, name: true } },
			completed_by_tech: { select: { id: true, name: true } },
		},
	});

	return { record: record ?? null };
}

// ── Adjust Stock ──────────────────────────────────────────────────────────────

class StockItemNotFoundError extends Error {}
class RequestNotPendingError extends Error {}
class QuantityRequiredError extends Error {}
class ValidationError extends Error {}

export async function adjustStock(
	vehicleId: string,
	data: unknown,
	orgId: string,
	context?: UserContext,
): Promise<{ err?: string; available?: Record<string, number>; adjustment?: object }> {
	try {
		const sdb = getScopedDb(orgId);

		const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
		if (!vehicle) return { err: "Vehicle not found" };

		const actorId = context?.dispatcherId ?? context?.techId;
		if (!actorId) return { err: "Actor context required" };

		const parsed = adjustStockSchema.parse(data);

		if (parsed.target_vehicle_id) {
			if (parsed.type !== "transfer") {
				return { err: "target_vehicle_id is only valid for transfer adjustments" };
			}
			if (parsed.target_vehicle_id === vehicleId) {
				return { err: "Transfer target must be a different vehicle" };
			}
			const target = await sdb.vehicle.findFirst({ where: { id: parsed.target_vehicle_id } });
			if (!target) return { err: "Target vehicle not found" };
		}

		type AdjustComputedLine = {
			stock_item_id:     string;
			inventory_item_id: string;
			qty_before:        number;
			qty_after:         number;
			delta:             number;
			inventory_impact:  number;
		};

		let lowStockItemIds: string[] = [];

		const adjustment = await sdb.$transaction(async (tx) => {
			// Existing on-truck lines reference a stock item directly; resolve and
			// validate they belong to this vehicle
			const existingIds = parsed.lines
				.filter((l) => l.stock_item_id)
				.map((l) => l.stock_item_id as string);
			const stockItems = existingIds.length
				? await tx.vehicle_stock_item.findMany({
						where: { id: { in: existingIds }, vehicle_id: vehicleId },
					})
				: [];

			if (stockItems.length !== new Set(existingIds).size) {
				throw new StockItemNotFoundError("One or more stock items not found on this vehicle");
			}

			const affectsWarehouse = parsed.type === "warehouse_exchange";

			// Resolve both kinds of line to a concrete stock item. "Add from
			// warehouse" lines carry an inventory_item_id for an item not yet on the
			// truck — upsert a zero-qty stock row so the adjustment line + movement
			// have something to key off.
			type ResolvedLine = {
				stock_item_id:     string;
				inventory_item_id: string;
				qty_before:        number;
				qty_after:         number;
			};
			const resolved: ResolvedLine[] = [];
			for (const line of parsed.lines) {
				if (line.stock_item_id) {
					const item = stockItems.find((s: { id: string }) => s.id === line.stock_item_id)!;
					resolved.push({
						stock_item_id:     item.id,
						inventory_item_id: item.inventory_item_id,
						qty_before:        Number(item.qty_on_hand),
						qty_after:         line.qty_after,
					});
				} else {
					const inv = await tx.inventory_item.findFirst({
						where: { id: line.inventory_item_id!, organization_id: orgId, provisional: false },
						select: { id: true },
					});
					if (!inv) throw new StockItemNotFoundError("Inventory item not found");
					const row = await tx.vehicle_stock_item.upsert({
						where: {
							vehicle_id_inventory_item_id: {
								vehicle_id:        vehicleId,
								inventory_item_id: line.inventory_item_id!,
							},
						},
						create: {
							vehicle_id:        vehicleId,
							inventory_item_id: line.inventory_item_id!,
							qty_on_hand:       0,
							qty_min:           0,
						},
						update: {},
					});
					resolved.push({
						stock_item_id:     row.id,
						inventory_item_id: line.inventory_item_id!,
						qty_before:        Number(row.qty_on_hand),
						qty_after:         line.qty_after,
					});
				}
			}

			const computedLines: AdjustComputedLine[] = resolved.map((line) => {
				const delta = line.qty_after - line.qty_before;
				const inventoryImpact = affectsWarehouse ? -delta : 0;
				return {
					stock_item_id:     line.stock_item_id,
					inventory_item_id: line.inventory_item_id,
					qty_before:        line.qty_before,
					qty_after:         line.qty_after,
					delta,
					inventory_impact:  inventoryImpact,
				};
			});

			if (parsed.type === "field_loss" && computedLines.some((l) => l.delta > 0)) {
				throw new ValidationError("Field loss adjustments can only decrease stock");
			}

			// Serial/batch tracking (B-T3) — uncapped/strict, per-line qty =
			// abs(delta), allowNewSerials: true (adjustStock is the one caller that
			// can create brand-new serials via new_serials). new_batch creation is a
			// DB write (getOrCreateBatch) that needs the live tx, so it's resolved to
			// a batch_id BEFORE the line is fed to buildTrackingInputs — the helper's
			// uncapped batch branch turns a single batch_id into
			// [{ batch_id, qty: line.qty }], matching the original inline shape.
			const flagItemIds = [...new Set(resolved.map((r) => r.inventory_item_id))].sort();
			const flags = await loadTrackingFlags(tx as unknown as Prisma.TransactionClient, flagItemIds);

			const nonZeroIdx: number[] = [];
			const nonZeroLines: {
				inventory_item_id: string;
				qty: number;
				raw: {
					serial_unit_ids?: string[];
					new_serials?: string[];
					batch_id?: string;
					batch_picks?: MovementInput["batch_allocations"];
				};
			}[] = [];
			for (let i = 0; i < computedLines.length; i++) {
				const line = computedLines[i];
				if (line.delta === 0) continue;
				const raw = parsed.lines[i];

				nonZeroIdx.push(i);
				nonZeroLines.push({
					inventory_item_id: line.inventory_item_id,
					qty: Math.abs(line.delta),
					raw: {
						serial_unit_ids: raw.serial_unit_ids,
						batch_picks: raw.batch_picks,
					},
				});
			}

			const resolvedTracking = await buildTrackingInputs(
				tx as unknown as Prisma.TransactionClient,
				orgId,
				flags,
				nonZeroLines,
				// Nothing left here brings a unit into circulation for the first
				// time — that was supplier_purchase, and it is a field purchase now.
				{ allowNewSerials: false },
			);

			const trackingByLine: LineTracking[] = computedLines.map(() => ({}));
			nonZeroIdx.forEach((origIdx, k) => {
				trackingByLine[origIdx] = resolvedTracking[k].tracking;
			});

			const created = await tx.vehicle_stock_adjustment.create({
				data: {
					vehicle_id:         vehicleId,
					organization_id:    orgId,
					type:               parsed.type,
					note:               parsed.note ?? null,
					created_by_id:      context?.dispatcherId ?? null,
					created_by_tech_id: context?.dispatcherId ? null : (context?.techId ?? null),
					lines: {
						create: computedLines.map((l) => ({
							stock_item_id:    l.stock_item_id,
							qty_before:       l.qty_before,
							qty_after:        l.qty_after,
							inventory_impact: l.inventory_impact,
						})),
					},
				},
			});

			// D5 mapping: positive delta moves INTO this vehicle, negative OUT.
			// Counterparty: warehouse (warehouse_exchange), target vehicle
			// (transfer with target), or the adjustment bucket.
			const movements: MovementInput[] = [];
			for (let i = 0; i < computedLines.length; i++) {
				const line = computedLines[i];
				if (line.delta === 0) continue;
				const qty = Math.abs(line.delta);
				const into = line.delta > 0;
				const tracking = trackingByLine[i];

				if (parsed.type === "warehouse_exchange") {
					movements.push({
						inventory_item_id:  line.inventory_item_id,
						qty,
						from_location_type: into ? "warehouse" : "vehicle",
						from_vehicle_id:    into ? undefined : vehicleId,
						to_location_type:   into ? "vehicle" : "warehouse",
						to_vehicle_id:      into ? vehicleId : undefined,
						reason:             into ? "restock" : "return_to_warehouse",
						adjustment_id:      created.id,
						...tracking,
					});
				} else if (parsed.type === "transfer" && parsed.target_vehicle_id) {
					movements.push({
						inventory_item_id:  line.inventory_item_id,
						qty,
						from_location_type: "vehicle",
						from_vehicle_id:    into ? parsed.target_vehicle_id : vehicleId,
						to_location_type:   "vehicle",
						to_vehicle_id:      into ? vehicleId : parsed.target_vehicle_id,
						reason:             "transfer",
						adjustment_id:      created.id,
						...tracking,
					});
				} else {
					const reason =
						parsed.type === "field_loss"
							? "loss"
							: parsed.type === "transfer"
								? "transfer"
								: "audit_correction";
					movements.push({
						inventory_item_id:  line.inventory_item_id,
						qty,
						from_location_type: into ? "adjustment" : "vehicle",
						from_vehicle_id:    into ? undefined : vehicleId,
						to_location_type:   into ? "vehicle" : "adjustment",
						to_vehicle_id:      into ? vehicleId : undefined,
						reason,
						adjustment_id:      created.id,
						...tracking,
					});
				}
			}

			// Default overdraw guard protects warehouse_exchange; other types never
			// touch the warehouse (vehicle-side negatives are always permitted)
			const result = await recordMovements(tx as unknown as Prisma.TransactionClient, orgId, toActor(context), movements);
			lowStockItemIds = result.lowStockItemIds;

			return tx.vehicle_stock_adjustment.findUniqueOrThrow({
				where: { id: created.id },
				include: {
					lines: true,
					created_by: { select: { id: true, name: true } },
					created_by_tech: { select: { id: true, name: true } },
				},
			});
		});

		fireLowStockAlerts(lowStockItemIds, orgId).catch(() => {});
		if (parsed.type === "warehouse_exchange") emitInventoryUpdated(orgId, { vehicleId });

		await logActivity({
			event_type: "vehicle_stock.adjusted",
			action: "updated",
			entity_type: "vehicle_stock_adjustment",
			entity_id: adjustment.id,
			organization_id: orgId,
			...getActorInfo(context),
			changes: { type: { old: null, new: parsed.type }, line_count: { old: null, new: parsed.lines.length } },
		});

		return { adjustment };
	} catch (e: unknown) {
		if (e instanceof ZodError) return { err: `Validation failed: ${formatZodError(e)}` };
		if (e instanceof StockItemNotFoundError) return { err: e.message };
		if (e instanceof ValidationError) return { err: e.message };
		if (e instanceof InsufficientStockError) {
			return { err: "insufficient_warehouse_stock", available: e.available };
		}
		const t = trackingErrorResponse(e);
		if (t) return t;
		log.error({ err: e }, "Failed to adjust stock");
		return { err: "Failed to adjust stock" };
	}
}

// ── Restock History ───────────────────────────────────────────────────────────

export async function getRestockHistory(
	vehicleId: string,
	orgId: string,
): Promise<{ err?: string; records?: RestockHistoryRecord[] }> {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	const records = await sdb.vehicle_restock_record.findMany({
		where: { vehicle_id: vehicleId },
		include: {
			restock_lines: true,
			completed_by: { select: { id: true, name: true } },
			completed_by_tech: { select: { id: true, name: true } },
		},
		orderBy: { completed_at: "desc" },
		take: 30,
	});

	return { records: records.map(mapRestockHistoryRecord) };
}

// ── Adjustment History ────────────────────────────────────────────────────────

export async function getStockAdjustmentHistory(
	vehicleId: string,
	orgId: string,
): Promise<{ err?: string; adjustments?: StockAdjustmentRecord[] }> {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	const adjustments = await sdb.vehicle_stock_adjustment.findMany({
		where: { vehicle_id: vehicleId },
		include: {
			lines: true,
			created_by: { select: { id: true, name: true } },
			created_by_tech: { select: { id: true, name: true } },
		},
		orderBy: { created_at: "desc" },
		take: 50,
	});

	return { adjustments: adjustments.map(mapStockAdjustmentRecord) };
}

// ── Usage today ───────────────────────────────────────────────────────────────

interface UsageTodayItem {
	itemName: string;
	qtyUsed: number;
}

interface UsageTodayGroup {
	visitId: string;
	visitName: string;
	scheduledAt: string | null;
	items: UsageTodayItem[];
}

export async function getUsageToday(
	vehicleId: string,
	orgId: string,
): Promise<{ err?: string; data?: UsageTodayGroup[] }> {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	// Lower bound = completed_at of the last warehouse restock; fallback = vehicle creation
	const lastRestock = await sdb.vehicle_restock_record.findFirst({
		where: { vehicle_id: vehicleId, mode: "restock" },
		orderBy: { completed_at: "desc" },
		select: { completed_at: true },
	});
	const since = lastRestock?.completed_at ?? vehicle.created_at;

	// For direct_consumption movements, join through vehicle_stock_usage to find
	// which techs used stock from this vehicle since the last restock — a historical
	// anchor that survives mid-day vehicle reassignments.
	const vehicleUsageTechIds = (
		await sdb.vehicle_stock_usage.findMany({
			where: {
				stock_item: { vehicle_id: vehicleId },
				created_at: { gte: since },
			},
			select: { technician_id: true },
			distinct: ["technician_id"],
		})
	).map((u) => u.technician_id);

	// Same definition of consumption as lib/inventory.ts CONSUMPTION_MOVEMENT_PREDICATE
	// (Prisma form, since this read isn't raw SQL): parts_used + direct_consumption,
	// NET of reversals back onto this vehicle — an Edit-Parts decrease writes a
	// consumed → vehicle "reversal" that cancels demand that never happened.
	const movements = await sdb.stock_movement.findMany({
		where: {
			created_at: { gte: since, lte: new Date() },
			OR: [
				{ from_vehicle_id: vehicleId, reason: "parts_used" },
				{ to_vehicle_id: vehicleId, reason: "reversal", from_location_type: "consumed" },
				...(vehicleUsageTechIds.length > 0
					? [{
							reason: "direct_consumption" as const,
							actor_type: "technician" as const,
							actor_id: { in: vehicleUsageTechIds },
						}]
					: []),
			],
		},
		include: {
			inventory_item: { select: { name: true } },
			visit: {
				select: {
					id: true,
					scheduled_start_at: true,
					job: { select: { name: true } },
				},
			},
		},
		orderBy: { created_at: "asc" },
	});

	// Netted per (visit, item): a part used twice on one visit is one line, and a
	// reversal subtracts from it. Items that net to zero (added, then removed) and
	// visits left with nothing are dropped.
	const byVisit = new Map<string, UsageTodayGroup & { qtyByItem: Map<string, number> }>();

	for (const m of movements) {
		const visitId = m.visit_id ?? "no-visit";
		if (!byVisit.has(visitId)) {
			byVisit.set(visitId, {
				visitId,
				visitName: m.visit?.job?.name ?? "Unknown visit",
				scheduledAt: m.visit?.scheduled_start_at?.toISOString() ?? null,
				items: [],
				qtyByItem: new Map(),
			});
		}
		const signedQty = m.reason === "reversal" ? -Number(m.qty) : Number(m.qty);
		const group = byVisit.get(visitId)!;
		const name = m.inventory_item.name;
		group.qtyByItem.set(name, (group.qtyByItem.get(name) ?? 0) + signedQty);
	}

	const data: UsageTodayGroup[] = [];
	for (const { qtyByItem, ...group } of byVisit.values()) {
		const items: UsageTodayItem[] = [];
		for (const [itemName, qty] of qtyByItem) {
			// Two decimals is the ledger's own scale; this also clears float noise
			// from summing fractional quantities.
			const qtyUsed = Math.round(qty * 100) / 100;
			if (qtyUsed !== 0) items.push({ itemName, qtyUsed });
		}
		if (items.length > 0) data.push({ ...group, items });
	}

	return { data };
}

// ── Tomorrow Requirements ─────────────────────────────────────────────────────

export interface TomorrowRequirementItem {
	inventoryItemId: string;
	itemName: string;
	qtyNeeded: number;
	qtyOnHand: number;
}

export interface TomorrowRequirementVisit {
	visitId: string;
	visitName: string;
	scheduledAt: string;
	jobName: string;
	clientName: string;
	items: TomorrowRequirementItem[];
}

export async function getTomorrowRequirements(
	vehicleId: string,
	orgId: string,
): Promise<{ err?: string; data?: TomorrowRequirementVisit[] }> {
	try {
		const sdb = getScopedDb(orgId);

		const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
		if (!vehicle) return { err: "Vehicle not found" };

		const org = await sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } });
		const orgTz = org?.timezone ?? "UTC";

		// Tomorrow = next calendar day in org timezone (DST-safe via utcDayRange)
		const { end: tomorrowStart } = utcDayRange(new Date(), 1, orgTz);
		const { end: tomorrowEnd } = utcDayRange(new Date(), 2, orgTz);

		// Find techs currently on this vehicle
		const techs = await sdb.technician.findMany({
			where: { current_vehicle_id: vehicleId },
			select: { id: true },
		});
		const techIds = techs.map((t) => t.id);
		if (techIds.length === 0) return { data: [] };

		// Find tomorrow's visits assigned to those techs
		const visits = await sdb.job_visit.findMany({
			where: {
				scheduled_start_at: { gte: tomorrowStart, lt: tomorrowEnd },
				status: { notIn: ["Completed", "Cancelled"] },
				visit_techs: { some: { tech_id: { in: techIds } } },
				line_items: { some: READINESS_LINE_ITEM_WHERE },
			},
			include: {
				job: { include: { client: { select: { name: true } } } },
				line_items: {
					where: READINESS_LINE_ITEM_WHERE,
					select: { inventory_item_id: true, quantity: true, name: true },
				},
			},
		});

		if (visits.length === 0) return { data: [] };

		// Get current on-hand for this vehicle
		const stockItems = await sdb.vehicle_stock_item.findMany({
			where: { vehicle_id: vehicleId },
			select: { inventory_item_id: true, qty_on_hand: true },
		});
		const onHandByItemId = new Map(stockItems.map((s) => [s.inventory_item_id, Number(s.qty_on_hand)]));

		const result: TomorrowRequirementVisit[] = visits
			.filter((v) => v.line_items.length > 0)
			.map((v) => ({
				visitId: v.id,
				visitName: v.job.name,
				scheduledAt: v.scheduled_start_at?.toISOString() ?? "",
				jobName: v.job.name,
				clientName: v.job.client?.name ?? "",
				items: v.line_items
					.filter((li) => li.inventory_item_id !== null)
					.map((li) => ({
						inventoryItemId: li.inventory_item_id!,
						itemName: li.name,
						qtyNeeded: Number(li.quantity),
						qtyOnHand: onHandByItemId.get(li.inventory_item_id!) ?? 0,
					})),
			}));

		return { data: result };
	} catch (e: unknown) {
		log.error({ err: e }, "Failed to get tomorrow requirements");
		return { err: "Failed to get tomorrow requirements" };
	}
}

// ── Vehicle Readiness ─────────────────────────────────────────────────────────

type ReadinessLineItem = {
	visit_id: string;
	inventory_item_id: string | null;
	quantity: number | Prisma.Decimal;
	inventory_item: { id: string; name: string } | null;
};

function computeGapsFromLineItems(
	lineItems: ReadinessLineItem[],
	onHandByItem: Map<string, number>,
): ReadinessGap[] {
	const qtyNeeded = new Map<string, { name: string; qty: number; visit_ids: string[] }>();
	for (const li of lineItems) {
		if (!li.inventory_item_id || !li.inventory_item) continue;
		const existing = qtyNeeded.get(li.inventory_item_id);
		if (existing) {
			existing.qty += Number(li.quantity);
			if (!existing.visit_ids.includes(li.visit_id)) existing.visit_ids.push(li.visit_id);
		} else {
			qtyNeeded.set(li.inventory_item_id, {
				name: li.inventory_item.name,
				qty: Number(li.quantity),
				visit_ids: [li.visit_id],
			});
		}
	}

	return [...qtyNeeded.entries()].map(([inv_id, { name, qty, visit_ids }]) => {
		const on_hand = onHandByItem.get(inv_id) ?? 0;
		return {
			inventory_item_id: inv_id,
			name,
			qty_needed: qty,
			qty_on_hand: on_hand,
			gap: Math.max(0, qty - on_hand),
			visit_ids,
		};
	});
}

/**
 * Batched readiness for many vehicles in 4 queries (records, techs, visits,
 * stock). A visit with techs on two vehicles counts toward both — same
 * semantics as the per-vehicle computation it replaced.
 */
async function computeReadinessForVehicles(
	orgId: string,
	vehicleIds: string[],
	dateStr: string,
): Promise<Map<string, ReadinessResult>> {
	const targetDate = new Date(dateStr + "T00:00:00.000Z");
	const nextDate = new Date(targetDate);
	nextDate.setUTCDate(nextDate.getUTCDate() + 1);

	const [records, techs] = await Promise.all([
		db.vehicle_readiness.findMany({
			where: { vehicle_id: { in: vehicleIds }, date: targetDate },
			include: {
				confirmed_by:      { select: { name: true } },
				confirmed_by_tech: { select: { name: true } },
			},
		}),
		db.technician.findMany({
			where: { current_vehicle_id: { in: vehicleIds }, organization_id: orgId },
			select: { id: true, current_vehicle_id: true },
		}),
	]);

	const recordByVehicle = new Map(records.map((r) => [r.vehicle_id, r]));
	const vehicleByTech = new Map(techs.map((t) => [t.id, t.current_vehicle_id!]));

	const visits =
		techs.length > 0
			? await db.job_visit.findMany({
					where: {
						scheduled_start_at: { gte: targetDate, lt: nextDate },
						status: { notIn: ["Completed", "Cancelled"] },
						visit_techs: { some: { tech_id: { in: [...vehicleByTech.keys()] } } },
						job: { organization_id: orgId },
					},
					include: {
						line_items: {
							where: READINESS_LINE_ITEM_WHERE,
							include: { inventory_item: { select: { id: true, name: true } } },
						},
						visit_techs: { select: { tech_id: true } },
					},
				})
			: [];

	// Map visits to the vehicles their techs are on
	const visitsByVehicle = new Map<string, typeof visits>();
	for (const visit of visits) {
		const seen = new Set<string>();
		for (const vt of visit.visit_techs) {
			const vehicleId = vehicleByTech.get(vt.tech_id);
			if (!vehicleId || seen.has(vehicleId)) continue;
			seen.add(vehicleId);
			const list = visitsByVehicle.get(vehicleId);
			if (list) list.push(visit);
			else visitsByVehicle.set(vehicleId, [visit]);
		}
	}

	// One stock read across every (vehicle, needed item) pair
	const neededItemIds = [
		...new Set(
			visits.flatMap((v) => v.line_items.map((li) => li.inventory_item_id)).filter(Boolean),
		),
	] as string[];
	const stockItems = neededItemIds.length
		? await db.vehicle_stock_item.findMany({
				where: { vehicle_id: { in: vehicleIds }, inventory_item_id: { in: neededItemIds } },
				select: { vehicle_id: true, inventory_item_id: true, qty_on_hand: true },
			})
		: [];
	const stockByVehicle = new Map<string, Map<string, number>>();
	for (const s of stockItems) {
		let m = stockByVehicle.get(s.vehicle_id);
		if (!m) {
			m = new Map();
			stockByVehicle.set(s.vehicle_id, m);
		}
		m.set(s.inventory_item_id, Number(s.qty_on_hand));
	}

	const results = new Map<string, ReadinessResult>();
	for (const vehicleId of vehicleIds) {
		const record = recordByVehicle.get(vehicleId);
		const vehicleVisits = visitsByVehicle.get(vehicleId) ?? [];
		const hasTechs = techs.some((t) => t.current_vehicle_id === vehicleId);
		const lineItems = vehicleVisits.flatMap((v) => v.line_items);
		const onHand = stockByVehicle.get(vehicleId) ?? new Map<string, number>();

		if (record) {
			const confirmedByType = record.confirmed_by_id
				? "dispatcher"
				: record.restock_record_id
					? "restock_auto"
					: "technician";
			results.set(vehicleId, {
				state: "confirmed",
				date: dateStr,
				gaps: computeGapsFromLineItems(lineItems, onHand),
				confirmed: {
					id: record.id,
					confirmed_by:
						record.confirmed_by?.name ??
						record.confirmed_by_tech?.name ??
						"System",
					confirmed_by_type: confirmedByType,
					confirmed_at: record.confirmed_at.toISOString(),
					notes: record.notes,
				},
			});
			continue;
		}

		if (!hasTechs || vehicleVisits.length === 0) {
			results.set(vehicleId, { state: "not_applicable", date: dateStr, gaps: [] });
			continue;
		}

		if (lineItems.length === 0) {
			results.set(vehicleId, { state: "unknown", date: dateStr, gaps: [] });
			continue;
		}

		const gaps = computeGapsFromLineItems(lineItems, onHand);
		const state: ReadinessState = gaps.some((g) => g.gap > 0) ? "needs_action" : "auto_ready";
		results.set(vehicleId, { state, date: dateStr, gaps });
	}

	return results;
}

export const getVehicleReadiness = async (
	vehicleId: string,
	organizationId: string,
	dateStr: string,
): Promise<{ err?: string; item?: ReadinessResult }> => {
	const sdb = getScopedDb(organizationId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	const results = await computeReadinessForVehicles(organizationId, [vehicleId], dateStr);
	return { err: "", item: results.get(vehicleId)! };
};

export const getFleetReadiness = async (
	organizationId: string,
	dateStr: string,
): Promise<{ err?: string; items?: Array<{ vehicle_id: string } & ReadinessResult> }> => {
	const sdb = getScopedDb(organizationId);

	const vehicles = await sdb.vehicle.findMany({
		where: { status: "active" },
		select: { id: true },
	});
	const ids = vehicles.map((v: { id: string }) => v.id);
	if (ids.length === 0) return { err: "", items: [] };

	const results = await computeReadinessForVehicles(organizationId, ids, dateStr);
	return {
		err: "",
		items: ids.map((id: string) => ({ vehicle_id: id, ...results.get(id)! })),
	};
};

// ── Confirm / Revoke Readiness ────────────────────────────────────────────────

const confirmReadinessSchema = z.object({
	date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
	notes: z.string().optional(),
});

export const confirmReadiness = async (
	vehicleId: string,
	organizationId: string,
	dispatcherId: string,
	body: unknown,
): Promise<{ err?: string; item?: ReadinessResult }> => {
	const sdb = getScopedDb(organizationId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	let parsed: z.infer<typeof confirmReadinessSchema>;
	try {
		parsed = confirmReadinessSchema.parse(body);
	} catch (e) {
		if (e instanceof ZodError) return { err: formatZodError(e) };
		return { err: "Invalid input" };
	}

	const targetDate = new Date(parsed.date + "T00:00:00.000Z");

	const existing = await db.vehicle_readiness.findFirst({
		where: { vehicle_id: vehicleId, date: targetDate },
	});
	if (existing) return { err: "Vehicle is already confirmed ready for this date" };

	await db.vehicle_readiness.create({
		data: {
			vehicle_id: vehicleId,
			organization_id: organizationId,
			date: targetDate,
			confirmed_by_id: dispatcherId,
			notes: parsed.notes ?? null,
		},
	});

	return getVehicleReadiness(vehicleId, organizationId, parsed.date);
};

export const revokeReadiness = async (
	vehicleId: string,
	organizationId: string,
	dateStr: string,
): Promise<{ err?: string; item?: ReadinessResult }> => {
	const sdb = getScopedDb(organizationId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" };

	const targetDate = new Date(dateStr + "T00:00:00.000Z");

	const record = await db.vehicle_readiness.findFirst({
		where: { vehicle_id: vehicleId, date: targetDate },
	});
	if (!record) return { err: "No readiness confirmation found for this date" };

	await db.vehicle_readiness.delete({ where: { id: record.id } });

	return getVehicleReadiness(vehicleId, organizationId, dateStr);
};

// ── Stock conflicts ───────────────────────────────────────────────────────────

interface StockConflictItem {
	inventoryItemId: string;
	itemName: string;
	qtyNeeded: number;
	qtyOnHand: number;
}

interface StockConflict {
	visitId: string;
	jobId: string;
	vehicleId: string;
	vehicleName: string;
	techNames: string[];
	visitName: string;
	clientName: string;
	scheduledAt: string;
	severity: "out" | "low";
	conflicts: StockConflictItem[];
}

export async function getStockConflicts(orgId: string, scopeVehicleId?: string): Promise<StockConflict[]> {
	// Today + tomorrow, UTC day boundaries (matches EOD/usage day math)
	const { start: startOfToday, end: endOfTomorrow } = utcDayRange(new Date(), 2);

	const visits = await db.job_visit.findMany({
		where: {
			job: { organization_id: orgId },
			scheduled_start_at: { gte: startOfToday, lt: endOfTomorrow },
			status: { notIn: ["Completed", "Cancelled"] },
			visit_techs: { some: {} },
			line_items: { some: { inventory_item_id: { not: null } } },
		},
		include: {
			job: { include: { client: { select: { name: true } } } },
			line_items: {
				where: { inventory_item_id: { not: null } },
				select: { inventory_item_id: true, quantity: true, name: true },
			},
			visit_techs: {
				include: {
					tech: {
						select: {
							id: true,
							name: true,
							current_vehicle_id: true,
							current_vehicle: {
								select: {
									id: true,
									name: true,
									stock_items: {
										select: { inventory_item_id: true, qty_on_hand: true },
									},
								},
							},
						},
					},
				},
			},
		},
	});

	const conflicts: StockConflict[] = [];

	for (const visit of visits) {
		const vehicleMap = new Map<string, typeof visit.visit_techs[0]["tech"]["current_vehicle"]>();
		const techsByVehicle = new Map<string, string[]>();

		for (const vt of visit.visit_techs) {
			const tech = vt.tech;
			if (!tech.current_vehicle_id || !tech.current_vehicle) continue;
			vehicleMap.set(tech.current_vehicle_id, tech.current_vehicle);
			const existing = techsByVehicle.get(tech.current_vehicle_id) ?? [];
			existing.push(tech.name);
			techsByVehicle.set(tech.current_vehicle_id, existing);
		}

		for (const [vehicleId, vehicle] of vehicleMap) {
			if (!vehicle) continue;
			const stockByItemId = new Map(
				vehicle.stock_items.map((s) => [s.inventory_item_id, Number(s.qty_on_hand)]),
			);

			const itemConflicts: StockConflictItem[] = [];
			for (const li of visit.line_items) {
				if (!li.inventory_item_id) continue;
				const onHand = stockByItemId.get(li.inventory_item_id) ?? 0;
				const needed = Number(li.quantity);
				if (onHand < needed) {
					itemConflicts.push({
						inventoryItemId: li.inventory_item_id,
						itemName: li.name,
						qtyNeeded: needed,
						qtyOnHand: onHand,
					});
				}
			}

			if (itemConflicts.length === 0) continue;

			const severity = itemConflicts.some((c) => c.qtyOnHand === 0) ? "out" : "low";

			conflicts.push({
				visitId: visit.id,
				jobId: visit.job_id,
				vehicleId,
				vehicleName: vehicle.name,
				techNames: techsByVehicle.get(vehicleId) ?? [],
				visitName: visit.job.name,
				clientName: visit.job.client?.name ?? "",
				scheduledAt: visit.scheduled_start_at?.toISOString() ?? "",
				severity,
				conflicts: itemConflicts,
			});
		}
	}

	return scopeVehicleId ? conflicts.filter((c) => c.vehicleId === scopeVehicleId) : conflicts;
}

export const getVehicleMovements = async (
	vehicleId: string,
	organizationId: string,
	cursor?: string,
	limit = 25,
) => {
	const sdb = getScopedDb(organizationId);

	const vehicle = await sdb.vehicle.findFirst({ where: { id: vehicleId } });
	if (!vehicle) return { err: "Vehicle not found" as const };

	const take = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 25, 1), 100);

	const movements = await sdb.stock_movement.findMany({
		where: {
			OR: [{ from_vehicle_id: vehicleId }, { to_vehicle_id: vehicleId }],
		},
		include: {
			inventory_item: { select: { id: true, name: true, unit: true } },
			from_vehicle: { select: { id: true, name: true } },
			to_vehicle: { select: { id: true, name: true } },
		},
		orderBy: [{ created_at: "desc" }, { id: "desc" }],
		take: take + 1,
		...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
	});

	const hasNext = movements.length > take;
	const page = hasNext ? movements.slice(0, take) : movements;
	const nextCursor = hasNext ? page[page.length - 1].id : null;

	return { err: "", movements: page.map(mapStockMovement), nextCursor };
};

// Vehicle maintenance

export const createMaintenanceRecord = async (orgId: string, vehicleId: string, data: unknown, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({where: { id: vehicleId }});
	if (!vehicle) return { err: "Vehicle not found"};

	let parsed: z.infer<typeof createMaintenanceRecordSchema>;
	try {
		parsed = createMaintenanceRecordSchema.parse(data);
	} catch (e) {
		if (e instanceof ZodError) return { err: formatZodError(e) };
		return { err: "Invalid input" };
	}

	if (parsed.source_field_purchase_line_id) {
		const line = await sdb.field_purchase_line.findFirst({ 
			where: {id: parsed.source_field_purchase_line_id}, 
		});
		if (line?.disposition_vehicle_id !== vehicleId)
			return { err: "Source purchase line belongs to another vehicle"}
	}
	if (parsed.source_purchase_line_id) {
		const line = await sdb.purchase_line.findFirst({ 
			where: {id: parsed.source_purchase_line_id}, 
		});
		if (line?.disposition_vehicle_id !== vehicleId)
			return { err: "Source purchase line belongs to another vehicle"}
	}

	const { reminder_ids, ...recordData } = parsed;
	const record = await sdb.vehicle_maintenance_record.create({
		data: {
			...recordData,
			performed_at: new Date(parsed.performed_at),
			performed_by_id: context?.dispatcherId ?? null,
			performed_by_tech_id: context?.dispatcherId ? null : (context?.techId ?? null),
			organization_id: orgId,
			vehicle_id: vehicleId
		}
	});

	await applyRecordOdometer(sdb, vehicleId, record);

	if (reminder_ids?.length) {
		const covered = await sdb.vehicle_maintenance_reminder.findMany({
			where: { id: { in: reminder_ids }, vehicle_id: vehicleId },
		});
		for (const reminder of covered) {
			if (!reminder.repeats) {
				if (reminder.completed_at == null) await completeMaintenanceReminder(orgId, vehicleId, reminder.id, context);
				continue;
			}
			// backdated record older than the current anchor — don't move the due date backwards
			const anchor = reminder.baseline_at;
			if (anchor && record.performed_at.getTime() < Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate())) continue;

			const baseline_odometer_mi = record.odometer_mi ?? vehicle.current_odometer_mi;
			await sdb.vehicle_maintenance_reminder.update({
				where: { id: reminder.id },
				data: { baseline_at: record.performed_at, baseline_odometer_mi, acknowledged_at: null },
			});
			await logActivity({
				event_type: "vehicle_maintenance_reminder.serviced",
				action: "updated",
				entity_type: "vehicle_maintenance_reminder",
				entity_id: reminder.id,
				organization_id: orgId,
				...getActorInfo(context),
				changes: {
					baseline_at:          { old: reminder.baseline_at, new: record.performed_at },
					baseline_odometer_mi: { old: reminder.baseline_odometer_mi, new: baseline_odometer_mi },
				},
			});
		}
	}

	await logActivity({
		event_type: "vehicle_maintenance.created",
		action: "created",
		entity_type: "vehicle_maintenance_record",
		entity_id: record.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: {
			category:     { old: null, new: record.category },
			performed_at: { old: null, new: record.performed_at },
		},
	});

	return { record };
}

export const getMaintenanceRecords = async (orgId: string, vehicleId: string) => {
	const sdb = getScopedDb(orgId);

	const exists = await sdb.vehicle.findFirst({ where: { id: vehicleId }});
	if (!exists) return { err: "Vehicle not found"};

	const records = await sdb.vehicle_maintenance_record.findMany({
		where: {vehicle_id: vehicleId},
		orderBy: { performed_at: "desc" }, 
		include: {
			performed_by: { select: { id: true, name: true } },
			performed_by_tech: { select: { id: true, name: true } },
			source_purchase_line: { select: { purchase_id: true } },
			source_field_purchase_line: { select: { field_purchase_id: true } },
		}
	});

	return { records: records.map(mapMaintenanceRecord) };
}

export const updateMaintenanceRecord = async(orgId: string, vehicleId: string, recordId: string, data: unknown, context?: UserContext) =>  {
	let parsed: z.infer<typeof updateMaintenanceRecordSchema>;
	try {
		parsed = updateMaintenanceRecordSchema.parse(data);
	} catch (e) {
		if (e instanceof ZodError) return { err: formatZodError(e) };
		return { err: "Invalid input" };
	}

	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_record.findFirst({
		where: { id: recordId, vehicle_id: vehicleId }
	});
	if (!existing) return { err: "Maintenance record not found"};

	if (parsed.source_field_purchase_line_id) {
		const line = await sdb.field_purchase_line.findFirst({ where: { id: parsed.source_field_purchase_line_id } });
		if (line?.disposition_vehicle_id !== vehicleId)
			return { err: "Source purchase line belongs to another vehicle" };
	}
	if (parsed.source_purchase_line_id) {
		const line = await sdb.purchase_line.findFirst({ where: { id: parsed.source_purchase_line_id } });
		if (line?.disposition_vehicle_id !== vehicleId)
			return { err: "Source purchase line belongs to another vehicle" };
	}

	const record = await sdb.vehicle_maintenance_record.update({
		where: { id: recordId },
		data: {
			...parsed,
			...(parsed.performed_at ? { performed_at: new Date(parsed.performed_at) } : {}),
		},
	});

	await applyRecordOdometer(sdb, vehicleId, record);

	const changes = buildChanges(existing, parsed, [
		"category", "performed_at", "odometer_mi", "interval_miles",
		"interval_months", "cost", "vendor_name", "notes",
	] as const);

	await logActivity({
		event_type: "vehicle_maintenance.updated",
		action: "updated",
		entity_type: "vehicle_maintenance_record",
		entity_id: record.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes,
	});

	return { record };
}

export const deleteMaintenanceRecord = async (orgId: string, recordId: string, vehicleId: string, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_record.findFirst({ where: { id: recordId, vehicle_id: vehicleId }});
	if (!existing) return { err: "Maintenance record not found" };

	await sdb.vehicle_maintenance_record.delete({ where: { id: recordId } });

	await logActivity({
		event_type: "vehicle_maintenance.deleted",
		action: "deleted",
		entity_type: "vehicle_maintenance_record",
		entity_id: recordId,
		organization_id: orgId,
		...getActorInfo(context),
		changes: {
			category:     { old: existing.category, new: null },
			performed_at: { old: existing.performed_at, new: null },
			...parentBreadcrumb("vehicle", vehicleId),
		},
	});

	return { err: "" };
}

export interface MaintenanceSourceLine {
	id: string;
	source: "purchase" | "field_purchase";
	description: string;
	vendor_name: string | null;
	cost: number;
	date: string | null;
	reference: string | null;
}

export const searchMaintenanceSourceLines = async (orgId: string, vehicleId: string, q: string | undefined) => {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({where: { id: vehicleId }});
	if (!vehicle) return { err: "Vehicle not found"};

	const term = q?.trim();

	const [purcahseLines, fieldLines] = await Promise.all([
		sdb.purchase_line.findMany({
			where: {
				disposition_vehicle_id: vehicleId,
				...(term 
					? { OR: [
							{ description: { contains: term, mode: "insensitive" as const } },
							{ purchase: { purchase_number: { contains: term, mode: "insensitive" as const } } },
							{ purchase: { vendor_name: { contains: term, mode: "insensitive" as const } } },
						]
					}
					: {}
				)
			},
			include: { purchase: { select: { purchase_number: true, vendor_name: true, purchased_at: true } } },
			orderBy: { created_at: "desc" },
			take: 20,
		}),
		sdb.field_purchase_line.findMany({
			where: {
				disposition_vehicle_id: vehicleId,
				...(term 
					? { OR: [
							{ description: { contains: term, mode: "insensitive" as const } },
							{ field_purchase: { receipt_number: { contains: term, mode: "insensitive" as const } } },
							{ field_purchase: { vendor_name: { contains: term, mode: "insensitive" as const } } },
						]
					}
					: {}
				)
			},
			include: { field_purchase: { select: { receipt_number: true, vendor_name: true, purchased_at: true, submitted_at: true } } },
			orderBy: { created_at: "desc" },
			take: 20,
		})
	]);
	
	const lines: MaintenanceSourceLine[] = [
		...purcahseLines.map((l): MaintenanceSourceLine => ({
		id: l.id,
		source: "purchase",
		description: l.description,
		vendor_name: l.purchase.vendor_name,
		cost: Number(l.line_total),
		date: (l.received_at ?? l.purchase.purchased_at)?.toISOString() ?? null,
		reference: l.purchase.purchase_number,
		})),
		...fieldLines.map((l): MaintenanceSourceLine => ({
		id: l.id,
		source: "field_purchase",
		description: l.description,
		vendor_name: l.field_purchase.vendor_name,
		cost: Number(l.line_total),
		date: l.field_purchase.submitted_at?.toISOString() ?? null,
		reference: l.field_purchase.receipt_number,
		})),
	].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, 20);

	return { lines };
}

export const getMaintenanceReminders = async (orgId: string, vehicleId: string) => {
	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({where: {id: vehicleId}});
	if (!vehicle) return { err: "Vehicle not found"};

	const reminders = await sdb.vehicle_maintenance_reminder.findMany({
		where: {vehicle_id: vehicleId},
		orderBy: { created_at: "desc"}
	});

	return { reminders: reminders.map(mapMaintenanceReminder) };
}

export const createMaintenanceReminder = async (orgId: string, vehicleId: string, data: unknown, context?: UserContext) => {
	let parsed: z.infer<typeof createMaintenanceReminderSchema>;
	try {
		parsed = createMaintenanceReminderSchema.parse(data);
	} catch (e) {
		if (e instanceof ZodError) return { err: formatZodError(e) };
		return { err: "Invalid input" };
	}

	const sdb = getScopedDb(orgId);

	const vehicle = await sdb.vehicle.findFirst({where: {id: vehicleId}});
	if (!vehicle) return { err: "Vehicle not found"};

	// repeating only: anchors the due calc until a record covers this reminder
	const baseline = parsed.repeats
		? {
				baseline_at: new Date(),
				baseline_odometer_mi: vehicle.current_odometer_mi,
			}
		: {};

	const reminder = await sdb.vehicle_maintenance_reminder.create({
		data: {
			...parsed,
			...(parsed.due_at ? { due_at: new Date(parsed.due_at) } : {}),
			...baseline,
			organization_id: orgId,
			vehicle_id: vehicleId
		}
	});

	await logActivity({
		event_type: "vehicle_maintenance_reminder.created",
		action: "created",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: reminder.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: {
			category: { old: null, new: reminder.category },
			title:    { old: null, new: reminder.title },
			repeats:  { old: null, new: reminder.repeats },
		},
	});

	return { reminder };
}

export const updateMaintenanceReminder = async (orgId: string, vehicleId: string, reminderId: string, data: unknown, context?: UserContext) =>{
	let parsed: z.infer<typeof updateMaintenanceReminderSchema>;
	try {
		parsed = updateMaintenanceReminderSchema.parse(data);
	} catch (e) {
		if (e instanceof ZodError) return { err: formatZodError(e) };
		return { err: "Invalid input" };
	}

	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_reminder.findFirst({where: {id: reminderId, vehicle_id: vehicleId}});
	if (!existing) return { err: "Maintenance reminder not found"};

	const updated = await sdb.vehicle_maintenance_reminder.update({
		where: {id: reminderId},
		data: {
			...parsed,
			...(parsed.due_at ? { due_at: new Date(parsed.due_at) } : {}),
		}
	});

	await logActivity({
		event_type: "vehicle_maintenance_reminder.updated",
		action: "updated",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: updated.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: buildChanges(existing, parsed, [
			"category", "title", "description", "interval_miles",
			"interval_unit", "interval_count", "repeats", "due_at", "due_odometer_mi",
		] as const),
	});

	return { reminder: updated };
}

export const deleteMaintenanceReminder = async (orgId: string, vehicleId: string, reminderId: string, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_reminder.findFirst({where: {id: reminderId, vehicle_id: vehicleId}});
	if (!existing) return { err: "Maintenance reminder not found"};

	await sdb.vehicle_maintenance_reminder.delete({ where: { id: reminderId } });

	await logActivity({
		event_type: "vehicle_maintenance_reminder.deleted",
		action: "deleted",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: reminderId,
		organization_id: orgId,
		...getActorInfo(context),
		changes: {
			category: { new: null, old: existing.category },
			title:    { new: null, old: existing.title },
			repeats:  { new: null, old: existing.repeats },
			...parentBreadcrumb("vehicle", vehicleId),
		},
	});

	return { err: "" };
}

export const acknowledgeMaintenanceReminder = async (orgId: string, vehicleId: string, reminderId: string, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_reminder.findFirst({where: {id: reminderId, vehicle_id: vehicleId}});
	if (!existing) return { err: "Maintenance reminder not found"};

	const reminder = await sdb.vehicle_maintenance_reminder.update({
		where: {id: reminderId},
		data: { acknowledged_at: new Date() },
	});

	await logActivity({
		event_type: "vehicle_maintenance_reminder.acknowledged",
		action: "updated",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: reminder.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: { acknowledged_at: { old: null, new: reminder.acknowledged_at } },
	});

	return { reminder };
}

export const completeMaintenanceReminder = async (orgId: string, vehicleId: string, reminderId: string, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_reminder.findFirst({where: {id: reminderId, vehicle_id: vehicleId}});
	if (!existing) return { err: "Maintenance reminder not found"};

	const reminder = await sdb.vehicle_maintenance_reminder.update({
		where: {id: reminderId},
		data: { completed_at: new Date() },
	});

	await logActivity({
		event_type: "vehicle_maintenance_reminder.completed",
		action: "updated",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: reminder.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: { completed_at: { old: null, new: reminder.completed_at } },
	});

	return { reminder };
}

export const unacknowledgeMaintenanceReminder = async (orgId: string, vehicleId: string, reminderId: string, context?: UserContext) => {
	const sdb = getScopedDb(orgId);

	const existing = await sdb.vehicle_maintenance_reminder.findFirst({where: {id: reminderId, vehicle_id: vehicleId}});
	if (!existing) return { err: "Maintenance reminder not found"};

	const reminder = await sdb.vehicle_maintenance_reminder.update({
		where: {id: reminderId},
		data: { acknowledged_at: null },
	});

	await logActivity({
		event_type: "vehicle_maintenance_reminder.unacknowledged",
		action: "updated",
		entity_type: "vehicle_maintenance_reminder",
		entity_id: reminder.id,
		organization_id: orgId,
		...getActorInfo(context),
		changes: { acknowledged_at: { old: existing.acknowledged_at, new: null } },
	});

	return { reminder };
}

interface MaintenanceAlert {
	reminderId: string;
	vehicleId: string;
	vehicleName: string;
	category: string;
	title: string;
	status: "overdue" | "duesoon";
	dueAt: string | null;
	dueOdometerMi: number | null;
	currentOdometerMi: number | null;
	acknowledged: boolean;
}

export const getMaintenanceAlerts = async (orgId: string, scopeVehicleId?: string): Promise<MaintenanceAlert[]> => {
	const sdb = getScopedDb(orgId);

	const reminders = await sdb.vehicle_maintenance_reminder.findMany({
		where: {
			completed_at: null,
			...(scopeVehicleId ? { vehicle_id: scopeVehicleId } : {}),
		},
		include: { vehicle: { select: { id: true, name: true, current_odometer_mi: true } } },
	});

	const alerts: MaintenanceAlert[] = [];
	for (const reminder of reminders) {
		const odometer = reminder.vehicle.current_odometer_mi;
		const status = classifyReminder(reminder, odometer);
		if (status !== "overdue" && status !== "duesoon") continue;

		const { dueAt, dueMiles } = resolveDueTargets(reminder);
		alerts.push({
			reminderId: reminder.id,
			vehicleId: reminder.vehicle_id,
			vehicleName: reminder.vehicle.name,
			category: reminder.category,
			title: reminder.title,
			status,
			dueAt: dueAt ? dueAt.toISOString() : null,
			dueOdometerMi: dueMiles,
			currentOdometerMi: odometer,
			acknowledged: reminder.acknowledged_at != null,
		});
	}

	const rank = { overdue: 0, duesoon: 1 } as const;
	return alerts.sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged) || rank[a.status] - rank[b.status]);
}
