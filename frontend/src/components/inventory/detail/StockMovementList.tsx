import { useMemo } from "react";
import {
	ArrowDownToLine,
	ArrowLeftRight,
	ArrowRight,
	ClipboardCheck,
	History,
	PackageMinus,
	PackagePlus,
	PackageX,
	RotateCcw,
	ShoppingCart,
	Truck,
	Undo2,
	Wrench,
	type LucideIcon,
} from "lucide-react";
import { useInventoryMovementsQuery } from "../../../hooks/useInventory";
import type {
	StockLocationType,
	StockMovement,
	StockMovementReason,
} from "../../../types/inventory";
import { formatDateTime } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import LoadSvg from "../../../assets/icons/loading.svg?react";
import EmptyState from "../../ui/EmptyState";
import Card from "../../ui/Card";
import { HEADER_META } from "../../ui/headerActions";
import { QueryErrorState } from "./chartShared";

const REASON_META: Record<StockMovementReason, { label: string; icon: LucideIcon }> = {
	receive: { label: "Received", icon: ArrowDownToLine },
	restock: { label: "Restocked to vehicle", icon: Truck },
	return_to_warehouse: { label: "Returned to warehouse", icon: Undo2 },
	parts_used: { label: "Used on visit", icon: Wrench },
	direct_consumption: { label: "Consumed", icon: PackageMinus },
	loss: { label: "Loss", icon: PackageX },
	audit_correction: { label: "Audit correction", icon: ClipboardCheck },
	transfer: { label: "Transfer", icon: ArrowLeftRight },
	reversal: { label: "Reversal", icon: RotateCcw },
	initial: { label: "Initial stock", icon: PackagePlus },
	supplier_purchase: { label: "Supplier purchase", icon: ShoppingCart },
};

function locationLabel(
	type: StockLocationType,
	vehicle: { name: string } | null,
): string {
	switch (type) {
		case "warehouse":
			return "Warehouse";
		case "vehicle":
			return vehicle?.name ?? "Vehicle";
		case "consumed":
			return "Consumed";
		case "adjustment":
			return "Adjustment";
		case "external":
			return "External";
		default:
			return type;
	}
}

function actorLabel(actorType: string): string {
	if (actorType === "technician") return "Technician";
	if (actorType === "dispatcher") return "Dispatcher";
	if (actorType === "system") return "System";
	return actorType;
}

function MovementRow({ m }: { m: StockMovement }) {
	const meta = REASON_META[m.reason] ?? { label: m.reason, icon: History };
	const Icon = meta.icon;
	const qty = Number(m.qty);
	return (
		<li className="flex items-start gap-2.5 px-4 py-2.5 border-t border-border-subtle first:border-t-0">
			<div className="shrink-0 mt-0.5 flex items-center justify-center h-6 w-6 rounded-full bg-surface text-text-secondary">
				<Icon size={13} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2 flex-wrap">
					<span className="text-sm font-medium text-text-primary">{meta.label}</span>
					{/* The row's OWN stamped unit, not the item's current one — the
					    ledger keeps each movement in the unit it was made in. */}
					<span className="text-xs font-semibold tabular-nums text-text-secondary bg-surface border border-border-subtle rounded px-1.5 py-0.5">
						{qty} {unitLabel(m.unit, qty)}
					</span>
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted flex-wrap">
					<span>{locationLabel(m.from_location_type, m.from_vehicle)}</span>
					<ArrowRight size={11} className="text-text-faint" />
					<span>{locationLabel(m.to_location_type, m.to_vehicle)}</span>
				</div>
				{m.note && (
					<div className="mt-0.5 text-xs text-text-secondary line-clamp-2 break-words">
						{m.note}
					</div>
				)}
			</div>
			{/* One line, not two: at half width the vertical budget matters more
			    than separating timestamp from actor. */}
			<div className="shrink-0 text-right text-[11px] text-text-muted whitespace-nowrap">
				{formatDateTime(m.created_at)}
				<span className="text-text-faint"> · {actorLabel(m.actor_type)}</span>
			</div>
		</li>
	);
}

// Cursor-paginated stock-movement ledger for a single item. The pages live in
// the infinite query (hook), so "Load more" is fetchNextPage and the rows are
// a flatMap over what the cache holds — nothing is accumulated in component
// state, so a page can't be appended twice and a cursor can't outlive the
// result set it came from. keepPreviousData (in the hook) keeps the visible
// list stable while a new range's first page loads.
//
// Range is a SERVER-side filter (`created_after`, from the tab-level control),
// so it applies to the whole ledger, not just pages already fetched. Changing
// it is a new query key, which is what resets pagination.
export default function StockMovementList({
	itemId,
	createdAfter,
}: {
	itemId: string;
	createdAfter?: string;
}) {
	const { data, isLoading, isFetching, isError, refetch, hasNextPage, fetchNextPage } =
		useInventoryMovementsQuery(itemId, { createdAfter });

	const rows: StockMovement[] = useMemo(
		() => data?.pages.flatMap((p) => p.movements) ?? [],
		[data],
	);

	const isFirstLoad = isLoading && rows.length === 0;

	return (
		<Card
			title="Stock History"
			flush
			// Short caption: the long one crowded the title at half width.
			headerAction={<span className={HEADER_META}>Warehouse and vehicle</span>}
		>

			{isFirstLoad && (
				<div className="flex justify-center py-12">
					<LoadSvg className="w-7 h-7" />
				</div>
			)}

			{/* A failed read is not an empty ledger — say so, with a way back. */}
			{isError && rows.length === 0 && (
				<QueryErrorState what="stock history" onRetry={() => refetch()} />
			)}

			{/* One empty state, not two: with a server-side filter an empty
			    response IS "nothing in this range", so the copy points at the
			    range control when one is active. */}
			{!isFirstLoad && !isError && rows.length === 0 && (
				<EmptyState
					icon={<History size={26} />}
					title={createdAfter ? "No movements in this range" : "No stock movements yet"}
					description={
						createdAfter
							? "Widen the range above to see more of this item's stock history."
							: "Receiving, adjustments, restocks, and usage will appear here."
					}
				/>
			)}

			{/* Half a row's width, bounded height — a 500-row ledger shouldn't
			    push the rest of the tab off the page. UsageReport caps its list
			    at the same 420px so the pair reads as one balanced row. */}
			{rows.length > 0 && (
				<ol className="max-h-[420px] overflow-y-auto">
					{rows.map((m) => (
						<MovementRow key={m.id} m={m} />
					))}
				</ol>
			)}

			{hasNextPage && (
				<div className="px-4 py-3 flex justify-center border-t border-border-subtle">
					<button
						type="button"
						onClick={() => fetchNextPage()}
						disabled={isFetching}
						className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors disabled:opacity-50"
					>
						{isFetching ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
		</Card>
	);
}
