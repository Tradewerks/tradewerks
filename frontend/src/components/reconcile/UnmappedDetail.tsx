import { useState } from "react";
import { Link2, Plus, XCircle } from "lucide-react";
import InventoryItemPicker from "./InventoryItemPicker";
import LineTable from "./LineTable";
import { ActionError, PurchaseOriginLinks, TierChip } from "./reconcileUi";
import {
	COL_LABEL,
	ENTITY_LABELS,
	FOCUS_RING,
	lineCountLabel,
	moneyRound,
} from "./reconcileFormat";
import {
	useApplyLinkageMatchMutation,
	useCreateProvisionalItemMutation,
	useDismissUnmappedMutation,
} from "../../hooks/useInventory";
import { useToast } from "../ui/useToast";
import type { LinkageCandidate, ReconcileTarget } from "../../api/inventory";

const BTN_PRIMARY =
	"inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50";
const BTN_OUTLINE =
	"inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-base px-3 text-xs font-medium text-text-primary transition-colors duration-150 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Settling one unmapped name. Three answers and only three: map it, create and
 * map, or mark it never stocked. The third is a real answer rather than a
 * postponement, which is why it sits beside the other two instead of in a menu.
 *
 * Remounted per row - the parent keys on the name - so a half-typed reason or a
 * chosen target never carries onto the next one.
 */
export default function UnmappedDetail({
	row,
	onSettled,
}: {
	row: LinkageCandidate;
	/** The row a decision settled is no longer the work; the queue moves on. */
	onSettled: () => void;
}) {
	const toast = useToast();
	const apply = useApplyLinkageMatchMutation();
	const create = useCreateProvisionalItemMutation();
	const dismiss = useDismissUnmappedMutation();

	const [target, setTarget] = useState<ReconcileTarget | null>(null);
	const [intentional, setIntentional] = useState(false);
	const [reason, setReason] = useState("");

	const busy = apply.isPending || create.isPending || dismiss.isPending;

	async function mapTo(itemId: string, label: string) {
		try {
			const updated = await apply.mutateAsync({
				name: row.name,
				inventory_item_id: itemId,
			});
			const lines = Object.values(updated).reduce((a, b) => a + b, 0);
			toast.success(`${lineCountLabel(lines)} now point at ${label}.`);
			onSettled();
		} catch {
			// Surfaced inline through apply.error; caught to avoid an unhandled rejection.
		}
	}

	/**
	 * Create-and-map in one action, or the row is a dead end: the dispatcher has
	 * to leave, create the item, and come back to find the row again. The item
	 * survives a failed map — it lands in the Needs detail tab — and the server
	 * folds by name, so a retry maps rather than duplicating.
	 */
	async function createAndMap() {
		try {
			const created = await create.mutateAsync({ name: row.name });
			await mapTo(created.id, created.name);
		} catch {
			// Both mutations surface their own error.
		}
	}

	async function markIntentional() {
		try {
			await dismiss.mutateAsync({
				name: row.name,
				reason: reason.trim() || undefined,
			});
			toast.success(
				`"${row.name}" will stay billable and stop being asked about.`
			);
			onSettled();
		} catch {
			// Surfaced through dismiss.error.
		}
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="border-b border-border px-3 py-2.5">
				<h2
					className="truncate text-base font-semibold text-text-primary"
					title={row.name}
				>
					{row.name}
				</h2>
				<p className="mt-0.5 text-xs text-text-muted">
					<span className="font-medium tabular-nums text-text-secondary">
						{moneyRound(row.value)}
					</span>{" "}
					billed across {lineCountLabel(row.lines)} ·{" "}
					{row.entities.map((e) => ENTITY_LABELS[e]).join(", ")}
				</p>
			</header>

			<div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
				<PurchaseOriginLinks purchases={row.field_purchases} />

				<section className="space-y-3 p-3">
					<h3 className={COL_LABEL}>Point these lines at</h3>

					{/* The suggestion is shown as itself — name and SKU — rather than
					    pre-selected inside a picker, where accepting a machine guess
					    looked identical to making a choice. */}
					{row.match && (
						<div className="flex flex-wrap items-center gap-2 rounded border border-success-border bg-success-bg p-2.5">
							<span className="min-w-0 flex-1">
								<span className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-sm font-medium text-text-primary">
										{row.match.name}
									</span>
									<TierChip
										tier={
											row.match
												.tier
										}
									/>
								</span>
								<span className="block truncate text-[11px] text-text-muted">
									{row.match.sku ?? "No SKU"}
								</span>
							</span>
							<button
								type="button"
								disabled={busy}
								onClick={() =>
									void mapTo(
										row.match!
											.inventory_item_id,
										row.match!.name
									)
								}
								className={BTN_PRIMARY}
							>
								<Link2 size={12} />
								Accept &amp; map {row.lines}
							</button>
						</div>
					)}

					<div className="space-y-2">
						<label
							htmlFor="reconcile-map-target"
							className={COL_LABEL}
						>
							{row.match
								? "Or choose a different item"
								: "Choose a catalog item"}
						</label>
						<div className="flex flex-wrap items-center gap-2">
							<div className="min-w-[14rem] flex-1">
								<InventoryItemPicker
									id="reconcile-map-target"
									ariaLabel={`Catalog item for ${row.name}`}
									value={target}
									onChange={setTarget}
									disabled={busy}
								/>
							</div>
							<button
								type="button"
								disabled={!target || busy}
								onClick={() =>
									target &&
									void mapTo(
										target.id,
										target.name
									)
								}
								className={BTN_PRIMARY}
							>
								<Link2 size={12} />
								Map {row.lines}
							</button>
						</div>
					</div>

					<div className="flex flex-wrap items-center gap-2 pt-1">
						<button
							type="button"
							disabled={busy}
							onClick={() => void createAndMap()}
							className={BTN_OUTLINE}
						>
							<Plus size={12} />
							Create as a new part
						</button>
						<span className="text-[11px] text-text-muted">
							Adds it awaiting detail, then points these
							lines at it.
						</span>
					</div>

					<ActionError error={apply.error ?? create.error} />
				</section>

				<section className="space-y-2 p-3">
					<h3 className={COL_LABEL}>Never stocked?</h3>
					{intentional ? (
						<>
							<input
								type="text"
								value={reason}
								maxLength={500}
								onChange={(e) =>
									setReason(e.target.value)
								}
								placeholder="Why — e.g. subcontractor's own material"
								aria-label="Reason this part is never stocked"
								className="h-9 w-full rounded border border-border-input bg-base px-2.5 text-sm text-text-primary transition-colors placeholder:text-text-faint focus:border-primary focus:outline-none"
							/>
							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={busy}
									onClick={() =>
										void markIntentional()
									}
									className={BTN_PRIMARY}
								>
									Mark intentional
								</button>
								<button
									type="button"
									onClick={() =>
										setIntentional(
											false
										)
									}
									className={`cursor-pointer rounded px-1.5 py-1 text-xs text-text-muted transition-colors hover:text-text-primary ${FOCUS_RING}`}
								>
									Cancel
								</button>
							</div>
						</>
					) : (
						<div className="flex flex-wrap items-center gap-2">
							<button
								type="button"
								disabled={busy}
								onClick={() => setIntentional(true)}
								className={BTN_OUTLINE}
							>
								<XCircle size={12} />
								Mark intentional
							</button>
							<span className="text-[11px] text-text-muted">
								Keeps the lines billable and stops
								counting them against coverage.
							</span>
						</div>
					)}
					<ActionError error={dismiss.error} />
				</section>

				<LineTable name={row.name} />
			</div>
		</div>
	);
}
