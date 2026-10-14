import { Link } from "react-router-dom";
import { Star } from "lucide-react";
import Card from "../ui/Card";
import { useSupplierItems } from "../../hooks/useSupplierItems";
import { effectivePrice } from "../../types/supplierItems";
import { formatCurrency, formatDate } from "../../util/util";

/**
 * Read-only price list for one vendor, across every item it quotes — the
 * cross-item counterpart to ItemSuppliersCard, which shows the same
 * supplier_item rows scoped to one item instead. Editing a price stays on the
 * item detail page (ItemSuppliersCard already owns that write path); this
 * view only answers "what do we buy from them, and at what price".
 */
export default function SupplierPriceList({ supplierId }: { supplierId: string }) {
	const { data: rows = [], isLoading } = useSupplierItems({ supplier_id: supplierId });

	return (
		<Card title="Price List">
			{isLoading ? (
				<p className="text-sm text-text-muted">Loading…</p>
			) : rows.length === 0 ? (
				<p className="text-sm text-text-muted">
					No items priced yet. Naming this vendor when you receive stock adds one here
					automatically, with the price paid.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-text-tertiary text-[10px] uppercase tracking-wider">
								<th className="text-left font-semibold py-1.5 pr-3">Item</th>
								<th className="text-left font-semibold py-1.5 px-2">Their Part #</th>
								<th className="text-right font-semibold py-1.5 px-2">Price</th>
								<th className="text-left font-semibold py-1.5 pl-2">Last Bought</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => {
								const { price: shown, source } = effectivePrice(row);
								return (
									<tr
										key={row.id}
										className="border-t border-border-subtle/60"
									>
										<td className="py-1.5 pr-3">
											<Link
												to={`/dispatch/inventory/items/${row.inventory_item.id}`}
												className="font-medium text-text-primary hover:text-primary hover:underline"
											>
												{row.inventory_item.name}
											</Link>
											{row.is_preferred && (
												<span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary align-middle">
													<Star size={9} fill="currentColor" />
													Preferred
												</span>
											)}
										</td>
										<td className="py-1.5 px-2 text-text-secondary">
											{row.vendor_sku ?? "—"}
										</td>
										<td className="py-1.5 px-2 text-right">
											<span className="font-semibold text-text-primary tabular-nums">
												{shown != null ? formatCurrency(shown) : "—"}
											</span>
											{shown != null && (
												<span className="ml-1 text-[10px] uppercase tracking-wider text-text-muted">
													{source === "contract" ? "contract" : "last paid"}
												</span>
											)}
										</td>
										<td className="py-1.5 pl-2 text-text-tertiary">
											{row.last_purchased_at ? formatDate(row.last_purchased_at) : "—"}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}
