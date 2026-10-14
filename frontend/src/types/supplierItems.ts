/**
 * What one vendor charges for one item — the price list behind "buy 12 from
 * Ferguson". Mirrors SUPPLIER_ITEM_SELECT in supplierItemsController.ts.
 */
export interface SupplierItem {
	id: string;
	supplier_id: string;
	inventory_item_id: string;
	/** The vendor's own part number, which is what you order by. */
	vendor_sku: string | null;
	/** Negotiated, entered by hand. Beats last_price wherever a single price is shown. */
	contract_price: number | null;
	/** Observed — written by the ledger on every attributed purchase, never edited. */
	last_price: number | null;
	last_purchased_at: string | null;
	is_preferred: boolean;
	lead_time_days: number | null;
	min_order_qty: number | null;
	notes: string | null;
	created_at: string;
	updated_at: string;
	supplier: { id: string; name: string; is_active: boolean };
	inventory_item: { id: string; name: string; sku: string | null; unit: string };
}

/**
 * Fields an operator can set. `last_price` is absent on purpose — it's an
 * observation from the ledger, not an opinion.
 */
export interface SupplierItemInput {
	vendor_sku?: string | null;
	contract_price?: number | null;
	lead_time_days?: number | null;
	min_order_qty?: number | null;
	notes?: string | null;
	is_preferred?: boolean;
}

export interface UpsertSupplierItemInput extends SupplierItemInput {
	supplier_id: string;
	inventory_item_id: string;
}

/** The price actually shown for a vendor, and which figure it came from. */
export function effectivePrice(row: SupplierItem): {
	price: number | null;
	source: "contract" | "observed" | "none";
} {
	if (row.contract_price != null) return { price: row.contract_price, source: "contract" };
	if (row.last_price != null) return { price: row.last_price, source: "observed" };
	return { price: null, source: "none" };
}
