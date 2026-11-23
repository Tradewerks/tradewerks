import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useBatchesQuery } from "../../hooks/useTracking";
import type { BatchListRow } from "../../types/tracking";

/**
 * "vehicle_out" — this vehicle is the movement source (field_loss, return to
 * warehouse, transfer/audit decreases): remaining qty comes from this
 * vehicle's own on-hand breakdown for the batch.
 * "warehouse_in" — warehouse is the source (warehouse_exchange restock):
 * remaining qty is the batch's qty_in_warehouse.
 * "unconstrained" — source is the untracked "adjustment" bucket (audit/
 * transfer increases); the backend applies no from-location check for these
 * (see inventoryTracking.ts's applySerialMovement/applyBatchMovement — the
 * from-status check is skipped for external/adjustment sources), so there's
 * no meaningful "available" number to show or filter by.
 */
export type BatchPickDirection = "vehicle_out" | "warehouse_in" | "unconstrained";

export interface ExistingBatchPickerProps {
	itemId: string;
	vehicleId: string;
	direction: BatchPickDirection;
	/** null = let the backend FIFO-auto-allocate (default, always valid). */
	value: string | null;
	onChange: (batchId: string | null) => void;
}

function availableFor(direction: BatchPickDirection, vehicleId: string, b: BatchListRow): number | null {
	if (direction === "vehicle_out") return b.vehicles.find((v) => v.vehicle_id === vehicleId)?.qty_on_hand ?? 0;
	if (direction === "warehouse_in") return b.qty_in_warehouse;
	return null;
}

// Simple optional batch-tracked-line picker for the non-supplier_purchase
// existing-pick bucket. Selecting nothing (the default) submits without
// batch_picks, letting the backend's FIFO auto-allocation handle it — this
// is always a valid, no-error outcome for a batch-tracked (non-serialized)
// line on a deduction/adjustment movement.
export default function ExistingBatchPicker({ itemId, vehicleId, direction, value, onChange }: ExistingBatchPickerProps) {
	const { t } = useTranslation();
	const { data } = useBatchesQuery(itemId);
	const batches = useMemo(() => data?.batches ?? [], [data]);

	const options = useMemo(
		() => (direction === "unconstrained" ? batches : batches.filter((b) => (availableFor(direction, vehicleId, b) ?? 0) > 0)),
		[batches, direction, vehicleId],
	);

	return (
		<div className="space-y-1">
			<label className="block text-xs font-medium text-text-tertiary uppercase tracking-wider">
				{t("batchPicker.label")}
			</label>
			<select
				aria-label={t("batchPicker.aria")}
				value={value ?? ""}
				onChange={(e) => onChange(e.target.value || null)}
				className="w-full border border-border-input px-2.5 h-[34px] rounded bg-base text-text-primary text-sm focus:border-primary focus:outline-none transition-colors"
			>
				<option value="">{t("batchPicker.fifo")}</option>
				{options.map((b) => {
					const avail = availableFor(direction, vehicleId, b);
					return (
						<option key={b.id} value={b.id}>
							{b.batch_number}
							{avail !== null ? ` (${t("batchPicker.available", { n: avail })})` : ""}
							{b.recalled_at ? ` — ${t("batchPicker.recalled")}` : ""}
						</option>
					);
				})}
			</select>
		</div>
	);
}
