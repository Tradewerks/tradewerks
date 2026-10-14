// Plain-JSON response shapes for the vehicle-stock domain (stock items, restock
// history/requests, adjustments, movements) — converts Prisma Decimal quantity
// fields to real numbers and Date fields to ISO strings so the wire format
// matches what the frontend actually consumes, rather than leaving every read
// site to silently receive Decimal-as-string and re-coerce it with `Number(...)`.
import type {
	vehicle_stock_item,
	inventory_item,
	vehicle_restock_line,
	vehicle_stock_adjustment_line,
	vehicle_restock_request,
	stock_movement,
	Prisma,
} from "../../../generated/prisma/client.js";
import { mapInventoryItem, type InventoryItemDTO } from "./inventory.js";

// ── Vehicle stock item ──────────────────────────────────────────────────────

export type VehicleStockItemDTO = Omit<
	vehicle_stock_item,
	"qty_on_hand" | "qty_min" | "qty_standard" | "created_at" | "updated_at"
> & {
	qty_on_hand: number;
	qty_min: number;
	qty_standard: number | null;
	created_at: string;
	updated_at: string;
};

export type VehicleStockItemWithInventoryDTO = VehicleStockItemDTO & {
	inventory_item: InventoryItemDTO;
};

function mapStockItemQuantities(item: vehicle_stock_item): VehicleStockItemDTO {
	return {
		...item,
		qty_on_hand: Number(item.qty_on_hand),
		qty_min: Number(item.qty_min),
		qty_standard: item.qty_standard == null ? null : Number(item.qty_standard),
		created_at: item.created_at.toISOString(),
		updated_at: item.updated_at.toISOString(),
	};
}

export function mapVehicleStockItem(item: vehicle_stock_item): VehicleStockItemDTO {
	return mapStockItemQuantities(item);
}

export function mapVehicleStockItemWithInventory(
	item: vehicle_stock_item & { inventory_item: inventory_item },
): VehicleStockItemWithInventoryDTO {
	const { inventory_item, ...rest } = item;
	return { ...mapStockItemQuantities(rest), inventory_item: mapInventoryItem(inventory_item) };
}

// ── Restock lines / history ─────────────────────────────────────────────────

export type VehicleRestockLineDTO = Omit<vehicle_restock_line, "qty_restocked" | "qty_shortfall"> & {
	qty_restocked: number;
	qty_shortfall: number;
};

export function mapRestockLine(line: vehicle_restock_line): VehicleRestockLineDTO {
	return {
		...line,
		qty_restocked: Number(line.qty_restocked),
		qty_shortfall: Number(line.qty_shortfall),
	};
}

type PersonRef = { id: string; name: string } | null;

export interface RestockHistoryRecordDTO {
	id: string;
	vehicle_id: string;
	organization_id: string;
	completed_at: string;
	mode: string;
	notes: string | null;
	restock_lines: VehicleRestockLineDTO[];
	completed_by: PersonRef;
	completed_by_tech: PersonRef;
}

export function mapRestockHistoryRecord(record: {
	id: string;
	vehicle_id: string;
	organization_id: string;
	completed_at: Date;
	mode: string;
	notes: string | null;
	restock_lines: vehicle_restock_line[];
	completed_by: PersonRef;
	completed_by_tech: PersonRef;
}): RestockHistoryRecordDTO {
	return {
		id: record.id,
		vehicle_id: record.vehicle_id,
		organization_id: record.organization_id,
		completed_at: record.completed_at.toISOString(),
		mode: record.mode,
		notes: record.notes,
		restock_lines: record.restock_lines.map(mapRestockLine),
		completed_by: record.completed_by,
		completed_by_tech: record.completed_by_tech,
	};
}

// ── Adjustment lines / history ──────────────────────────────────────────────

export type VehicleStockAdjustmentLineDTO = Omit<
	vehicle_stock_adjustment_line,
	"qty_before" | "qty_after" | "inventory_impact"
> & {
	qty_before: number;
	qty_after: number;
	inventory_impact: number;
};

export function mapAdjustmentLine(line: vehicle_stock_adjustment_line): VehicleStockAdjustmentLineDTO {
	return {
		...line,
		qty_before: Number(line.qty_before),
		qty_after: Number(line.qty_after),
		inventory_impact: Number(line.inventory_impact),
	};
}

export interface StockAdjustmentRecordDTO {
	id: string;
	vehicle_id: string;
	organization_id: string;
	type: string;
	note: string | null;
	created_at: string;
	lines: VehicleStockAdjustmentLineDTO[];
	created_by: PersonRef;
	created_by_tech: PersonRef;
}

export function mapStockAdjustmentRecord(record: {
	id: string;
	vehicle_id: string;
	organization_id: string;
	type: string;
	note: string | null;
	created_at: Date;
	lines: vehicle_stock_adjustment_line[];
	created_by: PersonRef;
	created_by_tech: PersonRef;
}): StockAdjustmentRecordDTO {
	return {
		id: record.id,
		vehicle_id: record.vehicle_id,
		organization_id: record.organization_id,
		type: record.type,
		note: record.note,
		created_at: record.created_at.toISOString(),
		lines: record.lines.map(mapAdjustmentLine),
		created_by: record.created_by,
		created_by_tech: record.created_by_tech,
	};
}

// ── Restock requests ─────────────────────────────────────────────────────────

export type VehicleRestockRequestDTO = Omit<
	vehicle_restock_request,
	"qty_requested" | "created_at" | "acknowledged_at" | "resolved_at"
> & {
	qty_requested: number | null;
	created_at: string;
	acknowledged_at: string | null;
	resolved_at: string | null;
};

export function mapRestockRequest(request: vehicle_restock_request): VehicleRestockRequestDTO {
	return {
		...request,
		qty_requested: request.qty_requested == null ? null : Number(request.qty_requested),
		created_at: request.created_at.toISOString(),
		acknowledged_at: request.acknowledged_at ? request.acknowledged_at.toISOString() : null,
		resolved_at: request.resolved_at ? request.resolved_at.toISOString() : null,
	};
}

// ── Stock movements ──────────────────────────────────────────────────────────

export type StockMovementDTO = Omit<stock_movement, "qty" | "created_at"> & {
	qty: number;
	created_at: string;
};

export function mapStockMovement(movement: stock_movement): StockMovementDTO {
	return {
		...movement,
		qty: Number(movement.qty),
		created_at: movement.created_at.toISOString(),
	};
}

// ── Vehicle Maintenance ──────────────────────────────────────────────────────────

export interface VehicleMaintenanceRecordDTO {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: string;
	performed_at: string;
	odometer_mi: number | null;
	interval_miles: number | null;
	interval_months: number | null;
	cost: number | null;
	vendor_name: string | null;
	notes: string | null;
	performed_by: PersonRef;
	performed_by_tech: PersonRef;
	source_purchase_line_id: string | null;
	source_field_purchase_line_id: string | null;
	// Parent of the source line — what "linked purchase" navigates to.
	source_purchase_id: string | null;
	source_field_purchase_id: string | null;
	created_at: string;
	updated_at: string;
}

interface VehicleRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: string;
	performed_at: Date;
	odometer_mi: number | null;
	interval_miles: number | null;
	interval_months: number | null;
	cost: Prisma.Decimal | null;
	vendor_name: string | null;
	notes: string | null;
	performed_by: PersonRef;
	performed_by_tech: PersonRef;
	source_purchase_line_id: string | null;
	source_field_purchase_line_id: string | null;
	source_purchase_line: { purchase_id: string } | null;
	source_field_purchase_line: { field_purchase_id: string } | null;
	created_at: Date;
	updated_at: Date;
}

export function mapMaintenanceRecord(record: VehicleRecord): VehicleMaintenanceRecordDTO {
	const { source_purchase_line, source_field_purchase_line, ...rest } = record;
	return {
		...rest,
		performed_at: record.performed_at.toISOString(),
		cost: record.cost == null ? null : Number(record.cost),
		source_purchase_id: source_purchase_line?.purchase_id ?? null,
		source_field_purchase_id: source_field_purchase_line?.field_purchase_id ?? null,
		created_at: record.created_at.toISOString(),
		updated_at: record.updated_at.toISOString(),
	};
}

// ── Vehicle Maintenance Reminders ───────────────────────────────────────────

export interface VehicleMaintenanceReminderDTO {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: string;
	title: string;
	description: string | null;
	interval_miles: number | null;
	interval_unit: string | null;
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

interface VehicleReminderRecord {
	id: string;
	vehicle_id: string;
	organization_id: string;
	category: string;
	title: string;
	description: string | null;
	interval_miles: number | null;
	interval_unit: string | null;
	interval_count: number | null;
	repeats: boolean;
	due_at: Date | null;
	due_odometer_mi: number | null;
	completed_at: Date | null;
	acknowledged_at: Date | null;
	baseline_at: Date | null;
	baseline_odometer_mi: number | null;
	created_at: Date;
	updated_at: Date;
}

export function mapMaintenanceReminder(record: VehicleReminderRecord): VehicleMaintenanceReminderDTO {
	return {
		...record,
		due_at: record.due_at ? record.due_at.toISOString() : null,
		completed_at: record.completed_at ? record.completed_at.toISOString() : null,
		acknowledged_at: record.acknowledged_at ? record.acknowledged_at.toISOString() : null,
		baseline_at: record.baseline_at ? record.baseline_at.toISOString() : null,
		created_at: record.created_at.toISOString(),
		updated_at: record.updated_at.toISOString(),
	};
}


