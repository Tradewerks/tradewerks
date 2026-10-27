import { useState } from "react";
import { Search, Trash2, X, ArrowRight } from "lucide-react";
import { useDeleteVehicleStockItemMutation } from "../../hooks/useVehicleStock";
import { useToast } from "../ui/useToast";
import { errorMessage } from "../../util/util";
import type { VehicleStockItem } from "../../types/vehicles";

export interface RemoveStockItemSheetProps {
	vehicleId: string;
	stockItems: VehicleStockItem[];
	/** Opens AdjustStockModal focused on this item so the tech can zero it out. */
	onAdjust: (item: VehicleStockItem) => void;
}

// Removing a stock item is gated on qty_on_hand === 0 — a tech can't drop a line
// that still carries stock, only zero it via Adjust first. The backend would
// defensively zero any remainder, but gating here keeps real on-vehicle stock
// from being discarded by an accidental tap.
export default function RemoveStockItemSheet({
	vehicleId,
	stockItems,
	onAdjust,
}: RemoveStockItemSheetProps) {
	const [search, setSearch] = useState("");
	const [confirmingId, setConfirmingId] = useState<string | null>(null);
	const deleteMutation = useDeleteVehicleStockItemMutation();
	const toast = useToast();

	const q = search.toLowerCase().trim();
	const rows = stockItems
		.filter((item) => !q || item.inventory_item.name.toLowerCase().includes(q))
		.sort((a, b) => a.inventory_item.name.localeCompare(b.inventory_item.name));

	const handleRemove = async (item: VehicleStockItem) => {
		try {
			await deleteMutation.mutateAsync({ vehicleId, itemId: item.id });
			toast.success(`Removed ${item.inventory_item.name} from stock list`);
			setConfirmingId(null);
		} catch (e) {
			toast.error(errorMessage(e, "Failed to remove item"));
		}
	};

	if (stockItems.length === 0) {
		return (
			<p className="px-4 py-6 text-xs text-text-muted text-center">
				No items on this vehicle's stock list.
			</p>
		);
	}

	return (
		<div className="px-4 py-3 space-y-3">
			<div className="flex items-center gap-2 bg-surface-inset border border-border rounded-lg px-3 py-1.5">
				<Search size={13} className="text-text-faint flex-shrink-0" />
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search stock list…"
					className="flex-1 text-sm bg-transparent text-text-primary placeholder:text-faint outline-none"
				/>
				{search && (
					<button
						onClick={() => setSearch("")}
						aria-label="Clear search"
						className="text-text-faint hover:text-text-secondary transition-colors"
					>
						<X size={13} />
					</button>
				)}
			</div>

			{rows.length > 0 ? (
				<div className="border border-border bg-base rounded-lg overflow-hidden divide-y divide-border-subtle">
					{rows.map((item) => {
						const qty = Number(item.qty_on_hand);
						const removable = qty === 0;
						const confirming = confirmingId === item.id;
						return (
							<div
								key={item.id}
								className="flex items-center justify-between gap-2 px-3 py-2.5"
							>
								<div className="min-w-0">
									{/* Truncation stays (scan-and-tap list, not a reading
									    surface); full name goes in the title instead. */}
									<p
										className="text-sm text-text-primary truncate"
										title={item.inventory_item.name}
									>
										{item.inventory_item.name}
									</p>
									{item.inventory_item.category && (
										<p
											className="text-[10px] text-text-muted truncate"
											title={item.inventory_item.category}
										>
											{item.inventory_item.category}
										</p>
									)}
								</div>

								<div className="flex items-center gap-2 shrink-0">
									<span className="text-xs text-text-muted tabular-nums">
										qty {qty}
									</span>

									{removable ? (
										confirming ? (
											<div className="flex items-center gap-1">
												<button
													onClick={() => handleRemove(item)}
													disabled={deleteMutation.isPending}
													className="text-[11px] font-semibold px-2 py-1 rounded-md border border-error-border bg-error-bg text-error-text transition-colors hover:bg-error-bg/70 disabled:opacity-50"
												>
													Remove
												</button>
												<button
													onClick={() => setConfirmingId(null)}
													disabled={deleteMutation.isPending}
													className="text-[11px] px-2 py-1 rounded-md text-text-muted hover:text-text-secondary transition-colors disabled:opacity-50"
												>
													Cancel
												</button>
											</div>
										) : (
											<button
												onClick={() => setConfirmingId(item.id)}
												aria-label={`Remove ${item.inventory_item.name}`}
												className="flex items-center justify-center w-8 h-8 rounded-lg border border-border bg-surface text-text-muted transition-colors hover:border-error-border hover:text-error-text"
											>
												<Trash2 size={13} />
											</button>
										)
									) : (
										<div className="flex flex-col items-end">
											<button
												disabled
												aria-label={`Remove ${item.inventory_item.name}`}
												className="flex items-center justify-center w-8 h-8 rounded-lg border border-border bg-surface text-text-faint opacity-40 cursor-not-allowed"
											>
												<Trash2 size={13} />
											</button>
											<button
												onClick={() => onAdjust(item)}
												className="mt-0.5 flex items-center gap-0.5 text-[10px] text-text-muted hover:text-primary-text transition-colors"
											>
												Adjust to 0
												<ArrowRight size={10} />
											</button>
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				<p className="text-xs text-text-muted text-center py-2">
					No matching items
				</p>
			)}
		</div>
	);
}
