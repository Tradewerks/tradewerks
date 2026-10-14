import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Star, Plus, Trash2, X, Check } from "lucide-react";
import Card from "../../ui/Card";
import SupplierPicker from "../SupplierPicker";
import { useToast } from "../../ui/useToast";
import { usePermission } from "../../../hooks/usePermission";
import {
	useSupplierItems,
	useUpsertSupplierItem,
	usePreferSupplierItem,
	useDeleteSupplierItem,
} from "../../../hooks/useSupplierItems";
import { formatCurrency, formatDate } from "../../../util/util";
import { effectivePrice, type SupplierItem } from "../../../types/supplierItems";
import type { SupplierCapture } from "../../../types/suppliers";

// Rows shown before the grid collapses behind "+N more" — same convention as
// the Details card's Alt IDs. Six fills two rows of the 3-wide tile grid at
// full width, so the expander only ever appears for a genuinely long list.
const SUPPLIER_PREVIEW = 6;

// Double-click to delete, not a confirm dialog: the row's own trash button
// doubles as its own confirmation. First click arms it (visibly, for
// ARM_MS); a second click while armed removes it; letting it sit disarms
// automatically rather than leaving a "did I mean to do that?" button live.
const ARM_MS = 2500;

/**
 * Where this item can be bought, and for how much.
 *
 * Rows arrive preferred-first from the server. The price shown is the negotiated
 * contract rate when there is one, otherwise the last price actually paid —
 * labelled either way, because "what we agreed" and "what we happened to pay
 * last time" support different decisions.
 */
export default function ItemSuppliersCard({
	itemId,
	unit,
}: {
	itemId: string;
	unit: string | null;
}) {
	const canManage = usePermission("manage_inventory");
	const toast = useToast();
	const { data: rows = [], isLoading } = useSupplierItems({ inventory_item_id: itemId });

	const [adding, setAdding] = useState(false);
	const [supplier, setSupplier] = useState<SupplierCapture>({});
	const [vendorSku, setVendorSku] = useState("");
	const [price, setPrice] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState(false);
	// Only one row can be armed at a time — arming a different row's trash
	// button disarms whichever was armed before it.
	const [armedId, setArmedId] = useState<string | null>(null);
	const armTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current);
		};
	}, []);

	const upsert = useUpsertSupplierItem();
	const prefer = usePreferSupplierItem();
	const remove = useDeleteSupplierItem();

	const resetForm = () => {
		setAdding(false);
		setSupplier({});
		setVendorSku("");
		setPrice("");
		setError(null);
	};

	const handleAdd = async () => {
		// An id, not a name: a price-list row points at a vendor record, so a
		// never-before-seen name has to become a supplier first (via the Suppliers
		// page, or by being named on any receipt) before it can carry a price.
		if (!supplier.supplier_id) {
			setError(
				supplier.supplier_name
					? "Create this supplier first — a price list entry needs an existing vendor."
					: "Pick a supplier.",
			);
			return;
		}
		const parsedPrice = price.trim() === "" ? null : Number(price);
		if (parsedPrice != null && (!Number.isFinite(parsedPrice) || parsedPrice < 0)) {
			setError("Contract price must be 0 or more, or left blank.");
			return;
		}
		try {
			await upsert.mutateAsync({
				supplier_id: supplier.supplier_id,
				inventory_item_id: itemId,
				vendor_sku: vendorSku.trim() || null,
				contract_price: parsedPrice,
			});
			toast.success("Supplier price saved");
			resetForm();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Failed to save supplier price");
		}
	};

	const handlePrefer = async (row: SupplierItem) => {
		try {
			await prefer.mutateAsync(row.id);
			toast.success(`${row.supplier.name} is now the preferred supplier`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to set preferred supplier");
		}
	};

	const handleRemove = async (row: SupplierItem) => {
		try {
			await remove.mutateAsync(row.id);
			toast.success(`Removed ${row.supplier.name}`);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Failed to remove supplier");
		}
	};

	const handleDeleteClick = (row: SupplierItem) => {
		if (armTimeoutRef.current) clearTimeout(armTimeoutRef.current);
		if (armedId === row.id) {
			setArmedId(null);
			handleRemove(row);
			return;
		}
		setArmedId(row.id);
		armTimeoutRef.current = setTimeout(() => setArmedId(null), ARM_MS);
	};

	// Gates the part-# reveal below and (loosely) the save affordance — not a
	// hard requirement, handleAdd still owns the real validation and its error
	// message, this just decides whether there's enough here yet to bother
	// showing the second field.
	const hasSupplier = !!(supplier.supplier_id || supplier.supplier_name);

	const handleComposerKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter") handleAdd();
		if (e.key === "Escape") resetForm();
	};

	return (
		<Card
			title="Suppliers & Pricing"
			headerAction={
				canManage && !adding ? (
					<button
						onClick={() => setAdding(true)}
						className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors"
					>
						<Plus size={12} />
						Add supplier
					</button>
				) : null
			}
		>
			{isLoading ? (
				<p className="text-sm text-text-muted">Loading…</p>
			) : !adding && rows.length === 0 ? (
				<p className="text-sm text-text-muted">
					No suppliers recorded. Naming a vendor when you receive stock adds one here
					automatically, with the price paid.
				</p>
			) : (
				<>
					{/* Tiles, not a stacked list: this card runs full width below
					    the two-column grid, so N suppliers wrap into rows instead
					    of one column growing tall — a long price list no longer
					    makes the page's closing band unpredictably long. */}
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
						{/* The composer IS a tile — same three-zone shape (name |
						    price | actions) the real rows use below, filled in with
						    inputs instead of read text and Check/X instead of
						    Star/Trash. A dashed border marks it as not-yet-real
						    rather than reusing the preferred row's solid primary
						    tint, which already means something else here. What
						    you're adding previews in the exact shape it'll take. */}
						{adding && (
							<div className="flex items-stretch overflow-hidden rounded-lg border border-dashed border-primary/50 bg-primary-hover/[.04] transition-colors">
								<div className="min-w-0 flex-1 p-2.5">
									<SupplierPicker
										value={supplier}
										onChange={(v) => {
											setSupplier(v);
											setError(null);
										}}
										label=""
										placeholder="Supplier name…"
									/>
									{/* Revealed, not just shown: the part # only means
									    anything once a vendor is picked, so it stays
									    collapsed until then instead of presenting three
									    empty fields at once. */}
									<div
										className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out ${
											hasSupplier ? "mt-1.5 grid-rows-[1fr]" : "grid-rows-[0fr]"
										}`}
									>
										<div className="overflow-hidden">
											<input
												type="text"
												value={vendorSku}
												onChange={(e) => setVendorSku(e.target.value)}
												onKeyDown={handleComposerKeyDown}
												tabIndex={hasSupplier ? 0 : -1}
												aria-hidden={!hasSupplier}
												placeholder="Their part # (optional)"
												aria-label="Vendor part number"
												className="h-7 w-full min-w-0 rounded border border-border-input bg-base px-2 text-xs text-text-primary placeholder:text-faint focus:border-primary focus:outline-none transition-colors"
											/>
										</div>
									</div>
									{error && (
										<p className="mt-1 text-[11px] text-error-text">{error}</p>
									)}
								</div>

								<div className="flex shrink-0 flex-col justify-center border-l border-border-subtle/70 px-2.5 py-2 text-right">
									<input
										type="number"
										min={0}
										step="0.01"
										value={price}
										onChange={(e) => setPrice(e.target.value)}
										onKeyDown={handleComposerKeyDown}
										placeholder="—"
										aria-label="Contract price"
										className="w-20 bg-transparent text-right text-sm font-semibold tabular-nums text-text-primary placeholder:text-text-faint placeholder:font-normal focus:outline-none"
									/>
									<div className="text-[10px] uppercase tracking-wider text-text-muted">
										Contract
									</div>
								</div>

								<div className="flex shrink-0 divide-x divide-border-subtle/70 border-l border-border-subtle/70">
									<button
										type="button"
										onClick={handleAdd}
										disabled={upsert.isPending}
										aria-label="Save supplier"
										title="Save"
										className="flex w-10 items-center justify-center text-text-tertiary transition-colors hover:bg-primary-bg hover:text-primary-text disabled:opacity-40"
									>
										<Check size={16} />
									</button>
									<button
										type="button"
										onClick={resetForm}
										aria-label="Cancel"
										title="Cancel"
										className="flex w-10 items-center justify-center text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
									>
										<X size={14} />
									</button>
								</div>
							</div>
						)}

						{(expanded ? rows : rows.slice(0, SUPPLIER_PREVIEW)).map((row) => {
							const { price: shown, source } = effectivePrice(row);
							return (
								<div
									key={row.id}
									className={`flex items-stretch overflow-hidden rounded-lg border transition-colors ${
										row.is_preferred
											? "border-primary/40 bg-primary-hover/[.06]"
											: "border-border-subtle"
									}`}
								>
									<div className="min-w-0 flex-1 p-2.5">
										<div className="flex items-center gap-1.5">
											<span className="text-sm font-medium text-text-primary truncate">
												{row.supplier.name}
											</span>
											{row.is_preferred && (
												<span className="inline-flex items-center gap-0.5 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wider text-primary">
													<Star size={9} fill="currentColor" />
													Preferred
												</span>
											)}
										</div>
										<div className="mt-0.5 text-[11px] text-text-muted">
											{row.vendor_sku ? `Part ${row.vendor_sku}` : "No part #"}
											{row.last_purchased_at &&
												` · last bought ${formatDate(row.last_purchased_at)}`}
											{row.lead_time_days != null &&
												` · ${row.lead_time_days}d lead`}
										</div>
									</div>

									<div className="flex shrink-0 flex-col justify-center border-l border-border-subtle/70 px-2.5 py-2 text-right">
										<div className="text-sm font-semibold tabular-nums text-text-primary">
											{shown != null ? formatCurrency(shown) : "—"}
											{shown != null && unit && (
												<span className="text-[11px] font-normal text-text-muted">
													{" "}
													/ {unit}
												</span>
											)}
										</div>
										{/* Which figure this is, always — a negotiated rate and
										    a one-off counter price are not the same claim. */}
										<div className="text-[10px] uppercase tracking-wider text-text-muted">
											{source === "contract"
												? "Contract"
												: source === "observed"
													? "Last paid"
													: "No price"}
										</div>
									</div>

									{/* A sectioned rail, not a line of its own: at two lines
									    of content, a bottom action row was mostly border and
									    air. Full-height and divided from the price column, it
									    reads as a third zone of the card instead of a floating
									    afterthought — and the bigger hit targets are the point,
									    not a side effect of the space. */}
									{canManage && (
										<div className="flex shrink-0 divide-x divide-border-subtle/70 border-l border-border-subtle/70">
											{!row.is_preferred && (
												<button
													onClick={() => handlePrefer(row)}
													disabled={prefer.isPending}
													aria-label={`Make ${row.supplier.name} preferred`}
													title="Make preferred"
													className="flex w-10 items-center justify-center text-text-tertiary transition-colors hover:bg-primary-bg hover:text-primary-text disabled:opacity-40"
												>
													<Star size={16} />
												</button>
											)}
											<button
												onClick={() => handleDeleteClick(row)}
												disabled={remove.isPending}
												aria-label={
													armedId === row.id
														? `Click again to remove ${row.supplier.name}`
														: `Remove ${row.supplier.name}`
												}
												title={armedId === row.id ? "Click again to remove" : "Remove"}
												className={`flex w-10 items-center justify-center transition-colors disabled:opacity-40 ${
													armedId === row.id
														? "bg-error text-on-primary hover:bg-error-strong"
														: "text-text-tertiary hover:bg-error-bg hover:text-error-text"
												}`}
											>
												<Trash2 size={16} />
											</button>
										</div>
									)}
								</div>
							);
						})}
					</div>
					{rows.length > SUPPLIER_PREVIEW && (
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							className="mt-2 text-xs font-medium text-primary hover:underline"
						>
							{expanded ? "Show fewer" : `Show ${rows.length - SUPPLIER_PREVIEW} more`}
						</button>
					)}
				</>
			)}
		</Card>
	);
}
