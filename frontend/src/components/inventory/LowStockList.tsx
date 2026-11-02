import { useMemo } from "react";
import { AlertTriangle, CheckCircle, MapPin } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { InventoryItem } from "../../types/inventory";
import { calculateStockStatus, getStockStatusTextColor, formatter } from "../../util/util";
import DockedPanel from "../ui/DockedPanel";

type PanelStatus = 'healthy' | 'warning' | 'critical';

const STATUS_CONFIG: Record<PanelStatus, {
	Icon: LucideIcon;
	iconClass: string;
	subtitle: string;
	badgeCount: (lowStock: number, outOfStock: number) => number;
}> = {
	healthy: {
		Icon: CheckCircle,
		iconClass: 'text-success',
		subtitle: 'All items stocked',
		badgeCount: () => 0,
	},
	warning: {
		Icon: AlertTriangle,
		iconClass: 'text-warning-text',
		subtitle: 'Items below threshold',
		badgeCount: (low) => low,
	},
	critical: {
		Icon: AlertTriangle,
		iconClass: 'text-error-text',
		subtitle: 'Items out of stock',
		badgeCount: (_low, out) => out,
	},
};

interface LowStockListProps {
	items: InventoryItem[];
	onItemClick?: (itemId: string) => void;
}


export default function LowStockList({ items, onItemClick }: LowStockListProps) {

	const alertItems = useMemo(() => {
		return items
			.map(item => ({
				item,
				status: item.stock_status ?? calculateStockStatus(item.quantity, item.low_stock_threshold),
			}))
			.filter(({ status }) => status === 'low' || status === 'out_of_stock')
			.sort((a, b) => a.item.quantity - b.item.quantity);
	}, [items]);

	const lowStockCount = alertItems.length;
	const outOfStockCount = alertItems.filter(({ status }) => status === 'out_of_stock').length;
	const lowButNotOutCount = lowStockCount - outOfStockCount;

	const panelStatus: PanelStatus =
		outOfStockCount > 0 ? 'critical' :
		lowStockCount   > 0 ? 'warning'  : 'healthy';

	const { Icon, iconClass, subtitle, badgeCount } = STATUS_CONFIG[panelStatus];

	return (
		<DockedPanel
			label="Stock status"
			rail={
				<>
					{panelStatus === 'critical' && lowButNotOutCount > 0 ? (
						<>
							<div className="flex flex-col items-center gap-1">
								<AlertTriangle size={16} className="text-error-text" />
								<span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-error/20 text-error-text">
									{outOfStockCount}
								</span>
							</div>
							<div className="flex flex-col items-center gap-1">
								<AlertTriangle size={16} className="text-warning-text" />
								<span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-warning-bg text-warning-text">
									{lowButNotOutCount}
								</span>
							</div>
						</>
					) : (
						<>
							<Icon size={18} className={iconClass} />
							{lowStockCount > 0 && (
								<span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
									panelStatus === 'critical'
										? 'bg-error/20 text-error-text'
										: 'bg-warning-bg text-warning-text'
								}`}>
									{badgeCount(lowStockCount, outOfStockCount)}
								</span>
							)}
						</>
					)}
				</>
			}
		>
			{/* Header */}
			<div className="px-5 pt-5 pb-4 border-b border-border-subtle">
				<div className="flex items-center justify-between mb-1">
					<h3 className="text-base font-semibold text-text-primary flex items-center gap-2">
						<Icon size={18} className={iconClass} />
						Stock Status
					</h3>
					{/* Badges */}
					<div className="flex items-center gap-1.5">
						{outOfStockCount > 0 && (
							<span className="bg-error/20 text-error-text text-xs font-semibold px-2 py-0.5 rounded-full">
								{outOfStockCount} out
							</span>
						)}
						{lowButNotOutCount > 0 && (
							<span className="bg-warning-bg text-warning-text text-xs font-semibold px-2 py-0.5 rounded-full">
								{lowButNotOutCount} low
							</span>
						)}
					</div>
				</div>
				<p className="text-xs text-text-muted">
					{subtitle}
				</p>
			</div>

			{/* Items List */}
			<div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
				{lowStockCount === 0 ? (
					<div className="flex flex-col items-center justify-center h-full text-center px-4">
						<div className="w-12 h-12 rounded-full bg-success/10 flex items-center justify-center mb-3">
							<CheckCircle size={24} className="text-success" />
						</div>
						<p className="text-text-secondary text-sm font-medium mb-1">
							All stocked up
						</p>
						<p className="text-text-muted text-xs">
							No items below threshold
						</p>
					</div>
				) : (
					<div className="space-y-2.5">
						{alertItems.map(({ item, status }) => (
							<div
								key={item.id}
								onClick={() => onItemClick?.(item.id)}
								className={`bg-surface/60 hover:bg-surface rounded-lg transition-colors ${onItemClick ? "cursor-pointer" : ""}`}
							>
								<div className="p-3">
									<div className="flex items-center gap-3">
										{/* Quantity */}
										<div
											className={`text-center min-w-[3rem] max-w-[4.5rem] shrink-0 ${getStockStatusTextColor(status)}`}
											title={`${item.quantity} left`}
										>
												{/* Compact notation — long figures don't fit this 320px row. */}
												<span className="text-2xl font-bold leading-none">
													{formatter.format(item.quantity)}
												</span>
												<span className="block text-[10px] uppercase tracking-wide opacity-70 mt-0.5">
													left
												</span>
											</div>

											{/* Item details */}
											<div className="flex-1 min-w-0">
												<h4
													className="text-sm font-medium text-text-primary leading-snug line-clamp-2 break-words mb-1.5"
													title={item.name}
												>
													{item.name}
												</h4>
												{item.location && (
													<div className="flex items-center gap-1 text-text-muted">
														<MapPin size={10} />
														<span className="text-xs truncate">
															{item.location}
														</span>
													</div>
												)}
											</div>

											{/* Threshold */}
											{item.low_stock_threshold !== null && (
												<div
													className="text-center min-w-[3rem] max-w-[4.5rem] shrink-0 text-success"
													title={`Threshold: ${item.low_stock_threshold}`}
												>
													<span className="text-2xl font-bold leading-none">
														{formatter.format(item.low_stock_threshold)}
													</span>
													<span className="block text-[10px] uppercase tracking-wide opacity-70 mt-0.5">
														min
													</span>
												</div>
											)}
										</div>
									</div>
								</div>
						))}
					</div>
				)}
			</div>
		</DockedPanel>
	);
}
