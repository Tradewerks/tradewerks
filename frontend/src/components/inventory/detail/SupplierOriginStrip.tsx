import { useState } from "react";
import { Star, Filter, X } from "lucide-react";
import { formatCurrency, formatDate } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import { supplierKey } from "../../../lib/suppliers";
import type { SupplierCostRollup } from "../../../types/inventory";

// Rows shown before the strip collapses behind "+N more" — same convention as
// ItemSuppliersCard and PurchaseHistoryTable. An item bought from many vendors
// over its life would otherwise render one row per vendor, unbounded.
const STRIP_PREVIEW = 6;

/**
 * Where the plotted costs came from. Lives UNDER the plot, not in it: the chart
 * already carries four series plus receipt dots, and a fifth-through-nth colour
 * would cost more legibility than per-vendor hues would buy. Hovering a row
 * highlights that vendor's receipt dots in place (transient, via `focusKey`);
 * clicking one FILTERS the itemized ledger below to that vendor (sticky, via
 * `filterKey`) — the two are separate so a hover preview never fights a pinned
 * filter, and vice versa.
 */
export default function SupplierOriginStrip({
	rows,
	unit,
	focusKey,
	onFocus,
	filterKey,
	onFilterToggle,
}: {
	rows: SupplierCostRollup[];
	/** Denomination for the qty column; null on a unit break, where qty is null anyway. */
	unit: string | null;
	focusKey: string | null;
	onFocus: (key: string | null) => void;
	/** Which vendor the purchase ledger below is pinned to, if any. */
	filterKey: string | null;
	/** Clicking the already-filtered row clears it — same toggle-off convention as focusKey. */
	onFilterToggle: (key: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);

	if (rows.length === 0) return null;

	const visible = expanded ? rows : rows.slice(0, STRIP_PREVIEW);

	return (
		// No border/margin of its own — it's the top of the shared shell
		// CostPriceTrendChart wraps this and PurchaseHistoryTable in.
		<div className="px-3 py-2.5">
			<div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
				Where this stock came from
			</div>
			<div className="overflow-x-auto">
				<table className="w-full text-xs tabular-nums">
					<thead>
						<tr className="text-text-muted text-[10px] uppercase tracking-wider">
							{/* Leftmost, not trailing: this IS the row's primary action,
							    so it leads the row the way a checkbox or expand caret
							    would — not a stray icon tacked on at the far end.
							    border-l reserves the same 3px the active row's accent
							    bar fills in below, so nothing jumps sideways when a
							    filter engages. Icon-only column: the button inside
							    carries its own accessible name, a visible header would
							    just repeat it. */}
							<th className="py-1 pl-2 pr-2 w-8 border-l-[3px] border-l-transparent">
								<span className="sr-only">Filter</span>
							</th>
							<th className="text-left font-semibold py-1 pr-3">Supplier</th>
							<th className="text-right font-semibold py-1 px-2">Receipts</th>
							<th className="text-right font-semibold py-1 px-2">Qty</th>
							<th className="text-right font-semibold py-1 px-2">Avg paid</th>
							{/* pr-2, not flush: the last column's own highlight tint
							    needs a sliver of room before the panel's edge, or a
							    filtered/hovered row's fill reads as cut off rather
							    than intentionally bounded. */}
							<th className="text-right font-semibold py-1 pl-2 pr-2">Last paid</th>
						</tr>
					</thead>
					<tbody>
						{visible.map((r) => {
							const key = supplierKey(
								r.supplierId,
								r.unattributed ? null : r.supplierName,
							);
							const focused = focusKey === key;
							const filtered = filterKey === key;
							// Another vendor is pinned and this isn't it — recede so the
							// active one reads as "the one you picked" against everyone
							// else, not just as one more highlighted row among equals.
							// Full strength on hover, so previewing a different vendor's
							// dots doesn't require clearing the filter first.
							const eclipsed = filterKey != null && !filtered;
							const label = r.unattributed ? "unrecorded purchases" : r.supplierName;
							return (
								<tr
									key={key || "unattributed"}
									// The whole row toggles the filter — a bigger, more
									// forgiving target than the button alone — but the
									// button (below) is what makes it keyboard-reachable
									// and stops its own click from re-triggering this.
									onClick={() => onFilterToggle(key)}
									onMouseEnter={() => onFocus(key)}
									onMouseLeave={() => onFocus(null)}
									className={`cursor-pointer border-t border-border-subtle/60 transition-all duration-150 ${
										filtered ? "bg-primary-bg" : focused ? "bg-surface-raised" : ""
									} ${eclipsed ? "opacity-60 hover:opacity-100" : ""}`}
								>
									<td
										className={`py-1 pl-2 pr-2 text-left border-l-[3px] ${
											filtered ? "border-l-primary" : "border-l-transparent"
										}`}
									>
										{/* The row above is clickable for a big, forgiving mouse
										    target, but a <tr> can't take keyboard focus — this
										    button is the one part of the row that can, so it's
										    always visible rather than a hover-only reveal.
										    stopPropagation keeps its own click from also
										    bubbling to the row's handler and re-toggling. */}
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												onFilterToggle(key);
											}}
											aria-pressed={filtered}
											aria-label={
												filtered
													? `Clear filter — showing only ${label}`
													: `Show only ${label} in the purchase ledger below`
											}
											title={filtered ? "Clear filter" : `Filter to ${label}`}
											className={`inline-flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
												filtered
													? "bg-primary text-on-primary"
													: "text-text-tertiary hover:bg-primary-bg hover:text-primary-text"
											}`}
										>
											{filtered ? <X size={13} /> : <Filter size={13} />}
										</button>
									</td>
									<td
										className={`text-left py-1 pr-3 ${
											filtered
												? "text-primary-text font-semibold"
												: // The gap is a fact about the data, not a vendor —
													// it reads as one only if it's styled like one.
													r.unattributed
													? "text-text-muted italic"
													: "text-text-primary"
										}`}
									>
										<span className="inline-flex items-center gap-1">
											{/* The vendor the reorder forecast will actually buy
											    from — this strip is where that choice meets what
											    was really paid, so it's worth surfacing here too. */}
											{r.isPreferred && (
												<Star
													size={10}
													className="fill-warning-text text-warning-text shrink-0"
													aria-label="Preferred vendor"
												/>
											)}
											{r.supplierName}
										</span>
									</td>
									<td className="text-right py-1 px-2 text-text-secondary">
										{r.receipts}
									</td>
									<td className="text-right py-1 px-2 text-text-secondary">
										{r.qty != null ? `${r.qty} ${unitLabel(unit, r.qty)}` : "—"}
									</td>
									<td className="text-right py-1 px-2 text-text-primary">
										{r.avgUnitCost != null ? formatCurrency(r.avgUnitCost) : "—"}
									</td>
									<td className="text-right py-1 pl-2 pr-2">
										<div className="text-text-primary">
											{r.lastPaid != null ? formatCurrency(r.lastPaid) : "—"}
										</div>
										<div className="text-[10px] text-text-faint">
											{/* A negotiated rate reads as a decision, not a receipt
											    — it must never be mistaken for what was observed. */}
											{r.priceSource === "contract"
												? "contract"
												: formatDate(r.lastAt)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{rows.length > STRIP_PREVIEW && (
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="mt-2 text-xs font-medium text-primary hover:underline"
				>
					{expanded ? "Show fewer" : `Show ${rows.length - STRIP_PREVIEW} more`}
				</button>
			)}
		</div>
	);
}
