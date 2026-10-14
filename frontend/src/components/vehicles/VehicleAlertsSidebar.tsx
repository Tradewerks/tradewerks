import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, AlertTriangle, CheckCircle, Wrench } from "lucide-react";
import { useVehicleStockConflictsQuery, useMaintenanceAlertsQuery } from "../../hooks/useVehicleStock";
import { MAINTENANCE_CATEGORY_LABELS } from "../../types/vehicles";
import type { VehicleStockConflict, VehicleMaintenanceAlert } from "../../types/vehicles";
import { formatDateOnly, daysUntil } from "../../util/util";

function alertDueLines(alert: VehicleMaintenanceAlert): string[] {
	const parts: string[] = [];
	if (alert.dueAt) {
		parts.push(daysUntil(alert.dueAt) < 0 ? `was due ${formatDateOnly(alert.dueAt)}` : `due ${formatDateOnly(alert.dueAt)}`);
	}
	if (alert.dueOdometerMi != null) {
		if (alert.currentOdometerMi != null) {
			const milesLeft = alert.dueOdometerMi - alert.currentOdometerMi;
			parts.push(`${alert.dueOdometerMi.toLocaleString()} mi (${milesLeft < 0 ? "past" : `${milesLeft.toLocaleString()} left`})`);
		} else {
			parts.push(`${alert.dueOdometerMi.toLocaleString()} mi`);
		}
	}
	return parts.length > 0 ? parts : ["—"];
}

type Tab = "stock" | "maintenance";

function AlertStatusIcon({ hasError, totalCount }: { hasError: boolean; totalCount: number }) {
	if (totalCount === 0) return <CheckCircle size={16} className="text-success" />;
	return <AlertTriangle size={16} className={hasError ? "text-error-text" : "text-warning-text"} />;
}

export default function VehicleAlertsSidebar() {
	const [isCollapsed, setIsCollapsed] = useState(true);
	const [tab, setTab] = useState<Tab>("stock");
	const navigate = useNavigate();
	const { data: conflicts = [] } = useVehicleStockConflictsQuery();
	const { data: alerts = [] } = useMaintenanceAlertsQuery();

	const { outCount } = conflicts.reduce(
		(acc, c) => ({
			outCount: acc.outCount + (c.severity === "out" ? 1 : 0),
			lowCount: acc.lowCount + (c.severity === "low" ? 1 : 0),
		}),
		{ outCount: 0, lowCount: 0 }
	);
	const stockTotal = conflicts.length;

	const openAlerts = alerts.filter((a) => !a.acknowledged);
	const overdueCount = openAlerts.filter((a) => a.status === "overdue").length;
	const maintenanceTotal = openAlerts.length;

	const combinedTotal = stockTotal + maintenanceTotal;
	const hasError = outCount > 0 || overdueCount > 0;

	const tabBtn = (active: boolean) =>
		`flex-1 py-1 text-xs font-semibold rounded-md transition-colors hover:cursor-pointer ${
			active ? "bg-base text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"
		}`;

	return (
		<div
			className={`
				fixed top-16 right-0 h-[calc(100vh-4rem)] bg-base/95 backdrop-blur-sm
				border-l border-border/50 shadow-2xl shadow-black/50
				transition-all duration-300 ease-in-out z-40
				${isCollapsed ? "w-12" : "w-80"}
			`}
		>
			{/* Toggle button */}
			<button
				onClick={() => setIsCollapsed(!isCollapsed)}
				className="absolute -left-3 top-1/2 -translate-y-1/2 bg-surface hover:cursor-pointer hover:bg-surface-raised text-text-secondary hover:text-text-primary p-1.5 rounded-full border border-border-strong shadow-lg transition-all z-50"
			>
				{isCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
			</button>

			{/* Expanded */}
			{!isCollapsed && (
				<div className="h-full flex flex-col overflow-hidden">
					<div className="px-4 pt-4 pb-3 border-b border-border-subtle">
						<div className="flex items-center gap-2 mb-3">
							<AlertStatusIcon hasError={hasError} totalCount={combinedTotal} />
							<h3 className="text-sm font-semibold text-text-primary">Vehicle Alerts</h3>
						</div>

						<div className="flex items-center gap-1 bg-surface-inset rounded-lg p-0.5">
							<button className={tabBtn(tab === "stock")} onClick={() => setTab("stock")}>
								Stock {stockTotal > 0 && `(${stockTotal})`}
							</button>
							<button className={tabBtn(tab === "maintenance")} onClick={() => setTab("maintenance")}>
								Maintenance {maintenanceTotal > 0 && `(${maintenanceTotal})`}
							</button>
						</div>
					</div>

					<div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 scrollbar-thin">
						{tab === "stock" ? (
							stockTotal === 0 ? (
								<EmptyState label="All stocked up" hint="No upcoming visit conflicts" />
							) : (
								conflicts.map((conflict) => (
									<ConflictCard
										key={`${conflict.visitId}-${conflict.vehicleId}`}
										conflict={conflict}
										onVisitClick={() => navigate(`/dispatch/jobs/${conflict.jobId}/visits/${conflict.visitId}`)}
										onVehicleClick={() => navigate(`/dispatch/vehicles/${conflict.vehicleId}/stock`)}
									/>
								))
							)
						) : alerts.length === 0 ? (
							<EmptyState label="Nothing due" hint="No overdue or upcoming reminders" />
						) : (
							alerts.map((alert) => (
								<AlertCard
									key={alert.reminderId}
									alert={alert}
									onClick={() => navigate(`/dispatch/vehicles/${alert.vehicleId}/stock?tab=maintenance`)}
								/>
							))
						)}
					</div>
				</div>
			)}

			{/* Collapsed */}
			{isCollapsed && (
				<div className="flex flex-col items-center pt-4 gap-2">
					<AlertStatusIcon hasError={hasError} totalCount={combinedTotal} />
					{combinedTotal > 0 && (
						<span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${hasError ? "bg-error/20 text-error-text" : "bg-warning-bg text-warning-text"}`}>
							{combinedTotal}
						</span>
					)}
				</div>
			)}
		</div>
	);
}

export function EmptyState({ label, hint }: { label: string; hint: string }) {
	return (
		<div className="flex flex-col items-center justify-center h-full text-center px-4">
			<div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center mb-3">
				<CheckCircle size={20} className="text-success" />
			</div>
			<p className="text-text-secondary text-xs font-medium">{label}</p>
			<p className="text-text-muted text-xs mt-1">{hint}</p>
		</div>
	);
}

function ConflictCard({
	conflict,
	onVisitClick,
	onVehicleClick,
}: {
	conflict: VehicleStockConflict;
	onVisitClick: () => void;
	onVehicleClick: () => void;
}) {
	const time = conflict.scheduledAt
		? new Date(conflict.scheduledAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
		: "";
	const isOut = conflict.severity === "out";
	const techLabel = conflict.techNames.length <= 2
		? conflict.techNames.join(", ")
		: `${conflict.techNames[0]} +${conflict.techNames.length - 1}`;

	return (
		<div className="bg-surface rounded-lg overflow-hidden border border-border">
			{/* Status bar */}
			<div className={`px-3 py-1.5 flex items-center justify-between ${isOut ? "bg-error/15" : "bg-warning/10"}`}>
				<span className={`text-[10px] font-bold tracking-wide ${isOut ? "text-error-text" : "text-warning-text"}`}>
					{isOut ? "OUT OF STOCK" : "LOW STOCK"}
				</span>
				<span className={`text-[10px] opacity-70 ${isOut ? "text-error-text" : "text-warning-text"}`}>{time}</span>
			</div>

			{/* Two-column identity — each half is independently clickable */}
			<div className="flex gap-1 px-1.5 py-1.5">
				<button
					onClick={onVisitClick}
					className="flex-[3] min-w-0 px-1.5 py-1.5 text-left rounded border border-border hover:cursor-pointer hover:border-border-strong hover:bg-surface-raised active:bg-surface-active transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
				>
					<div className="text-[9px] font-semibold text-text-muted uppercase tracking-wider mb-1">Visit</div>
					<div className="text-xs font-semibold text-text-primary leading-snug line-clamp-2">{conflict.visitName}</div>
					<div className="text-[11px] text-text-secondary mt-0.5 truncate">{conflict.clientName}</div>
				</button>
				<button
					onClick={onVehicleClick}
					className="flex-[2] min-w-0 px-1.5 py-1.5 text-left rounded border border-border hover:cursor-pointer hover:border-border-strong hover:bg-surface-raised active:bg-surface-active transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
				>
					<div className="text-[9px] font-semibold text-text-muted uppercase tracking-wider mb-1">Vehicle</div>
					<div className="text-xs font-semibold text-text-primary leading-snug truncate">{conflict.vehicleName}</div>
					<div className="text-[11px] text-text-secondary mt-0.5 truncate">
						{techLabel || <span className="italic text-text-faint">Unassigned</span>}
					</div>
				</button>
			</div>

			{/* Item rows */}
			<div className="px-3 pb-2 space-y-1">
				{conflict.conflicts.map((item) => (
					<div key={item.inventoryItemId} className="flex items-center justify-between bg-canvas rounded px-2 py-1">
						<span className="text-xs text-text-primary truncate mr-2">{item.itemName}</span>
						<div className="flex items-center gap-2 flex-shrink-0">
							<span className="text-[11px] text-text-muted">Need <span className="text-text-primary font-semibold">{item.qtyNeeded}</span></span>
							<span className={`text-[11px] font-bold ${item.qtyOnHand === 0 ? "text-error-text" : "text-warning-text"}`}>
								Have {item.qtyOnHand}
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}

export function AlertCard({ alert, onClick }: { alert: VehicleMaintenanceAlert; onClick: () => void }) {
	const isOverdue = alert.status === "overdue";
	const dueLines = alertDueLines(alert);

	return (
		<button
			onClick={onClick}
			className={`w-full text-left bg-surface rounded-lg overflow-hidden border border-border hover:cursor-pointer ${alert.acknowledged ? "opacity-60" : ""} hover:border-border-strong active:bg-surface-active transition-colors duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50`}
		>
			<div className={`px-3 py-1.5 flex items-center gap-1.5 ${isOverdue ? "bg-error/15" : "bg-warning/10"}`}>
				<Wrench size={11} className={isOverdue ? "text-error-text" : "text-warning-text"} />
				<span className={`text-[10px] font-bold tracking-wide ${isOverdue ? "text-error-text" : "text-warning-text"}`}>
					{isOverdue ? "OVERDUE" : "DUE SOON"}
				</span>
				{alert.acknowledged && (
					<span className="ml-auto text-[10px] italic text-text-faint">Acknowledged</span>
				)}
			</div>
			<div className="px-3 py-2 flex flex-col gap-0.5">
				<div className="text-xs font-semibold text-text-primary leading-snug truncate">{alert.title}</div>
				<div className="flex items-center justify-between gap-2">
					<span className="text-[11px] text-text-secondary truncate">
						{alert.vehicleName} · {MAINTENANCE_CATEGORY_LABELS[alert.category]}
					</span>
					<span className="text-[11px] text-text-secondary text-right shrink-0">{dueLines[0]}</span>
				</div>
				{dueLines[1] && (
					<span className="text-[11px] text-text-secondary text-right">{dueLines[1]}</span>
				)}
			</div>
		</button>
	);
}
