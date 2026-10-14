import { useNavigate } from "react-router-dom";
import type { Vehicle, StockHealthStatus, VehicleReadiness, ReadinessState } from "../../types/vehicles";
import { usePermission } from "../../hooks/usePermission";
import { getStockCounts, getStockHealth } from "./stockHealth";

const HEALTH_CONFIG: Record<StockHealthStatus, {
	borderColor: string;
	rowBg: string;
}> = {
	ok:  { borderColor: "border-l-success", rowBg: "" },
	low: { borderColor: "border-l-warning", rowBg: "bg-warning/5" },
	out: { borderColor: "border-l-error",   rowBg: "bg-error/5" },
};

function TruckIcon({ health }: { health: StockHealthStatus }) {
	const stroke =
		health === "out" ? "var(--color-error)" :
		health === "low" ? "var(--color-warning)" :
		"var(--color-success)";
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
			<rect x="1" y="3" width="15" height="13" rx="2" />
			<path d="M16 8h4l3 5v3h-7V8z" />
			<circle cx="5.5" cy="18.5" r="2.5" />
			<circle cx="18.5" cy="18.5" r="2.5" />
		</svg>
	);
}

/** Proportional composition bar: out (red) / low (amber) / ok (green) item counts. */
function StockCompositionBar({ out, low, ok }: { out: number; low: number; ok: number }) {
	return (
		<div className="flex h-1.5 w-20 rounded-full overflow-hidden bg-surface-inset flex-shrink-0">
			{out > 0 && <div className="bg-error h-full" style={{ flexGrow: out, flexBasis: 0 }} />}
			{low > 0 && <div className="bg-warning h-full" style={{ flexGrow: low, flexBasis: 0 }} />}
			{ok > 0 && <div className="bg-success/70 h-full" style={{ flexGrow: ok, flexBasis: 0 }} />}
		</div>
	);
}

export default function VehicleCard({ vehicle, onEdit, readiness, onReadinessClick }: { vehicle: Vehicle; onEdit: (v: Vehicle) => void; readiness?: VehicleReadiness; onReadinessClick?: () => void }) {
	const navigate = useNavigate();
	const canEdit = usePermission("manage_inventory");
	const counts = getStockCounts(vehicle);
	const health = getStockHealth(vehicle);

	const READINESS_CONFIG: Partial<Record<ReadinessState, { label: string; className: string }>> = {
		unknown:      { label: "Unknown",  className: "text-text-muted border-border bg-surface-raised" },
		auto_ready:   { label: "Ready",    className: "text-success border-success/40 bg-success/10" },
		needs_action: { label: "",         className: "text-warning border-warning/40 bg-warning/10" },
		confirmed:    { label: "Ready ✓",  className: "text-success border-success/40 bg-success/10" },
	};
	const cfg = HEALTH_CONFIG[health];
	const techNames = vehicle.current_technicians ?? [];
	const techLabel = techNames.length === 0
		? undefined
		: techNames.length === 1
			? techNames[0].name
			: `${techNames[0].name} +${techNames.length - 1}`;

	const stockLabel =
		counts.total === 0 ? null :
		counts.out > 0 && counts.low > 0 ? `${counts.out} out · ${counts.low} low` :
		counts.out > 0 ? `${counts.out} out` :
		counts.low > 0 ? `${counts.low} low` :
		"All good";

	return (
		<div
			className={`grid grid-cols-[1fr_150px_176px_110px_168px] items-center gap-3 px-5 py-3 border-b border-border/40 border-l-[3px] cursor-pointer ${cfg.borderColor} ${cfg.rowBg} hover:bg-surface-raised/70 transition-colors`}
			onClick={() => navigate(`/dispatch/vehicles/${vehicle.id}/stock`)}
		>
			{/* Identity */}
			<div className="flex items-center gap-3 min-w-0">
				<div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${health === "ok" ? "bg-success/10" : health === "low" ? "bg-warning/10" : "bg-error/10"}`}>
					<TruckIcon health={health} />
				</div>
				<div className="min-w-0">
					<div className="text-sm font-semibold text-text-primary flex items-center gap-2">
						<span className="truncate">{vehicle.name}</span>
						{vehicle.status === "inactive" && (
							<span className="text-[10px] font-semibold bg-surface text-text-muted border border-border px-1.5 py-0.5 rounded flex-shrink-0">INACTIVE</span>
						)}
					</div>
					<div className="text-xs text-text-muted mt-0.5 truncate">
						{[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ")}
						{vehicle.license_plate && ` · ${vehicle.license_plate}`}
						{vehicle.current_odometer_mi != null && ` · ${vehicle.current_odometer_mi.toLocaleString()} mi`}
					</div>
				</div>
			</div>

			{/* Technician */}
			<div className="min-w-0">
				{techLabel
					? <span className="text-sm text-text-secondary truncate block">{techLabel}</span>
					: <span className="text-sm text-text-faint italic">No tech</span>
				}
			</div>

			{/* Stock composition */}
			<div className="flex items-center gap-2.5">
				{counts.total === 0 ? (
					<span className="text-xs text-text-faint">No items tracked</span>
				) : (
					<>
						<StockCompositionBar out={counts.out} low={counts.low} ok={counts.ok} />
						<span className={`text-xs font-semibold whitespace-nowrap ${
							health === "out" ? "text-error-text" : health === "low" ? "text-warning-text" : "text-success"
						}`}>
							{stockLabel}
						</span>
					</>
				)}
			</div>

			{/* Readiness */}
			<div className="text-xs text-text-muted">
				{readiness && readiness.state !== "not_applicable" && (() => {
					const config = READINESS_CONFIG[readiness.state];
					if (!config) return null;
					const gapCount = readiness.gaps.filter((g) => g.gap > 0).length;
					const label =
						readiness.state === "needs_action"
							? `${gapCount} gap${gapCount !== 1 ? "s" : ""}`
							: config.label;
					return (
						<button
							onClick={(e) => { e.stopPropagation(); onReadinessClick?.(); }}
							className={`text-xs font-semibold px-2 py-0.5 rounded border transition-opacity hover:opacity-80 ${config.className}`}
						>
							{label}
						</button>
					);
				})()}
				{(!readiness || readiness.state === "not_applicable") && "—"}
			</div>

			{/* Actions */}
			<div className="flex items-center justify-end gap-2">
				<button
					onClick={(e) => { e.stopPropagation(); if (canEdit) onEdit(vehicle); }}
					disabled={!canEdit}
					title={!canEdit ? "You don't have permission to perform this action" : ""}
					className="px-3 py-1 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
				>
					Edit
				</button>
				<button
					onClick={(e) => { e.stopPropagation(); navigate(`/dispatch/vehicles/${vehicle.id}/stock`); }}
					className="px-3 py-1 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-raised transition-colors"
				>
					Manage Stock
				</button>
			</div>
		</div>
	);
}
