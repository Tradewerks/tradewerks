import { useMemo } from "react";
import { ArrowRight, History } from "lucide-react";
import { useSupplierMovementsQuery } from "../../hooks/useSuppliers";
import { movementReasonLabel, movementReasonIcon } from "../../lib/movementReasons";
import type { SupplierMovement } from "../../types/suppliers";
import { formatCurrency, formatDateTime } from "../../util/util";
import { unitLabel } from "../../lib/units";
import LoadSvg from "../../assets/icons/loading.svg?react";
import EmptyState from "../ui/EmptyState";
import Card from "../ui/Card";
import { HEADER_META } from "../ui/headerActions";

function locationLabel(m: SupplierMovement): string {
	if (m.to_vehicle) return m.to_vehicle.name;
	if (m.to_location_type === "warehouse") return "Warehouse";
	if (m.to_location_type === "consumed") return "Consumed";
	if (m.to_location_type === "adjustment") return "Adjustment";
	return m.to_location_type;
}

function actorLabel(actorType: string): string {
	if (actorType === "technician") return "Technician";
	if (actorType === "dispatcher") return "Dispatcher";
	if (actorType === "system") return "System";
	return actorType;
}

function MovementRow({ m }: { m: SupplierMovement }) {
	const Icon = movementReasonIcon(m.reason);
	const qty = Number(m.qty);
	const unitCost = m.unit_cost != null ? Number(m.unit_cost) : null;
	return (
		<li className="flex items-start gap-2.5 px-4 py-2.5 border-t border-border-subtle first:border-t-0">
			<div className="shrink-0 mt-0.5 flex items-center justify-center h-6 w-6 rounded-full bg-surface text-text-secondary">
				<Icon size={13} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2 flex-wrap">
					<span
						className="text-sm font-medium text-text-primary truncate"
						title={m.inventory_item.name}
					>
						{m.inventory_item.name}
					</span>
					<span className="text-xs font-semibold tabular-nums text-text-secondary bg-surface border border-border-subtle rounded px-1.5 py-0.5">
						{qty} {unitLabel(m.unit, qty)}
					</span>
					{unitCost != null && (
						<span className="text-xs font-semibold text-text-primary">
							{formatCurrency(unitCost)}
							<span className="text-text-muted font-normal"> /{m.unit}</span>
						</span>
					)}
				</div>
				<div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted flex-wrap">
					<span>{movementReasonLabel(m.reason)}</span>
					<ArrowRight size={11} className="text-text-faint" />
					<span>{locationLabel(m)}</span>
				</div>
				{m.note && (
					<div className="mt-0.5 text-xs text-text-secondary line-clamp-2 break-words">
						{m.note}
					</div>
				)}
			</div>
			<div className="shrink-0 text-right text-[11px] text-text-muted whitespace-nowrap">
				{formatDateTime(m.created_at)}
				<span className="text-text-faint"> · {actorLabel(m.actor_type)}</span>
			</div>
		</li>
	);
}

/**
 * Cursor-paginated purchase ledger for one vendor, across every item it's
 * named on. Same infinite-query pattern as the item detail page's
 * StockMovementList — the cross-item counterpart, one row per movement with
 * the item named instead of assumed. Pages live in the query cache, not
 * component state, so "Load more" can't append a page twice.
 */
export default function SupplierMovementList({ supplierId }: { supplierId: string }) {
	const { data, isLoading, isFetching, hasNextPage, fetchNextPage } =
		useSupplierMovementsQuery(supplierId);

	const rows: SupplierMovement[] = useMemo(
		() => data?.pages.flatMap((p) => p.movements) ?? [],
		[data],
	);

	const isFirstLoad = isLoading && rows.length === 0;

	return (
		<Card
			title="Purchase History"
			flush
			headerAction={<span className={HEADER_META}>Every item bought from this vendor</span>}
		>

			{isFirstLoad && (
				<div className="flex justify-center py-12">
					<LoadSvg className="w-7 h-7" />
				</div>
			)}

			{!isFirstLoad && rows.length === 0 && (
				<EmptyState
					icon={<History size={26} />}
					title="No purchases recorded yet"
					description="Receiving stock and naming this vendor will show up here."
				/>
			)}

			{rows.length > 0 && (
				<ol className="max-h-[480px] overflow-y-auto">
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
