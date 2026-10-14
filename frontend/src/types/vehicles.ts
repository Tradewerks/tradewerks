import { z } from "zod";
import type { InventoryItem } from "./inventory";
import type { Coordinates } from "./location";

export const CreateVehicleSchema = z.object({
	name: z.string().min(1, "Name is required"),
	type: z.string().min(1, "Type is required"),
	license_plate: z.string().min(1, "License Plate / ID is required").max(50, "Max 50 characters"),
	year: z.number().int().min(1900).max(2100).nullable().optional(),
	make: z.string().max(50).nullable().optional(),
	model: z.string().max(50).nullable().optional(),
	color: z.string().max(50).nullable().optional(),
	status: z.enum(["active", "inactive"]).optional(),
	notes: z.string().max(1000).nullable().optional(),
	current_odometer_mi: z.number().int().min(0).nullable().optional(),
	stored_at: z.string().nullable().optional(),
	stored_at_coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.nullable()
		.optional(),
});

export interface Vehicle {
	id: string;
	organization_id: string | null;
	name: string;
	type: string;
	license_plate: string | null;
	year: number | null;
	make: string | null;
	model: string | null;
	status: "active" | "inactive";
	color: string | null;
	notes: string | null;
	current_odometer_mi: number | null;
	odometer_updated_at: string | null;
	created_at: string;
	updated_at: string;
	stock_items?: VehicleStockItem[];
	current_technicians?: { id: string; name: string }[];
	stored_at: string;
	stored_at_coords: Coordinates;
}

export interface VehicleStockItem {
	id: string;
	vehicle_id: string;
	inventory_item_id: string;
	inventory_item: InventoryItem;
	qty_on_hand: number;
	qty_min: number;
	qty_standard: number | null;
	updated_at: string;
	created_at: string;
}

export interface VehicleStockUsage {
	id: string;
	stock_item_id: string;
	visit_id: string;
	technician_id: string;
	qty_used: number;
	visit_line_item_id: string | null;
	created_at: string;
}

export interface CreateVehicleInput {
	name: string;
	type: string;
	license_plate: string;
	year?: number | null;
	make?: string | null;
	model?: string | null;
	color?: string | null;
	status?: "active" | "inactive";
	notes?: string | null;
	current_odometer_mi?: number | null;
	stored_at?: string | null;
	stored_at_coords?: Coordinates | null;
}

export type UpdateVehicleInput = Partial<CreateVehicleInput>;

export interface AddVehicleStockItemInput {
	inventory_item_id: string;
	qty_on_hand?: number;
	qty_min?: number;
	qty_standard?: number | null;
}

export interface UpdateVehicleStockItemInput {
	qty_on_hand?: number;
	qty_min?: number;
	qty_standard?: number | null;
}

export interface StockShortfallItem {
	inventoryItemId: string;
	itemName: string;
	qtyNeeded: number;
	qtyOnHand: number;
}

export type VehicleStockConflictItem = StockShortfallItem;

export interface VehicleStockConflict {
	visitId: string;
	jobId: string;
	vehicleId: string;
	vehicleName: string;
	techNames: string[];
	visitName: string;
	clientName: string;
	scheduledAt: string;
	severity: "out" | "low";
	conflicts: VehicleStockConflictItem[];
}

export interface VehicleMaintenanceAlert {
	reminderId: string;
	vehicleId: string;
	vehicleName: string;
	category: MaintenanceCategory;
	title: string;
	status: "overdue" | "duesoon";
	dueAt: string | null;
	dueOdometerMi: number | null;
	currentOdometerMi: number | null;
	acknowledged: boolean;
}

export interface VehicleUsageTodayItem {
	itemName: string;
	qtyUsed: number;
}

export interface VehicleUsageTodayGroup {
	visitId: string;
	visitName: string;
	scheduledAt: string | null;
	items: VehicleUsageTodayItem[];
}

export type StockHealthStatus = "ok" | "low" | "out";

export interface AddPartsUsedInput {
	stock_item_id: string;
	qty_used: number;
	technician_id: string;
	serial_unit_ids?: string[];
	batch_id?: string;
}

export interface RestockRequestInput {
	qty_requested?: number | null;
	note?: string | null;
}

export interface BulkRestockInput {
	items: Array<{ stock_item_id: string; qty_requested?: number | null; note?: string | null }>;
}

export type RestockRequestStatus = "pending" | "acknowledged" | "resolved" | "dismissed";

export interface RestockRequest {
	id: string;
	stock_item_id: string;
	technician_id: string;
	technician: { id: string; name: string } | null;
	qty_requested: number | null;
	note: string | null;
	status: RestockRequestStatus;
	created_at: string;
	acknowledged_at: string | null;
	resolved_at: string | null;
	resolved_note: string | null;
	dismissed_reason: string | null;
	stock_item: {
		id: string;
		vehicle_id: string;
		inventory_item_id: string;
		qty_on_hand: number;
		inventory_item: { id: string; name: string; unit: string | null; quantity: number };
		vehicle: { id: string; name: string };
	};
}

export interface VehicleRestockLine {
	id: string;
	restock_record_id: string;
	stock_item_id: string;
	qty_restocked: number;
	qty_shortfall: number;
}

// Mirrors backend's RestockLineDetail (vehiclesController.ts) — a sibling
// array returned alongside completeRestock's VehicleRestockRecord, joinable
// via stock_item_id (same key as VehicleRestockLine.stock_item_id). A line is
// "needs attention" (worth surfacing in an acknowledgment UI) whenever the
// joined VehicleRestockLine.qty_shortfall > 0 OR reason_code !== "ok" —
// reason_code === "ok" does NOT by itself mean nothing to show, since a real
// warehouse/lot shortfall also reports "ok" with a descriptive message. Fully
// clean lines have message: undefined and should be filtered out of any summary.
export interface RestockLineDetail {
	stock_item_id: string;
	reason_code: "ok" | "no_tracking_gap" | "cache_drift_detected";
	message?: string;
	serial_codes?: string[];
	lot_codes?: string[];
}

export interface DualActor {
	dispatcher: { id: string; name: string } | null;
	technician: { id: string; name: string } | null;
}

export interface VehicleRestockRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	completed_at: string;
	mode: "restock" | "prepare";
	completed_by_id: string | null;
	completed_by: DualActor["dispatcher"];
	completed_by_tech_id: string | null;
	completed_by_tech: DualActor["technician"];
	notes: string | null;
	restock_lines: VehicleRestockLine[];
	created_at: string;
	// Only present on the completeRestock response — endpoints that were never
	// touched by this task (getVehicleRestockToday/getVehicleRestockHistory)
	// won't have it.
	line_details?: RestockLineDetail[];
}

export interface CompleteRestockInput {
	notes?: string | null;
	mode?: "restock" | "prepare";
	restock_lines: Array<{
		stock_item_id: string;
		qty_to_restock: number;
		serial_unit_ids?: string[];
		batch_picks?: Array<{ batch_id: string; qty: number }>;
	}>;
}

export type TomorrowRequirementItem = StockShortfallItem;

export interface TomorrowRequirementVisit {
	visitId: string;
	visitName: string;
	scheduledAt: string;
	jobName: string;
	clientName: string;
	items: TomorrowRequirementItem[];
}

// `supplier_purchase` is gone: buying externally is a field purchase now, which
// carries a grant, a limit, a receipt and a review. Historical adjustments of
// that type still exist and are labelled by StockHistorySection's own map.
export type VehicleAdjustmentType = "warehouse_exchange" | "field_loss" | "transfer" | "audit";

export const ADJUSTMENT_TYPE_LABELS: Record<VehicleAdjustmentType, string> = {
	warehouse_exchange: "Warehouse Exchange",
	field_loss:         "Field Loss",
	transfer:           "Transfer In",
	audit:              "Audit Correction",
};

export interface AdjustStockInput {
	type: VehicleAdjustmentType;
	note?: string | null;
	lines: Array<{
		stock_item_id?: string;
		inventory_item_id?: string;
		qty_after: number;
		// Serial/batch tracking (F-T4) — which of these apply depends on the
		// resolved item's is_serialized/is_batch_tracked flags; see
		// AdjustStockModal's tracking step for how they're populated. Every
		// remaining type moves stock the org already owns, so these only ever
		// pick existing units and lots.
		serial_unit_ids?: string[];
		batch_picks?: Array<{ batch_id: string; qty: number }>;
	}>;
}

export interface VehicleStockAdjustmentLine {
	id: string;
	adjustment_id: string;
	stock_item_id: string;
	qty_before: number;
	qty_after: number;
	inventory_impact: number;
}

export interface VehicleStockAdjustment {
	id: string;
	vehicle_id: string;
	organization_id: string;
	type: VehicleAdjustmentType;
	note: string | null;
	created_by_id: string | null;
	created_by: DualActor["dispatcher"];
	created_by_tech_id: string | null;
	created_by_tech: DualActor["technician"];
	created_at: string;
	lines: VehicleStockAdjustmentLine[];
}

export type ReadinessState =
	| "not_applicable"
	| "unknown"
	| "auto_ready"
	| "needs_action"
	| "confirmed";

export type ReadinessGap = {
	inventory_item_id: string;
	name: string;
	qty_needed: number;
	qty_on_hand: number;
	gap: number;
	visit_ids: string[];
};

export type VehicleReadiness = {
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
export interface ApplyFillInput {
	lines: Array<{ inventory_item_id: string; qty: number }>;
}
export interface FillResultLine {
	inventory_item_id: string;
	qty_moved: number;
	shortfall: number;
	// Mirrors backend's FillToStandardLine — carries these directly (no sibling
	// array to join, unlike RestockLineDetail). A line "needs attention" whenever
	// shortfall > 0 || reason_code !== "ok"; fully clean lines have message: undefined.
	reason_code: "ok" | "no_tracking_gap" | "cache_drift_detected";
	message?: string;
	serial_codes?: string[];
	lot_codes?: string[];
}

export interface BulkRestockResult {
	created: RestockRequest[];
	skipped: { stock_item_id: string; reason: string }[];
}

export type MaintenanceCategory =
	| "oil_change"
	| "fluids"
	| "tire"
	| "brake"
	| "inspection"
	| "registration"
	| "repair"
	| "other";

export const MAINTENANCE_CATEGORY_LABELS: Record<MaintenanceCategory, string> = {
	oil_change:   "Oil change",
	fluids:       "Fluids",
	tire:         "Tire",
	brake:        "Brake",
	inspection:   "Inspection",
	registration: "Registration",
	repair:       "Repair",
	other:        "Other",
};

export interface VehicleMaintenanceRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: MaintenanceCategory;
	performed_at: string;
	odometer_mi: number | null;
	interval_miles: number | null;
	interval_months: number | null;
	cost: number | null;
	vendor_name: string | null;
	notes: string | null;
	performed_by: DualActor["dispatcher"];
	performed_by_tech: DualActor["technician"];
	source_purchase_line_id: string | null;
	source_field_purchase_line_id: string | null;
	source_purchase_id: string | null;
	source_field_purchase_id: string | null;
	created_at: string;
	updated_at: string;
}

export const CreateMaintenanceRecordSchema = z.object({
	category: z.enum(["oil_change", "fluids", "tire", "brake", "inspection", "registration", "repair", "other"]),
	performed_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "performed_at must be YYYY-MM-DD"),
	odometer_mi: z.number().int().min(0).optional().nullable(),
	interval_miles: z.number().int().min(0).optional().nullable(),
	interval_months: z.number().int().min(0).optional().nullable(),
	cost: z.number().min(0).optional().nullable(),
	vendor_name: z.string().optional().nullable(),
	notes: z.string().optional().nullable(),
	source_purchase_line_id: z.string().optional().nullable(),
	source_field_purchase_line_id: z.string().optional().nullable(),
	reminder_ids: z.array(z.string()).optional(),
});
export const UpdateMaintenanceRecordSchema = CreateMaintenanceRecordSchema.omit({ reminder_ids: true }).partial();

export type CreateMaintenanceRecordInput = z.infer<typeof CreateMaintenanceRecordSchema>;
export type UpdateMaintenanceRecordInput = Partial<CreateMaintenanceRecordInput>;

export interface VehicleMaintenanceReminder {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: MaintenanceCategory;
	title: string;
	description: string | null;
	interval_miles: number | null;
	interval_unit: IntervalUnit | null;
	interval_count: number | null;
	repeats: boolean;
	due_at: string | null;
	due_odometer_mi: number | null;
	completed_at: string | null;
	acknowledged_at: string | null;
	baseline_at: string | null;
	baseline_odometer_mi: number | null;
	created_at: string;
	updated_at: string;
}

export type IntervalUnit = "days" | "weeks" | "months" | "years";

export const CreateMaintenanceReminderSchema = z.object({
	category: z.enum(["oil_change", "fluids", "tire", "brake", "inspection", "registration", "repair", "other"]),
	title: z.string().min(1),
	description: z.string().optional().nullable(),
	interval_miles: z.number().int().min(0).optional().nullable(),
	interval_unit: z.enum(["days", "weeks", "months", "years"]).optional().nullable(),
	interval_count: z.number().int().min(1).optional().nullable(),
	repeats: z.boolean().optional().default(true),
	due_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "due_at must be YYYY-MM-DD").optional().nullable(),
	due_odometer_mi: z.number().int().min(0).optional().nullable(),
});
export const UpdateMaintenanceReminderSchema = CreateMaintenanceReminderSchema.partial();

export type CreateMaintenanceReminderInput = z.infer<typeof CreateMaintenanceReminderSchema>;
export type UpdateMaintenanceReminderInput = Partial<CreateMaintenanceReminderInput>;

export interface MaintenanceSourceLine {
	id: string;
	source: "purchase" | "field_purchase";
	description: string;
	vendor_name: string | null;
	cost: number;
	date: string | null;
	reference: string | null;
}

