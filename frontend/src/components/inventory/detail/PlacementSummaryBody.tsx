import { Truck, Warehouse } from "lucide-react";
import { unitLabel } from "../../../lib/units";
import PlacementTile from "./PlacementTile";
import ProportionBar from "./ProportionBar";
import VehicleAllotmentDropdown from "./VehicleAllotmentDropdown";

// The untracked-item placement view — headline total, Warehouse/On-Vehicles
// tiles, proportion bar, and the footnotes for "no split computed yet" and
// "archived units/lots survive as history". Pulled out of StockPlacementCard
// so the Tracking tab can show the exact same thing full-width for an item
// that isn't serialized or batch-tracked, instead of a bare "Not tracked"
// dead end — same numbers, same drill-in, no second implementation to drift
// out of sync. Purely presentational: both callers own their own
// useItemForecastQuery/useTrackingSummaryQuery reads and hand this the
// already-computed primitives, since the two need different `archived`
// semantics (Overview's rail card can be archived; the Tracking-tab panel
// never is).
export default function PlacementSummaryBody({
	itemId,
	unit,
	warehouseQuantity,
	vehicleQuantity,
	totalQuantity,
	forecastReason,
	archived,
	archivedUnits,
	archivedLots,
}: {
	itemId: string;
	unit: string;
	warehouseQuantity: number;
	/** `null` when the forecast split hasn't been computed for this item. */
	vehicleQuantity: number | null;
	totalQuantity: number;
	/** Why the split is missing, when it is — mirrors ReorderHealthMini's reason. */
	forecastReason?: string | null;
	/** Tracking is off but units/lots survive as history. */
	archived: boolean;
	archivedUnits: number;
	archivedLots: number;
}) {
	const hasSplit = vehicleQuantity != null;

	return (
		<>
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-xl font-bold leading-none tabular-nums text-text-primary">
					{totalQuantity}
					<span className="ml-1 text-sm font-medium text-text-muted">
						{unitLabel(unit, totalQuantity)}
					</span>
				</span>
				<span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
					{hasSplit ? "On hand org-wide" : "In warehouse"}
				</span>
			</div>

			{/* flex-wrap: two 140px-min tiles can exceed a narrow rail's width,
			    and the parent Card's `overflow-hidden` clips overflow flush
			    against the edge — reading as lost padding rather than a wrap. */}
			<div className="mt-3 flex flex-wrap gap-3">
				<PlacementTile
					icon={Warehouse}
					label="Warehouse"
					value={warehouseQuantity}
					suffix={unitLabel(unit, warehouseQuantity)}
				/>
				{hasSplit && (
					<VehicleAllotmentDropdown
						itemId={itemId}
						icon={Truck}
						label="On vehicles"
						value={vehicleQuantity}
						unit={unit}
					/>
				)}
			</div>
			{hasSplit && <ProportionBar warehouse={warehouseQuantity} vehicle={vehicleQuantity} />}

			{!hasSplit && (
				<p className="mt-2 text-[11px] text-text-faint">
					{forecastReason === "inactive"
						? "Inactive items aren't forecast, so the vehicle split isn't computed."
						: "No vehicle split available for this item yet."}
				</p>
			)}

			{archived && archivedUnits + archivedLots > 0 && (
				<p className="mt-2 text-[11px] text-text-faint">
					Tracking is off.{" "}
					{archivedUnits > 0 &&
						`${archivedUnits} unit${archivedUnits === 1 ? "" : "s"}`}
					{archivedUnits > 0 && archivedLots > 0 && " and "}
					{archivedLots > 0 && `${archivedLots} lot${archivedLots === 1 ? "" : "s"}`}{" "}
					stay on record as history.
				</p>
			)}
		</>
	);
}
