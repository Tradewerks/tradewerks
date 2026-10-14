import type { InventoryItem } from "./inventory";

// Serial/batch resolution lands in a later phase — the backend only ever
// returns the "item" variant today. The full union is declared now so
// useScanDispatcher's handler contract doesn't need to change shape later.
export interface ResolvedSerial {
	type: "serial";
	code: string;
	serialUnitId: string;
	status: string;
	item: InventoryItem;
}

export interface ResolvedBatch {
	type: "batch";
	code: string;
	batchId: string;
	batchNumber: string;
	item: InventoryItem;
}

export type ResolveCodeResult = { type: "item"; item: InventoryItem } | ResolvedSerial | ResolvedBatch;

// ============================================================================
// Serial-unit listing — GET /inventory/:id/serials
//
// Mirrors the real `serial_unit` Prisma model row returned by listItemSerials
// (no `select` — the full row comes back, dates as ISO strings over JSON).
// ============================================================================

export type SerialUnitStatus = "in_warehouse" | "on_vehicle" | "consumed" | "lost" | "returned";

// Shared serial status copy/styling — the detail page's Tracking tab and
// SerialDetailBody both render this exact label set and (desktop) badge classes
// so a unit's status reads identically whether a dispatcher lands on the list
// or drills into a single unit.
export const SERIAL_STATUS_LABEL: Record<SerialUnitStatus, string> = {
	in_warehouse: "In Warehouse",
	on_vehicle: "On Vehicle",
	consumed: "Consumed",
	lost: "Lost",
	returned: "Returned",
};

export const SERIAL_STATUS_BADGE: Record<SerialUnitStatus, string> = {
	in_warehouse: "bg-surface-raised text-text-tertiary border border-border-strong",
	on_vehicle: "bg-primary/20 text-primary-text border border-primary/30",
	consumed: "bg-success-bg text-success-text border border-success-border",
	lost: "bg-error-bg text-error-text border border-error-border",
	returned: "bg-warning-bg text-warning-text border border-warning-border",
};

export interface SerialUnitRow {
	id: string;
	organization_id: string;
	inventory_item_id: string;
	serial_number: string;
	code: string;
	status: SerialUnitStatus;
	current_vehicle_id: string | null;
	consumed_at: string | null;
	consumed_visit_id: string | null;
	consumed_line_item_id: string | null;
	client_id: string | null;
	batch_id: string | null;
	received_at: string;
	note: string | null;
	created_at: string;
	updated_at: string;
}

export interface SerialsListResponse {
	serials: SerialUnitRow[];
	nextCursor: string | null;
}

// ============================================================================
// Batch listing — GET /inventory/:id/batches
//
// Mirrors listItemBatches' mapped shape (Decimal → number, Date → ISO string,
// plus the per-vehicle qty_on_hand breakdown).
// ============================================================================

export interface BatchVehicleBreakdown {
	vehicle_id: string;
	vehicle_name: string;
	qty_on_hand: number;
}

export interface BatchListRow {
	id: string;
	code: string;
	batch_number: string;
	expires_at: string | null;
	supplier: string | null;
	recalled_at: string | null;
	qty_received: number;
	qty_in_warehouse: number;
	vehicles: BatchVehicleBreakdown[];
}

export interface BatchesListResponse {
	batches: BatchListRow[];
}

// ============================================================================
// Tracking summary — GET /inventory/:itemId/tracking-summary
//
// Header rollups for the Serials & Batches page: serial_unit counts bucketed
// by status, plus batch lot count and summed warehouse/vehicle quantities.
// Mirrors getItemTrackingSummary's return shape (all plain numbers).
// ============================================================================

export interface TrackingSummary {
	serials: {
		in_warehouse: number;
		on_vehicle: number;
		consumed: number;
		lost: number;
		returned: number;
	};
	batches: {
		lots: number;
		qty_in_warehouse: number;
		qty_on_vehicles: number;
	};
}

// ============================================================================
// Receive stock — POST /inventory/:id/receive
//
// Matches receiveInventorySchema (backend/src/lib/validate/inventoryTracking.ts)
// and receiveInventoryItem's return shape.
// ============================================================================

export interface ReceiveInventoryInput {
	qty: number;
	serial_numbers?: string[];
	/** Serialized items: let the backend synthesize AUTO- serial numbers instead of supplying them. */
	auto_serial?: boolean;
	/**
	 * Per-unit cost the supplier billed on THIS receipt. Omit when unknown — a
	 * missing cost is recorded as unknown and excluded from the item's
	 * weighted-average paid cost, never treated as 0.
	 */
	unit_cost?: number;
	/** Adopts an existing vendor. */
	supplier_id?: string;
	/** Creates the vendor on write, when `supplier_id` wasn't given. */
	supplier_name?: string;
	batch?: {
		batch_number: string;
		expires_at?: string | null;
		/**
		 * @deprecated Legacy free text. Send supplier_id/supplier_name instead —
		 * the server writes the resolved vendor onto the lot itself.
		 */
		supplier?: string;
		/** Lot-level cost; falls back to the receive-level unit_cost. */
		unit_cost?: number;
	};
	batch_id?: string;
	note?: string;
}

export interface ReceivedSerialSummary {
	id: string;
	code: string;
	serial_number: string;
	status: SerialUnitStatus;
}

export interface ReceivedBatchSummary {
	id: string;
	code: string;
	batch_number: string;
}

export interface ReceiveInventoryResponse {
	item: InventoryItem;
	created_serials?: ReceivedSerialSummary[];
	batch?: ReceivedBatchSummary;
}

// ============================================================================
// Tracking toggle — PATCH /inventory/:id/tracking
//
// Matches toggleTrackingSchema (backend/src/lib/validate/inventoryTracking.ts).
// Each flag can be turned ON or OFF (enable, disable, or switch serialized↔batch)
// — a `false` disables that dimension. The backend rejects any change while the
// item has stock on hand (warehouse OR any vehicle), rejects a disable/switch
// while a serial is in_warehouse/on_vehicle or a lot still holds stock, and
// rejects all changes for provisional items. Terminal serials and drained lots
// do NOT block a disable — they persist as read-only history.
// ============================================================================

export interface UpdateItemTrackingInput {
	is_serialized?: boolean;
	is_batch_tracked?: boolean;
}

// ============================================================================
// Vehicle stock breakdown — GET /inventory/:itemId/vehicle-stock
//
// Per-vehicle qty for the Overview tab's "on vehicles" drill-in. Sourced from
// vehicle_stock_item.qty_on_hand — the one cache every movement updates
// regardless of tracking mode — so it's the same shape for untracked,
// serialized, batch, and dual-tracked items. Mirrors getItemVehicleStock's
// return shape.
// ============================================================================

export interface VehicleStockRow {
	vehicle_id: string;
	vehicle_name: string;
	vehicle_status: string;
	/** Currently assigned technician, if any. */
	technician_name: string | null;
	qty_on_hand: number;
}

export interface VehicleStockResponse {
	rows: VehicleStockRow[];
}

// ============================================================================
// Tracking eligibility — GET /inventory/:itemId/tracking-eligibility
//
// The same facts PATCH /inventory/:id/tracking gates on, so the edit form can
// lock its toggles and explain WHY before the user saves. Mirrors
// getTrackingEligibility's return shape.
//
// `qty_on_vehicles` gives the form visibility InventoryItem.quantity alone
// does not have: quantity alone is blind to stock sitting on a van.
// `history_*` are lifetime row counts — nonzero on an item whose tracking was
// turned off, which is what drives the archived view on the Tracking tab.
// ============================================================================

export interface TrackingEligibility {
	provisional: boolean;
	is_serialized: boolean;
	is_batch_tracked: boolean;
	qty_warehouse: number;
	qty_on_vehicles: number;
	/** How many vehicles hold a nonzero quantity of this item. */
	vehicle_count: number;
	/** Serials in in_warehouse/on_vehicle — these block a disable. */
	live_serials: number;
	/** Lots still holding stock in the warehouse or on a vehicle — these block a disable. */
	live_lots: number;
	/** Lifetime serial_unit rows, live and terminal. */
	history_serials: number;
	/** Lifetime stock_batch rows, including drained lots. */
	history_lots: number;
	can_enable: boolean;
	can_disable: boolean;
	/** Human-readable blockers, worded identically to the API's rejection messages. */
	blockers: string[];
}

// ============================================================================
// Serial edit — PATCH /inventory/serials/:serialId
//
// Matches updateSerialSchema (backend/src/lib/validate/inventoryTracking.ts).
// status transitions go through recordMovements (in_warehouse → lost/returned);
// note is a direct field edit. DELETE /inventory/serials/:serialId hard-deletes
// a never-moved, in-warehouse unit (no request body).
// ============================================================================

export interface UpdateSerialInput {
	status?: "lost" | "returned";
	note?: string | null;
}

// ============================================================================
// Batch edit — PATCH /inventory/batches/:batchId
//
// Matches updateBatch's return shape (backend/src/controllers/inventoryController.ts).
// ============================================================================

export interface UpdateBatchInput {
	batch_number?: string;
	expires_at?: string | null;
	supplier?: string | null;
	note?: string | null;
	recalled?: boolean;
}

export interface BatchDetail {
	id: string;
	code: string;
	batch_number: string;
	expires_at: string | null;
	supplier: string | null;
	note: string | null;
	recalled_at: string | null;
	qty_received: number;
	qty_in_warehouse: number;
}

// ============================================================================
// Batch recall impact report — GET /inventory/batches/:batchId/impact
// (and its XLSX export twin at .../export)
// ============================================================================

export interface JobRef {
	id: string;
	job_number: string;
	name: string;
}

export interface VisitRef {
	id: string;
	name: string | null;
	job: JobRef;
}

export interface ClientRef {
	id: string;
	name: string;
}

export interface BatchImpactVehicleRemaining {
	vehicle_id: string;
	vehicle_name: string;
	qty_on_hand: number;
}

export interface BatchImpactAffectedSerial {
	id: string;
	code: string;
	serial_number: string;
	consumed_at: string | null;
	client: ClientRef | null;
	visit: VisitRef | null;
}

export interface BatchImpactAffectedJob {
	visit_line_item_id: string;
	line_item_name: string;
	visit_id: string;
	visit_name: string | null;
	job_id: string;
	job_number: string;
	job_name: string;
	client_id: string;
	client_name: string;
	consumed_qty: number;
	reversed_qty: number;
	net_qty: number;
	fully_reversed: boolean;
}

export interface BatchImpactReport {
	batch: {
		id: string;
		code: string;
		batch_number: string;
		item_id: string;
		item_name: string;
		supplier: string | null;
		expires_at: string | null;
		recalled_at: string | null;
	};
	remaining: {
		warehouse: number;
		vehicles: BatchImpactVehicleRemaining[];
		total: number;
	};
	affected_serials: BatchImpactAffectedSerial[];
	affected_jobs: BatchImpactAffectedJob[];
}

// ============================================================================
// Serial lifecycle history — GET /inventory/serials/:id/history
// ============================================================================

export interface SerialHistoryDetail {
	id: string;
	code: string;
	serial_number: string;
	status: SerialUnitStatus;
	item: { id: string; name: string };
	current_vehicle: { id: string; name: string } | null;
	batch: { id: string; batch_number: string; code: string } | null;
	received_at: string;
	consumed_at: string | null;
	client: ClientRef | null;
	consumed_visit: VisitRef | null;
	note: string | null;
}

export interface SerialHistoryEvent {
	id: string;
	reason: string;
	from_location_type: string;
	from_vehicle: { id: string; name: string } | null;
	to_location_type: string;
	to_vehicle: { id: string; name: string } | null;
	note: string | null;
	actor_type: string;
	created_at: string;
	visit: VisitRef | null;
}

export interface SerialHistoryResponse {
	serial: SerialHistoryDetail;
	timeline: SerialHistoryEvent[];
}

// ============================================================================
// Tracking reconciliation — GET /inventory/tracking/reconciliation
// ============================================================================

export interface ReconciliationDrift {
	item_id: string;
	item_name: string;
	scope: "warehouse" | "vehicle";
	vehicle_id?: string;
	vehicle_name?: string;
	expected: number;
	actual: number;
}

export interface ReconciliationGap {
	id: string;
	item: { id: string; name: string };
	qty: number;
	reason: string;
	note: string | null;
	created_at: string;
	visit: VisitRef | null;
}

export interface ReconciliationReport {
	drifts: ReconciliationDrift[];
	gaps: ReconciliationGap[];
}
