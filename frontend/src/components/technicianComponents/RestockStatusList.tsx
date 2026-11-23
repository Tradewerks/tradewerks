import { useTranslation } from "react-i18next";
import { useVehicleRestockRequestsQuery } from "../../hooks/useVehicleStock";
import type { RestockRequest } from "../../types/vehicles";

export default function RestockStatusList({ vehicleId }: { vehicleId: string }) {
	const { t } = useTranslation();
	const { data: requests = [], isLoading } = useVehicleRestockRequestsQuery(vehicleId);

	if (isLoading) return null;
	if (requests.length === 0) return null;

	const pending = requests.filter((r) => r.status === "pending" || r.status === "acknowledged");
	const resolved = requests.filter((r) => r.status === "dismissed" || r.status === "resolved");

	const name = (r: RestockRequest) => r.stock_item.inventory_item.name;

	return (
		<div className="rounded-xl border border-border-subtle bg-base overflow-hidden">
			<div className="px-4 py-3 border-b border-border-subtle text-xs font-medium text-text-tertiary uppercase tracking-wide">
				{t("restockStatus.title")}
			</div>

			{pending.length > 0 && (
				<div className="border-b border-border-subtle">
					<div className="px-4 py-1.5 text-[10px] uppercase tracking-widest text-text-muted">{t("restockStatus.pending")}</div>
					{pending.map((r) => (
						<div
							key={r.id}
							className="flex items-center justify-between px-4 py-2 border-b border-border-subtle last:border-0"
						>
							{/* min-w-0 + clamp on the name, shrink-0 on the figure — otherwise
							    a long name squeezes the count to one char per line. */}
							<span
								className="text-sm text-text-primary min-w-0 line-clamp-2 break-words"
								title={name(r)}
							>
								{name(r)}
							</span>
							<span className="text-xs text-text-muted shrink-0 ml-2">
								{t("restockStatus.requested", {
									qty: r.qty_requested != null ? Number(r.qty_requested) : "—",
								})}
							</span>
						</div>
					))}
				</div>
			)}

			{resolved.length > 0 && (
				<div>
					<div className="px-4 py-1.5 text-[10px] uppercase tracking-widest text-text-faint">{t("restockStatus.recent")}</div>
					{resolved.map((r) => (
						<div
							key={r.id}
							className="flex items-center justify-between px-4 py-2 border-b border-border-subtle last:border-0"
						>
							<span
								className="text-sm text-text-muted min-w-0 line-clamp-2 break-words"
								title={name(r)}
							>
								{name(r)}
							</span>
							<span className="text-[11px] text-text-faint shrink-0 ml-2">
								{t(r.status === "dismissed" ? "restockStatus.dismissed" : "restockStatus.resolved")}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
