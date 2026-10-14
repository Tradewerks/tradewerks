import { useState } from "react";
import { formatCurrency, formatDate } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import { supplierKey } from "../../../lib/suppliers";
import type { PaidCostReceipt } from "../../../types/inventory";

// Rows shown before the table collapses behind "+N more" — same convention as
// the Suppliers card and the Details card's Alt IDs.
const PREVIEW = 8;

/**
 * The itemized ledger `SupplierOriginStrip` rolls up: one row per PURCHASE,
 * not per vendor. That rollup answers "who do we mostly buy this from and
 * roughly what"; this answers "what did we pay, exactly, each time" — the
 * question an average can't, no matter how it's labelled.
 *
 * Sorted newest first, since "what did we just pay" is the common lookup.
 * `focusKey` is the same hover-highlight state `SupplierOriginStrip` and the
 * chart's receipt dots already share — hovering a vendor row there lights up
 * this vendor's rows here too, without adding a second interaction pattern.
 */
export default function PurchaseHistoryTable({
	receipts,
	focusKey,
	filterKey,
}: {
	receipts: PaidCostReceipt[];
	focusKey: string | null;
	/** Pinned from SupplierOriginStrip — when set, only that vendor's rows show. */
	filterKey: string | null;
}) {
	const [expanded, setExpanded] = useState(false);

	if (receipts.length === 0) return null;

	// Filtered BEFORE the preview slice: "show 8 more" should mean 8 more of
	// what's actually being looked at, not 8 more of the unfiltered set.
	// `!== null`, not truthiness: the unattributed bucket's key IS "" (see
	// supplierKey), and `filterKey ? ... : ...` silently treated that as "no
	// filter" — clicking "Unrecorded" looked like it did nothing.
	const hasFilter = filterKey !== null;
	const filteredReceipts = hasFilter
		? receipts.filter((r) => supplierKey(r.supplierId, r.supplierName) === filterKey)
		: receipts;
	const filteredVendorName = hasFilter ? (filteredReceipts[0]?.supplierName ?? "Unrecorded") : null;
	const visible = expanded ? filteredReceipts : filteredReceipts.slice(0, PREVIEW);

	return (
		// Recessed relative to the rollup above (bg-surface-inset, no border/
		// margin of its own beyond the divider) — a sub-panel of that table,
		// not a second equal-weight one. When a vendor's pinned, the same
		// accent bar language SupplierOriginStrip uses on its selected row
		// continues down onto this panel's left edge, so the eye can trace
		// which row up there is still driving what's down here.
		<div
			className={`border-t border-border-subtle bg-surface-inset px-3 py-2.5 border-l-[3px] transition-colors duration-150 ${
				hasFilter ? "border-l-primary" : "border-l-transparent"
			}`}
		>
			{/* The filter itself is set AND cleared up in SupplierOriginStrip — that
			    table is the primary place a vendor filter is shown and handled.
			    This heading only notes the narrowed scope in-line, so a two-row
			    ledger doesn't read as "that's really all this item ever bought"
			    when it's really "that's all Ferguson sold it for". No separate
			    banner, no second Clear control — one is enough. */}
			{/* text-tertiary, not the usual text-muted: this heading sits on
			    bg-surface-inset, and muted's contrast was tuned against base/
			    surface, not against the darker inset well — on light themes it
			    read as washed-out rather than quietly secondary. */}
			<div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
				Every purchase, exact price paid
				{hasFilter && (
					<span className="normal-case font-medium text-text-tertiary">
						{" "}
						— {filteredVendorName} only
					</span>
				)}
			</div>
			<div className="overflow-x-auto">
				<table className="w-full text-xs tabular-nums">
					<thead>
						<tr className="text-text-tertiary text-[10px] uppercase tracking-wider">
							<th className="text-left font-semibold py-1 pr-3">Date</th>
							<th className="text-right font-semibold py-1 px-2">Qty</th>
							<th className="text-right font-semibold py-1 px-2">Unit Cost</th>
							<th className="text-left font-semibold py-1 px-2">Supplier</th>
							<th className="text-left font-semibold py-1 pl-2">Batch</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((r, i) => {
							const key = supplierKey(r.supplierId, r.supplierName);
							// Once a vendor's pinned, every visible row already belongs
							// to that one vendor — hovering the strip's (now-active)
							// row would light up the whole table at once, which signals
							// nothing. The hover preview only earns its keep when the
							// ledger is still the mixed, unfiltered list.
							const focused = hasFilter ? false : focusKey === key;
							return (
								<tr
									// Receipts don't carry their own id here — (at, supplierId)
									// is unique enough for a purchase ledger at this grain.
									key={`${r.at}-${r.supplierId ?? "none"}-${i}`}
									className={`border-t border-border-subtle/60 transition-colors duration-150 ${
										focused ? "bg-surface-raised" : ""
									}`}
								>
									<td className="text-left py-1 pr-3 text-text-secondary">
										{formatDate(r.at)}
									</td>
									<td className="text-right py-1 px-2 text-text-secondary">
										{r.qty} {unitLabel(r.unit, r.qty)}
									</td>
									<td className="text-right py-1 px-2 font-semibold text-text-primary">
										{formatCurrency(r.unitCost)}
									</td>
									<td
										className={`text-left py-1 px-2 ${
											r.supplierName ? "text-text-primary" : "text-text-tertiary italic"
										}`}
									>
										{r.supplierName ?? "Unrecorded"}
									</td>
									<td className="text-left py-1 pl-2 text-text-tertiary">
										{r.batchNumber ?? "—"}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{filteredReceipts.length > PREVIEW && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="mt-2 text-xs font-medium text-primary hover:underline"
				>
					{expanded ? "Show fewer" : `Show ${filteredReceipts.length - PREVIEW} more`}
				</button>
			)}
		</div>
	);
}
