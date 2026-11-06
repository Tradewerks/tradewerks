import { AlertCircle } from "lucide-react";
import { useFleetReadinessQuery, useVehiclesQuery } from "../../hooks/useVehicles";
import Card from "../ui/Card";
import { ROW_GRID, RowsSkeleton } from "../disputes/OpenDisputeRow";
import { TruckIcon } from "../vehicles/VehicleCard";
import { getStockHealth, READINESS_CONFIG } from "../vehicles/stockHealth";
import { useState } from "react";
import { Link } from "react-router-dom";
import { localDateKey } from "../ui/schedule/scheduleBoardUtils";

const STATE_ORDER = ["needs_action", "unknown", "auto_ready", "confirmed", "not_applicable"];

export default function VehicleReadinessWidget (){
    const [selectedDate, setSelectedDate] = useState<string>(() => localDateKey(new Date()));
    const { data, isLoading, error } = useFleetReadinessQuery(selectedDate);
    const readiness = data ?? [];

    const { data: vehicles = [] } = useVehiclesQuery();
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const vansOut = readiness.filter((r) => r.state !== "not_applicable").length;
    const ready = readiness.filter((r) => r.state === "auto_ready" || r.state === "confirmed").length;
    const partsShort = readiness.reduce((n, r) => n + r.gaps.filter((g) => g.gap > 0).length, 0);
    const counts = [
        { label: "vans out", value: vansOut, className: "bg-surface-raised text-text-primary" },
        { label: "ready", value: ready, className: "bg-surface-raised text-text-primary" },
        { label: "short", value: partsShort, className: partsShort > 0 ? "bg-warning/10 text-warning" : "bg-success/10 text-success" },
    ];

    if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load Vehicle Readiness</p>
		</div>
	);

    return (
        <Card
            title="Vehicle Readiness"
            className="h-full"
            headerAction={(
                <div className="flex rounded border border-border overflow-hidden text-xs font-semibold">
                        {(["today", "tomorrow"] as const).map((label) => {
                            const d = new Date();
                            if (label === "tomorrow") d.setDate(d.getDate() + 1);
                            const dateStr = localDateKey(d);
                            const isActive = selectedDate === dateStr;
                            return (
                                <button
                                    key={label}
                                    onClick={() => setSelectedDate(dateStr)}
                                    className={`px-3 py-1 capitalize transition-colors ${
                                        isActive
                                            ? "bg-primary text-on-primary"
                                            : "text-text-muted hover:text-text-secondary"
                                    } ${label === "tomorrow" ? "border-l border-border" : ""}`}
                                >
                                    {label}
                                </button>
                            );
                        })}
                </div>
            )}
        >
            {isLoading ? (
                <RowsSkeleton rows={vehicles.length ?? 5} />
            ): readiness.length > 0 ? (
                <>
                <div className="-mt-1 mb-3 grid grid-cols-3 gap-2">
                    {counts.map((c) => (
                        <div key={c.label} className={`flex flex-col rounded-lg px-2.5 py-1.5 ${c.className}`}>
                            <span className="text-lg font-bold leading-tight">{c.value}</span>
                            <span className="truncate text-xs opacity-80">{c.label}</span>
                        </div>
                    ))}
                </div>
                <ul className="-mx-4 -mb-4 flex-1 min-h-0 overflow-y-auto divide-y divide-border-subtle border-t border-border-subtle">
                    {[...readiness].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)).map((r) => {
                        const v = byId.get(r.vehicle_id);
                        if (!v) return null;
                        const cfg = READINESS_CONFIG[r.state];
                        const shortParts = r.gaps.filter((g) => g.gap > 0);
                        const gaps = shortParts.length;
                        return (
                            <li key={r.vehicle_id}>
                                <Link to={`/dispatch/vehicles/${v.id}/stock`} className={`${ROW_GRID} hover:bg-surface/40`}>
                                    <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-text-primary">
                                        <TruckIcon health={getStockHealth(v)} />
                                        <span className="truncate">{v.name}</span>
                                    </span>
                                    <span className={`text-xs font-semibold px-2 py-0.5 rounded border ${cfg?.className ?? ""}`}>
                                        {r.state === "needs_action" ? `${gaps} gap${gaps !== 1 ? "s" : ""}` : cfg?.label}
                                    </span>
                                    <span className="truncate text-xs text-text-muted">
                                        {v.current_technicians?.[0]?.name ?? "No tech"}
                                    </span>
                                    {gaps > 0 && (
                                        <span className="col-span-2 mt-1 flex flex-wrap gap-1.5">
                                            {shortParts.map((g) => (
                                                <span key={g.inventory_item_id} className="flex max-w-full rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                                                    <span className="truncate">{g.name}</span>
                                                    <span className="shrink-0 whitespace-pre"> · need {g.qty_needed}, have {g.qty_on_hand}</span>
                                                </span>
                                            ))}
                                        </span>
                                    )}
                                </Link>
                            </li>
                        );
                    })}
                </ul>
                </>
            ) : (
                <p>No Vehicles found</p>
            )}
        </Card>
    )
}