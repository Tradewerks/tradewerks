import { Link } from "react-router-dom";
import { Ban } from "lucide-react";
import Card from "../ui/Card";
import { useSupplierBatchesQuery } from "../../hooks/useSuppliers";
import { formatDate } from "../../util/util";

/** Every lot this vendor supplied, across whichever item it was received for. */
export default function SupplierBatchesTable({ supplierId }: { supplierId: string }) {
	const { data: batches = [], isLoading } = useSupplierBatchesQuery(supplierId);

	return (
		<Card title="Lots Supplied">
			{isLoading ? (
				<p className="text-sm text-text-muted">Loading…</p>
			) : batches.length === 0 ? (
				<p className="text-sm text-text-muted">
					No batch-tracked lots from this vendor yet.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-sm">
						<thead>
							<tr className="text-text-tertiary text-[10px] uppercase tracking-wider">
								<th className="text-left font-semibold py-1.5 pr-3">Item</th>
								<th className="text-left font-semibold py-1.5 px-2">Lot #</th>
								<th className="text-left font-semibold py-1.5 px-2">Received</th>
								<th className="text-right font-semibold py-1.5 px-2">Received Qty</th>
								<th className="text-right font-semibold py-1.5 pl-2">In Warehouse</th>
							</tr>
						</thead>
						<tbody>
							{batches.map((b) => (
								<tr key={b.id} className="border-t border-border-subtle/60">
									<td className="py-1.5 pr-3">
										<Link
											to={`/dispatch/inventory/items/${b.item_id}`}
											className="font-medium text-text-primary hover:text-primary hover:underline"
										>
											{b.item_name}
										</Link>
										{b.recalled_at && (
											<span className="ml-1.5 inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-error-text align-middle">
												<Ban size={9} />
												Recalled
											</span>
										)}
									</td>
									<td className="py-1.5 px-2 text-text-secondary font-mono text-xs">
										{b.batch_number}
									</td>
									<td className="py-1.5 px-2 text-text-tertiary">
										{formatDate(b.received_at)}
									</td>
									<td className="py-1.5 px-2 text-right tabular-nums text-text-primary">
										{b.qty_received}
									</td>
									<td className="py-1.5 pl-2 text-right tabular-nums text-text-secondary">
										{b.qty_in_warehouse}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}
