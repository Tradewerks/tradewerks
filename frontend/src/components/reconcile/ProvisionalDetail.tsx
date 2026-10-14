import { useState } from "react";
import { Check, GitMerge, Trash2 } from "lucide-react";
import ConfirmDialog from "../ui/ConfirmDialog";
import UnitSelect from "../ui/forms/UnitSelect";
import InventoryItemPicker from "./InventoryItemPicker";
import LineTable from "./LineTable";
import { ActionError, Field, OriginChip, PurchaseOriginLinks } from "./reconcileUi";
import { COL_LABEL, lineCountLabel, moneyRound, shortDate } from "./reconcileFormat";
import {
	useApproveItemMutation,
	useMergeItemMutation,
	useRejectItemMutation,
} from "../../hooks/useInventory";
import { useToast } from "../ui/useToast";
import { DEFAULT_UNIT_CODE, formatQty, normalizeUnitCode, type UnitCode } from "../../lib/units";
import type { ReconcileProvisionalRow, ReconcileTarget } from "../../api/inventory";

const INPUT =
	"h-9 w-full rounded border border-border-input bg-base px-2.5 text-sm text-text-primary transition-colors focus:border-primary focus:outline-none disabled:opacity-60";
const BTN_PRIMARY =
	"inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50";
const BTN_OUTLINE =
	"inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-base px-3 text-xs font-medium text-text-primary transition-colors duration-150 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50";
// Resting fill is bg-base because this now sits inside an error-toned block, and
// the old hover:bg-error-bg was the button's own resting colour — no feedback.
const BTN_DANGER =
	"inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-error-border bg-base px-3 text-xs font-semibold text-error-text transition-colors duration-150 hover:enabled:bg-error-strong hover:enabled:text-on-primary disabled:cursor-not-allowed disabled:opacity-50";

const errText = (e: unknown) => (e instanceof Error ? e.message : null);

/**
 * Completing, folding away, or binning an under-specified item row. Adopting is
 * permanent in the sense that matters: the row leaves this surface, so whatever is
 * wrong with it then is what the catalog keeps. Hence unit on the form - it used to
 * offer cost and a reorder point while silently locking in the wrong unit.
 */
export default function ProvisionalDetail({
	row,
	onSettled,
}: {
	row: ReconcileProvisionalRow;
	onSettled: () => void;
}) {
	const toast = useToast();
	const adopt = useApproveItemMutation();
	const merge = useMergeItemMutation();
	const reject = useRejectItemMutation();

	const [cost, setCost] = useState(row.cost != null ? String(row.cost) : "");
	const [unit, setUnit] = useState<UnitCode>(
		normalizeUnitCode(row.unit) ?? DEFAULT_UNIT_CODE
	);
	const [threshold, setThreshold] = useState(
		row.low_stock_threshold != null ? String(row.low_stock_threshold) : ""
	);
	const [qty, setQty] = useState("0");
	const [location, setLocation] = useState("");
	const [mergeTarget, setMergeTarget] = useState<ReconcileTarget | null>(null);
	const [confirm, setConfirm] = useState<"merge" | "reject" | null>(null);

	const busy = adopt.isPending || merge.isPending || reject.isPending;

	/**
	 * Cost cannot be skipped: with no cost basis the item reads as free to
	 * weighted average cost and shows 100% margin on every line billing it. The
	 * server refuses it too; blocking here only saves the round trip.
	 */
	const costValue = cost.trim() === "" ? null : Number(cost);
	const costOk = costValue !== null && Number.isFinite(costValue) && costValue >= 0;

	/**
	 * What rejecting costs, said before the click instead of in the dialog after
	 * it: the line count is the one fact that decides whether it is safe.
	 */
	const rejectImpact =
		row.lines > 0
			? `${lineCountLabel(row.lines)} (${moneyRound(row.value)}) billing it today` +
				" would go back to naming a part that deducts nothing from stock."
			: "No live document bills it, so nothing else changes.";

	const gaps = [
		row.cost == null && "No cost basis — every margin on this part reads 100%.",
		row.low_stock_threshold == null &&
			"No reorder point — it never reaches the forecast.",
	].filter((g): g is string => Boolean(g));

	async function onAdopt() {
		try {
			await adopt.mutateAsync({
				itemId: row.item_id,
				...(costOk ? { cost: costValue } : {}),
				unit,
				...(threshold.trim() === ""
					? {}
					: { low_stock_threshold: Number(threshold) }),
				...(location.trim() === "" ? {} : { location: location.trim() }),
				...(Number(qty) > 0 ? { initial_warehouse_qty: Number(qty) } : {}),
			});
			toast.success(`"${row.name}" is in the catalog.`);
			onSettled();
		} catch {
			// Surfaced through adopt.error.
		}
	}

	async function onMerge() {
		if (!mergeTarget) return;
		try {
			await merge.mutateAsync({ itemId: row.item_id, targetId: mergeTarget.id });
			toast.success(`Folded "${row.name}" into ${mergeTarget.name}.`);
			setConfirm(null);
			onSettled();
		} catch {
			// Surfaced through merge.error inside the dialog.
		}
	}

	async function onReject() {
		try {
			await reject.mutateAsync(row.item_id);
			toast.success(`Rejected "${row.name}".`);
			setConfirm(null);
			onSettled();
		} catch {
			// Surfaced through reject.error inside the dialog.
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="border-b border-border px-3 py-2.5">
				<div className="flex min-w-0 items-center gap-2">
					<h2
						className="truncate text-base font-semibold text-text-primary"
						title={row.name}
					>
						{row.name}
					</h2>
					<OriginChip origin={row.origin} />
				</div>
				<p className="mt-0.5 text-xs text-text-muted">
					{row.submitted_by
						? `From ${row.submitted_by.name}`
						: "From dispatch"}{" "}
					· {shortDate(row.created_at)}
					{row.lines > 0 && (
						<>
							{" · "}
							<span className="font-medium tabular-nums text-text-secondary">
								{moneyRound(row.value)}
							</span>{" "}
							across {lineCountLabel(row.lines)}
						</>
					)}
				</p>
			</header>

			<div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
				<PurchaseOriginLinks purchases={row.field_purchases} />

				{gaps.length > 0 && (
					<ul className="space-y-1 bg-warning-bg px-3 py-2">
						{gaps.map((g) => (
							<li
								key={g}
								className="text-xs text-warning-text"
							>
								{g}
							</li>
						))}
					</ul>
				)}

				<section className="space-y-3 p-3">
					<h3 className={COL_LABEL}>Adopt into the catalog</h3>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<Field
							label="Cost per unit"
							hint={
								row.cost == null
									? "Required"
									: undefined
							}
							htmlFor="adopt-cost"
						>
							<input
								id="adopt-cost"
								type="number"
								min={0}
								step="0.01"
								value={cost}
								disabled={busy}
								onChange={(e) =>
									setCost(e.target.value)
								}
								className={INPUT}
							/>
						</Field>
						<Field label="Unit of measure" htmlFor="adopt-unit">
							<UnitSelect
								id="adopt-unit"
								value={unit}
								onChange={setUnit}
								disabled={busy}
							/>
						</Field>
						<Field
							label="Low-stock at"
							htmlFor="adopt-threshold"
						>
							<input
								id="adopt-threshold"
								type="number"
								min={0}
								step="0.01"
								value={threshold}
								disabled={busy}
								onChange={(e) =>
									setThreshold(e.target.value)
								}
								className={INPUT}
							/>
						</Field>
						<Field
							label="Location (optional)"
							htmlFor="adopt-location"
						>
							<input
								id="adopt-location"
								type="text"
								value={location}
								disabled={busy}
								onChange={(e) =>
									setLocation(
										e.target.value.slice(0, 255)
									)
								}
								placeholder="e.g. A42 - 325"
								className={INPUT}
							/>
						</Field>
						<Field
							label="Warehouse qty now"
							htmlFor="adopt-qty"
						>
							<input
								id="adopt-qty"
								type="number"
								min={0}
								step="1"
								value={qty}
								disabled={busy}
								onChange={(e) =>
									setQty(e.target.value)
								}
								className={INPUT}
							/>
						</Field>
					</div>
					<button
						type="button"
						disabled={busy || !costOk}
						title={
							!costOk
								? "A cost is required to adopt an item"
								: undefined
						}
						onClick={() => void onAdopt()}
						className={BTN_PRIMARY}
					>
						<Check size={12} />
						Adopt into catalog
					</button>
					<ActionError error={adopt.error} />
				</section>

				<section className="space-y-2 p-3">
					<h3 className={COL_LABEL}>
						Already in the catalog under another name?
					</h3>
					<div className="flex flex-wrap items-center gap-2">
						<div className="min-w-[14rem] flex-1">
							<InventoryItemPicker
								ariaLabel={`Merge ${row.name} into`}
								value={mergeTarget}
								onChange={setMergeTarget}
								excludeId={row.item_id}
								disabled={busy}
								placeholder="Search for the real item…"
							/>
						</div>
						<button
							type="button"
							disabled={!mergeTarget || busy}
							onClick={() => setConfirm("merge")}
							className={BTN_OUTLINE}
						>
							<GitMerge size={12} />
							Merge
						</button>
					</div>
				</section>

				{row.vehicle_stocks.length > 0 && (
					<section className="space-y-1.5 p-3">
						<h3 className={COL_LABEL}>On vehicles</h3>
						<div className="flex flex-wrap gap-1.5">
							{row.vehicle_stocks.map((vs) => (
								<span
									key={vs.vehicle.id}
									className="rounded border border-border-subtle bg-surface px-2 py-1 text-[11px] text-text-secondary"
								>
									{vs.vehicle.name}{" "}
									<span className="tabular-nums text-text-muted">
										{formatQty(
											vs.qty_on_hand,
											unit
										)}
									</span>
								</span>
							))}
						</div>
					</section>
				)}

				<LineTable itemId={row.item_id} unit={unit} />

				{/* The only action on this pane that destroys a row, so it does not
				    wear the button-plus-caption shape the reversible ones share. */}
				<section className="space-y-2 p-3">
					<h3 className={COL_LABEL}>Not a real part</h3>
					<div className="rounded-md border border-error-border bg-error-bg p-2.5">
						<p className="text-xs font-medium text-error-text">
							Deletes “{row.name}” from the catalog.
							It cannot be undone.
						</p>
						<p className="mt-1 text-xs text-error-text">
							{rejectImpact}
						</p>
						<button
							type="button"
							disabled={busy}
							onClick={() => setConfirm("reject")}
							className={`mt-2.5 ${BTN_DANGER}`}
						>
							<Trash2 size={12} />
							Reject this part
						</button>
					</div>
					<p className="text-[11px] text-text-muted">
						A real part already in the catalog under another
						name is a Merge, not a rejection.
					</p>
				</section>
			</div>

			{/* Both of these end the row for good, so Reject asks first instead of firing on the
			    first click with nothing in between. */}
			<ConfirmDialog
				open={confirm === "merge"}
				title="Merge this part away?"
				body={
					<>
						Every line pointing at <strong>{row.name}</strong>{" "}
						will point at <strong>{mergeTarget?.name}</strong>{" "}
						instead, and this row is removed. It cannot be
						undone.
					</>
				}
				confirmLabel="Merge"
				pending={merge.isPending}
				error={errText(merge.error)}
				onConfirm={() => void onMerge()}
				onCancel={() => setConfirm(null)}
			/>
			<ConfirmDialog
				open={confirm === "reject"}
				title="Reject this part?"
				body={
					<>
						<strong>{row.name}</strong> is removed from the
						catalog.
						{row.lines > 0 && (
							<>
								{" "}
								{lineCountLabel(row.lines)}{" "}
								billing it will go back to naming
								a part nothing deducts from stock.
							</>
						)}
					</>
				}
				confirmLabel="Reject"
				tone="destructive"
				pending={reject.isPending}
				error={errText(reject.error)}
				onConfirm={() => void onReject()}
				onCancel={() => setConfirm(null)}
			/>
		</div>
	);
}
