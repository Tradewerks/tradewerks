import type { StockLocationType, StockMovementReason } from "./inventory";

/** Vendor stock is bought FROM. Mirrors SUPPLIER_SELECT in suppliersController.ts. */
export interface Supplier {
	id: string;
	name: string;
	account_number: string | null;
	contact_name: string | null;
	phone: string | null;
	email: string | null;
	notes: string | null;
	is_active: boolean;
	created_at: string;
	updated_at: string;
	/** Only present when the list was requested with `include_usage`. */
	_count?: { movements: number; batches: number };
}

export interface SupplierMergeResult {
	moved: { movements: number; batches: number; supplierItems: number };
	target: Supplier;
}

/**
 * What every intake form submits. `supplier_id` adopts an existing vendor;
 * `supplier_name` creates one on write. Both absent = an unattributed receipt,
 * which is allowed on every path — a blocked receive over missing vendor
 * metadata is worse than an unattributed one.
 */
export interface SupplierCapture {
	supplier_id?: string;
	supplier_name?: string;
}

/** GET /suppliers/:id — same row as the list, usage counts always present. */
export interface SupplierDetail extends Supplier {
	_count: { movements: number; batches: number };
}

/**
 * One row of a vendor's purchase ledger. Mirrors StockMovement (types/inventory.ts)
 * with the item swapped in for the vehicle-only context that type assumes — a
 * vendor's ledger crosses items, so each row has to name which one.
 */
export interface SupplierMovement {
	id: string;
	qty: number | string;
	unit: string;
	unit_cost: number | string | null;
	inventory_item: { id: string; name: string; sku: string | null; unit: string };
	from_location_type: StockLocationType;
	from_vehicle: { id: string; name: string } | null;
	to_location_type: StockLocationType;
	to_vehicle: { id: string; name: string } | null;
	reason: StockMovementReason;
	note: string | null;
	actor_type: string;
	created_at: string;
}

export interface SupplierMovementsPage {
	movements: SupplierMovement[];
	nextCursor: string | null;
}

/** One lot this vendor supplied, across whichever item it was received for. */
export interface SupplierBatch {
	id: string;
	item_id: string;
	item_name: string;
	item_sku: string | null;
	batch_number: string;
	received_at: string;
	expires_at: string | null;
	recalled_at: string | null;
	qty_received: number;
	qty_in_warehouse: number;
	unit_cost: number | null;
}
