import type { StockLocationType } from "./inventory";

/**
 * Mirrors PURCHASE_SELECT/LINE_SELECT in purchasesController.ts.
 * Money is a string (numeric(10,2)) to avoid float rounding.
 */

export type PurchaseStatus = "draft" | "ordered" | "partially_received" | "received" | "cancelled";

/** Mirrors OPEN_PURCHASE_STATUSES in purchasesController.ts. */
export const OPEN_PURCHASE_STATUSES: readonly PurchaseStatus[] = [
	"draft",
	"ordered",
	"partially_received",
];

export const isOpenPurchase = (status: PurchaseStatus): boolean =>
	OPEN_PURCHASE_STATUSES.includes(status);

/** A refund is the same shape pointing back at the purchase it reverses. */
export type PurchaseKind = "purchase" | "refund";

/** Job allocation only valid on a `non_stock` line. */
export type PurchaseLineDisposition = "receive" | "non_stock";

export interface PurchaseLine {
	id: string;
	description: string;
	quantity: string;
	unit_price: string;
	line_total: string;
	inventory_item_id: string | null;
	disposition: PurchaseLineDisposition | null;
	disposition_location: StockLocationType | null;
	disposition_vehicle_id: string | null;
	quantity_recieved: string;
	received_at: string | null;
	/** Links to `allocations` below. */
	allocation_id: string | null;
	sort_order: number;
	inventory_item: {
		id: string;
		name: string;
		sku: string | null;
		unit: string;
		barcode: string | null;
		location: string | null;
	} | null;
	disposition_vehicle: { id: string; name: string } | null;
}

export interface PurchaseAllocation {
	id: string;
	job_id: string;
	/** Visit the charge lands on, if any. */
	job_visit_id: string | null;
	/** Derived from lines, never typed. */
	amount: string;
	job: { id: string; job_number: string | null; name: string | null } | null;
	job_visit: { id: string; name: string | null; scheduled_start_at: string | null } | null;
}

export interface Purchase {
	id: string;
	purchase_number: string;
	status: PurchaseStatus;
	kind: PurchaseKind;
	vendor_name: string | null;
	supplier_id: string | null;
	purchased_at: string | null;
	subtotal: string;
	tax_group_id: string | null;
	tax_amount: string;
	total: string;
	submitted_at: string | null;
	cancelled_at: string | null;
	cancellation_reason: string | null;
	/** Unused — always `[]` today. */
	flags: unknown[];
	created_at: string;
	updated_at: string;
	qb_purchase_id: string | null;
	qb_sync_status: "not_synced" | "synced" | "failed";
	supplier: { id: string; name: string } | null;
	tax_group: { id: string; name: string } | null;
	lines: PurchaseLine[];
	allocations: PurchaseAllocation[];
}

/** Append-only trail. */
export interface PurchaseEvent {
	id: string;
	type: string;
	actor_type: string;
	actor_id: string | null;
	detail: Record<string, unknown>;
	at: string;
}

export interface PurchaseDetail {
	purchase: Purchase;
	events: PurchaseEvent[];
}

export type PurchaseSort = "newest" | "oldest" | "amount_desc" | "amount_asc";

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
	draft: "Draft",
	ordered: "Ordered",
	partially_received: "Partially received",
	received: "Received",
	cancelled: "Cancelled",
};

export const PURCHASE_STATUS_COLORS: Record<PurchaseStatus, string> = {
	draft: "bg-neutral/20 text-text-tertiary border-border-strong/30",
	ordered: "bg-primary/20 text-primary-text border-primary/30",
	partially_received: "bg-warning/20 text-warning-text border-warning/30",
	received: "bg-success/20 text-success-text border-success/30",
	cancelled: "bg-error/20 text-error-text border-error/30",
};

export const DISPOSITION_LABELS: Record<PurchaseLineDisposition, string> = {
	receive: "Added to stock",
	non_stock: "Consumed on job",
};
