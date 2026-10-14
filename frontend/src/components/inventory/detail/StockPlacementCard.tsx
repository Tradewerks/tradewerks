import type { ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { useItemForecastQuery } from "../../../hooks/useInventory";
import { useTrackingSummaryQuery } from "../../../hooks/useTracking";
import type { InventoryItem } from "../../../types/inventory";
import { unitLabel } from "../../../lib/units";
import Card from "../../ui/Card";
import PlacementSummaryBody from "./PlacementSummaryBody";
import PlacementTile from "./PlacementTile";
import ProportionBar from "./ProportionBar";
import VehicleAllotmentDropdown from "./VehicleAllotmentDropdown";
import { QueryErrorState } from "./chartShared";
import {
	BATCH_GROUP_HEADING,
	BATCH_SUMMARY_ROWS,
	SERIAL_GROUP_HEADING,
	SERIAL_SUMMARY_ROWS,
} from "./trackingSummaryMeta";

// The ONE place Overview answers "where is this stock" — warehouse vs vehicles.
// It replaces the old TrackingSummaryCard, which sat directly above an earlier
// version of this card and restated the same axis: its rows are literally
// "In Warehouse / On Vehicles" (serials) and "Qty in Warehouse / Qty on Vehicles"
// (batches). Two cards, one question, and — worse — two different sources for
// one number: tracking-summary counts tracked ENTITIES, while the forecast's
// warehouse/vehicle split is derived from stock_movement. When those disagree,
// stacking them just publishes the disagreement.
//
// So the source is picked by how the item is tracked, and the two are never
// mixed:
//
//   tracked (serialized and/or batch) — tracking-summary rows, grouped by method,
//       LIVE placement only. Consumed/Lost/Returned are lifetime totals and live
//       on the Tracking tab (TrackingSummaryStats); "View all" goes there.
//   untracked — the forecast split, which is the only place a loose item's
//       vehicle quantity exists at all (`item.quantity` is warehouse only).
//   untracked but with archived units/lots — the forecast split (that IS the live
//       truth once tracking is off) plus a line pointing at the archive.
//
// Labels/icons for the tracked rows come from trackingSummaryMeta, shared with
// the Tracking tab, so one number can't be called two things.

// Aligned label/value rows: a definition list reads at any column width and keeps
// every number on one right-hand edge. Only the header action is focusable — the
// whole card was once a single <button>, which handed a screen reader one
// unlabelled control wrapping seven values.
function PlacementRow({
	icon: Icon,
	label,
	value,
	suffix,
	muted,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
	suffix?: string;
	muted?: boolean;
}) {
	return (
		<div className="flex items-center justify-between gap-3 py-1.5">
			<span className="flex min-w-0 items-center gap-2 text-xs text-text-secondary">
				<Icon size={13} className="shrink-0 text-text-muted" />
				<span className="truncate">{label}</span>
			</span>
			<span
				className={`shrink-0 text-sm tabular-nums ${
					muted
						? "font-medium text-text-secondary"
						: "font-semibold text-text-primary"
				}`}
			>
				{value}
				{suffix && (
					<span className="ml-1 text-[11px] font-normal text-text-faint">
						{suffix}
					</span>
				)}
			</span>
		</div>
	);
}

// Just the heading — tile rows and the plain-row list below use different
// wrappers (a flex row vs. a divide-y list), so forcing both through one
// container that always applies list styling was fighting the tile layout.
function GroupHeading({ children }: { children: ReactNode }) {
	return (
		<div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
			{children}
		</div>
	);
}

// Live stock only. The terminal rows (consumed/lost/returned) are lifetime
// totals, not placement, and the Tracking tab already tiles all of them.
const SERIAL_LIVE_ROWS = SERIAL_SUMMARY_ROWS.filter((r) => !r.terminal);

export default function StockPlacementCard({
	item,
	archived,
	onViewAll,
}: {
	item: InventoryItem;
	/** Tracking is off but units/lots survive as history. */
	archived: boolean;
	/** Jumps to the Tracking tab, where the units/lots themselves live. */
	onViewAll: () => void;
}) {
	const tracked = item.is_serialized || item.is_batch_tracked;
	// `enabled: !!itemId` on the hook — an untracked item with no archive has no
	// rollup to read, and shouldn't spend a request finding that out.
	const needsTracking = tracked || archived;
	const {
		data: summary,
		isLoading: summaryLoading,
		isError: summaryError,
		refetch: refetchSummary,
	} = useTrackingSummaryQuery(needsTracking ? item.id : "");
	// Same query key ReorderHealthMini holds directly above this card in the rail,
	// so in practice this is free.
	const {
		data: forecastResult,
		isLoading: forecastLoading,
		isError: forecastError,
		refetch: refetchForecast,
	} = useItemForecastQuery(item.id);

	const isLoading = tracked ? summaryLoading : forecastLoading;
	if (isLoading) {
		return (
			<Card title="Stock Placement">
				<div className="h-10 animate-pulse rounded bg-surface-raised" />
			</Card>
		);
	}

	// Only the source this card actually reads from can fail it: tracked items
	// read the tracking summary, untracked the forecast split. Without this the
	// tracked branch tiled zeros over a failed read.
	const isError = tracked ? summaryError : forecastError;
	if (isError) {
		return (
			<Card title="Stock Placement">
				<QueryErrorState
					what="stock placement"
					onRetry={() => (tracked ? refetchSummary() : refetchForecast())}
				/>
			</Card>
		);
	}

	const viewAll = (
		<button
			type="button"
			onClick={onViewAll}
			aria-label="View all serials and batches"
			className="group inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary-text"
		>
			View all
			<ChevronRight
				size={14}
				className="transition-transform group-hover:translate-x-0.5"
			/>
		</button>
	);

	if (tracked) {
		const serials = summary?.serials;
		const batches = summary?.batches;
		// Live rows only ever hold exactly these two keys (terminal statuses are
		// filtered out above) — both get promoted to tiles, so there's no
		// leftover list row for the serial group.
		const serialWarehouseMeta = SERIAL_LIVE_ROWS.find((r) => r.key === "in_warehouse")!;
		const serialVehicleMeta = SERIAL_LIVE_ROWS.find((r) => r.key === "on_vehicle")!;
		const batchWarehouseMeta = BATCH_SUMMARY_ROWS.find((r) => r.key === "qty_in_warehouse")!;
		const batchVehicleMeta = BATCH_SUMMARY_ROWS.find((r) => r.key === "qty_on_vehicles")!;
		const batchLotsMeta = BATCH_SUMMARY_ROWS.find((r) => r.key === "lots")!;
		const serialWarehouse = serials?.in_warehouse ?? 0;
		const serialVehicle = serials?.on_vehicle ?? 0;
		const batchWarehouse = batches?.qty_in_warehouse ?? 0;
		const batchVehicle = batches?.qty_on_vehicles ?? 0;

		return (
			<Card title="Stock Placement" headerAction={viewAll}>
				<div className="space-y-4">
					{item.is_serialized && (
						<div>
							<GroupHeading>{SERIAL_GROUP_HEADING}</GroupHeading>
							{/* Wraps rather than overflows: two 140px-min tiles plus
							    gap can exceed the rail's width at in-between
							    breakpoints, and Card's `overflow-hidden` was
							    clipping the second tile flush against the edge —
							    reading as the card losing its right-side padding. */}
							<div className="flex flex-wrap gap-3">
								<PlacementTile
									icon={serialWarehouseMeta.icon}
									label={serialWarehouseMeta.label}
									value={serialWarehouse}
									suffix="units"
								/>
								<VehicleAllotmentDropdown
									itemId={item.id}
									icon={serialVehicleMeta.icon}
									label={serialVehicleMeta.label}
									value={serialVehicle}
									unit="each"
								/>
							</div>
							<ProportionBar warehouse={serialWarehouse} vehicle={serialVehicle} />
						</div>
					)}
					{item.is_batch_tracked && (
						<div>
							<GroupHeading>{BATCH_GROUP_HEADING}</GroupHeading>
							<div className="flex flex-wrap gap-3">
								<PlacementTile
									icon={batchWarehouseMeta.icon}
									label={batchWarehouseMeta.label}
									value={batchWarehouse}
									suffix={unitLabel(item.unit, batchWarehouse)}
								/>
								<VehicleAllotmentDropdown
									itemId={item.id}
									icon={batchVehicleMeta.icon}
									label={batchVehicleMeta.label}
									value={batchVehicle}
									unit={item.unit}
								/>
							</div>
							<ProportionBar warehouse={batchWarehouse} vehicle={batchVehicle} />
							<div className="mt-3 divide-y divide-border-subtle/40 border-t border-border-subtle">
								<PlacementRow
									icon={batchLotsMeta.icon}
									label={batchLotsMeta.label}
									value={batches?.lots ?? 0}
								/>
							</div>
						</div>
					)}
				</div>
			</Card>
		);
	}

	// Untracked. No forecast row means no computed split, not no stock: degrade to
	// the warehouse figure we always have rather than unmounting and re-opening the
	// hole in the rail this card fills. `reason` is branched on for the same purpose
	// ReorderHealthMini branches on it — "not forecast because inactive" and "active
	// but nothing to forecast" are unrelated causes, and naming the wrong one is
	// worse than saying nothing.
	const forecast = forecastResult?.forecast;
	const unit = forecast?.unit ?? item.unit;
	const warehouseQuantity = forecast?.warehouseQuantity ?? item.quantity;
	const vehicleQuantity = forecast?.vehicleQuantity ?? null;
	const totalQuantity = forecast?.currentQuantity ?? item.quantity;

	// Tracking was turned off, but consumed serials are never deleted and drained
	// lots keep their recall history. The live split above is the item's truth now;
	// this is the way to the records behind it.
	const archivedUnits = archived
		? summary
			? Object.values(summary.serials).reduce((a, b) => a + b, 0)
			: 0
		: 0;
	const archivedLots = archived ? (summary?.batches.lots ?? 0) : 0;

	return (
		<Card title="Stock Placement" headerAction={archived ? viewAll : undefined}>
			<PlacementSummaryBody
				itemId={item.id}
				unit={unit}
				warehouseQuantity={warehouseQuantity}
				vehicleQuantity={vehicleQuantity}
				totalQuantity={totalQuantity}
				forecastReason={forecastResult?.reason}
				archived={archived}
				archivedUnits={archivedUnits}
				archivedLots={archivedLots}
			/>
		</Card>
	);
}
