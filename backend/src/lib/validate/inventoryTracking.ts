import z from "zod";
import { STOCK_QTY_MESSAGE, isStorableStockQty } from "./shared.js";
import { supplierCaptureFields } from "./suppliers.js";

// Batch expiry dates round-trip through native `<input type="date">` controls
// on the frontend, which emit a bare "YYYY-MM-DD" — not the full ISO-8601
// datetime `z.string().datetime()` requires. Accept either shape here (both
// parse cleanly via `new Date(...)` downstream) so the date-only value the UI
// actually sends doesn't 400.
export const expiresAtField = z
	.string()
	.refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date")
	.nullable()
	.optional();

// Receiving new stock into the warehouse for one item — optionally capturing
// per-unit serial numbers (serialized items) or a lot/batch (batch-tracked
// items). Integer-qty-for-serialized and serial-count-matches-qty checks
// depend on the item's is_serialized/is_batch_tracked flags, which this
// schema can't see — those are enforced in the controller after the item
// is loaded.
//
// qty is bounded to numeric(10,2) via isStorableStockQty — see validate/shared.ts.
export const receiveInventorySchema = z
	.object({
		qty: z.number().positive().refine(isStorableStockQty, STOCK_QTY_MESSAGE),
		serial_numbers: z.array(z.string().trim().min(1).max(100)).optional(),
		// When true for a serialized item, the controller synthesizes the per-unit
		// serial numbers (AUTO-… codes) so a business with no manufacturer serials
		// doesn't hand-type each. Ignored for non-serialized items.
		auto_serial: z.boolean().optional(),
		// What the supplier billed per unit on THIS receipt. Optional and left
		// unknown rather than guessed — price-history reports coverage instead
		// of averaging in a fake 0.
		unit_cost: z.number().nonnegative().optional(),
		// Receipt-level vendor, applied to both the movement and (when a new lot
		// is created) the lot header, so the two can't disagree about origin.
		...supplierCaptureFields,
		batch: z
			.object({
				batch_number: z.string().trim().min(1).max(100),
				expires_at: expiresAtField,
				// Legacy free-text vendor. Superseded by the receipt-level
				// supplier_id/supplier_name above, but still accepted so an older
				// client's receive records an origin — the controller promotes it
				// to a real supplier entity.
				supplier: z.string().trim().max(200).optional(),
				// Lot-level twin of the movement's unit_cost, stored on the lot
				// header so a batch's paid cost is readable without walking its
				// movements. Falls back to the receive-level unit_cost.
				unit_cost: z.number().nonnegative().optional(),
			})
			.optional(),
		batch_id: z.string().uuid().optional(),
		note: z.string().trim().max(500).optional(),
	})
	.refine((data) => !(data.batch && data.batch_id), {
		message: "provide either batch or batch_id, not both",
	});

export type ReceiveInventoryInput = z.infer<typeof receiveInventorySchema>;

// GET /inventory/:id/serials — cursor pagination follows the same convention as
// getInventoryMovements/getVehicleMovements (limit default 25, clamped to 100 in
// the controller; cursor is the id of the last row from the previous page).
export const listSerialsQuerySchema = z.object({
	status: z.enum(["in_warehouse", "on_vehicle", "consumed", "lost", "returned"]).optional(),
	vehicle_id: z.string().uuid().optional(),
	// Narrows to the units belonging to one lot, for the batch detail page —
	// a dual-tracked item's batch is a bag of individually identified units.
	batch_id: z.string().uuid().optional(),
	cursor: z.string().min(1).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	search: z.string().trim().min(1).max(200).optional(),
});

export type ListSerialsQueryInput = z.infer<typeof listSerialsQuerySchema>;

// GET /inventory/:id/batches — batches aren't paginated (a single item's lot
// count is small), so this only carries the optional text search.
export const listBatchesQuerySchema = z.object({
	search: z.string().trim().min(1).max(200).optional(),
});

export type ListBatchesQueryInput = z.infer<typeof listBatchesQuerySchema>;

// PATCH /inventory/:id/tracking — flips is_serialized/is_batch_tracked ON or
// OFF. Both flags are optional so callers can flip just one; at least one must
// be provided. The empty-only policy (zero on-hand across warehouse and every
// vehicle; plus, for disabling/switching an already-tracked dimension, no
// in_warehouse/on_vehicle serial and no lot still holding stock) and the
// provisional-item block are enforced authoritatively in the controller.
//
// Terminal serials and drained lots do NOT block a disable — they stay as
// read-only history. GET /inventory/:itemId/tracking-eligibility exposes the
// same facts for the UI to explain the block up front.
export const toggleTrackingSchema = z
	.object({
		is_serialized: z.boolean().optional(),
		is_batch_tracked: z.boolean().optional(),
	})
	.refine((d) => d.is_serialized !== undefined || d.is_batch_tracked !== undefined, {
		message: "Provide at least one of is_serialized or is_batch_tracked",
	});

export type ToggleTrackingInput = z.infer<typeof toggleTrackingSchema>;

// PATCH /inventory/batches/:batchId — edit lot metadata (batch_number, expiry,
// supplier, note) and/or the recall flag. All fields optional (partial update);
// none of them touch stock quantities. `batch_number` collides on the per-item
// unique index ([organization_id, inventory_item_id, batch_number]) — the
// controller maps that P2002 to a clean 4xx. `recalled` is a boolean toggle
// rather than a raw recalled_at timestamp: true sets it (idempotent — leaves an
// existing recalled_at alone), false clears it.
export const updateBatchSchema = z.object({
	batch_number: z.string().trim().min(1).max(100).optional(),
	expires_at: expiresAtField,
	supplier: z.string().trim().max(200).nullable().optional(),
	note: z.string().trim().max(500).nullable().optional(),
	recalled: z.boolean().optional(),
});

export type UpdateBatchInput = z.infer<typeof updateBatchSchema>;

// PATCH /inventory/serials/:serialId — change status (lost/returned) and/or edit
// note. Status transitions and the in-warehouse gate are enforced in the
// controller (this schema only shapes the request body). At least one field
// must be provided.
export const updateSerialSchema = z
	.object({
		status: z.enum(["lost", "returned"]).optional(),
		note: z.string().trim().max(500).nullable().optional(),
	})
	.refine((d) => d.status !== undefined || d.note !== undefined, {
		message: "provide at least one field to update",
	});
export type UpdateSerialInput = z.infer<typeof updateSerialSchema>;
