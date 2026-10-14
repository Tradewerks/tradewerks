/**
 * Identity that a receipt marker and a supplier rollup row agree on.
 *
 * Falls back to the NAME because a legacy free-text vendor has no id — matching
 * on id alone would leave every pre-migration purchase unhighlightable. Returns
 * "" when the origin was never recorded, which is the unattributed bucket.
 */
export function supplierKey(supplierId: string | null, supplierName: string | null): string {
	// normalizeSupplierName (not a plain .toLowerCase()) so two legacy receipts
	// differing only in internal whitespace ("Grainger Co" vs "Grainger  Co")
	// key the same way the backend's rollup already groups them — otherwise the
	// hover-highlight in SupplierOriginStrip misses a receipt the rollup counts
	// as the same vendor.
	return supplierId ?? (supplierName ? `name:${normalizeSupplierName(supplierName)}` : "");
}

/**
 * Same normalization the backend keys suppliers on (`normalizeSupplierName` in
 * services/suppliers.ts). Kept in sync so the picker adopts exactly the vendors
 * the server would consider duplicates — case and spacing only, never fuzzy.
 */
export function normalizeSupplierName(name: string): string {
	return name.trim().replace(/\s+/g, " ").toLowerCase();
}
