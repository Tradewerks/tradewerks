import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronRight, Package } from "lucide-react";
import { useLowStockInventoryQuery, useProvisionalItemsQuery } from "../../hooks/useInventory";
import { usePermission } from "../../hooks/usePermission";
import { useModule } from "../../hooks/useEntitlements";

export default function LowStockWidget({ className }: { className?: string }) {
	const navigate = useNavigate();
	const { data: lowStockItems = [] } = useLowStockInventoryQuery();
	const canManageInventory = usePermission("manage_inventory");
	const { data: pendingParts = [] } = useProvisionalItemsQuery(canManageInventory);
	const inventoryOn = useModule("inventory") === "on";

	const outOfStock = lowStockItems.filter((i) => i.quantity === 0).length;
	const lowStock = lowStockItems.length - outOfStock;
	const pendingCount = pendingParts.length;

	if (!inventoryOn || (lowStockItems.length === 0 && pendingCount === 0)) return null;

	return (
		<div
			onClick={() => navigate("/dispatch/inventory")}
			className={`group p-4 bg-base border border-border-subtle rounded-xl cursor-pointer hover:border-warning/30 transition-colors${className ? ` ${className}` : ""}`}
		>
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<div className="relative w-8 h-8 rounded-lg bg-warning/10 flex items-center justify-center border border-warning/20">
						<Package size={16} className="text-warning-text" />
						{pendingCount > 0 && (
							<span className="absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full bg-primary text-on-primary text-[9px] font-bold leading-none border border-base">
								{pendingCount > 9 ? "9+" : pendingCount}
							</span>
						)}
					</div>
					<h4 className="text-sm font-semibold text-text-primary">Inventory Alerts</h4>
				</div>
				<ChevronRight
					size={16}
					className="text-text-faint group-hover:text-text-tertiary"
				/>
			</div>

			<div className="flex items-center gap-3">
				{outOfStock > 0 && (
					<div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-error/10 border border-error/20">
						<AlertTriangle size={12} className="text-error-text" />
						<span className="text-xs font-medium text-error-text">
							{outOfStock} out of stock
						</span>
					</div>
				)}
				{lowStock > 0 && (
					<div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-warning-bg border border-warning-border">
						<AlertTriangle size={12} className="text-warning-text" />
						<span className="text-xs font-medium text-warning-text">
							{lowStock} low stock
						</span>
					</div>
				)}
				{pendingCount > 0 && (
					<div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-primary/10 border border-primary/20">
						<Package size={12} className="text-primary" />
						<span className="text-xs font-medium text-primary">
							{pendingCount} pending part{pendingCount !== 1 ? "s" : ""}
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
