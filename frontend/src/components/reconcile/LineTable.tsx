import { Link } from "react-router-dom";
import { ExternalLink, FileWarning } from "lucide-react";
import { useReconcileLinesQuery } from "../../hooks/useInventory";
import { formatQty } from "../../lib/units";
import {
	COL_LABEL,
	FOCUS_RING,
	documentHref,
	documentLabel,
	lineCountLabel,
	money,
	shortDate,
} from "./reconcileFormat";

/**
 * The documents behind the selected row. The old surface said "6 lines · Quotes,
 * Invoices" and stopped, so deciding what a name meant meant leaving the page to go
 * hunting. A dispatcher settles from here: the money, who it was billed to, and a
 * link into the document itself.
 */
export default function LineTable({
	name,
	foldedName,
	itemId,
	unit,
}: {
	name?: string;
	/** For a dismissal, which is stored folded — one decision covers every casing. */
	foldedName?: string;
	itemId?: string;
	/** Quantities read as bare numbers without it; pass the item's unit when known. */
	unit?: string;
}) {
	const { data, isLoading, isError } = useReconcileLinesQuery({ name, foldedName, itemId });

	const lines = data?.lines ?? [];
	const total = data?.total ?? 0;

	return (
		<section aria-label="Lines billing this part" className="min-w-0">
			{/* The one header naming these rows. The section title has to exist for
			    the loading, error and empty states — none of which render a table —
			    so the document column's own label was the redundant half. */}
			<header className="flex items-baseline justify-between gap-2 border-b border-border px-3 py-2">
				<h3 className="text-xs font-semibold text-text-primary">
					Billed on
				</h3>
				{!isLoading && !isError && (
					<span className="text-[11px] tabular-nums text-text-muted">
						{lines.length < total
							? `${lines.length} of ${total} lines`
							: lineCountLabel(total)}
					</span>
				)}
			</header>

			{isLoading ? (
				<div aria-hidden className="animate-pulse space-y-2 px-3 py-3">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="h-3 w-full rounded bg-surface-raised"
						/>
					))}
				</div>
			) : isError ? (
				<p className="flex items-center gap-1.5 px-3 py-3 text-xs text-error-text">
					<FileWarning size={13} />
					Could not load the lines for this part.
				</p>
			) : lines.length === 0 ? (
				<p className="px-3 py-3 text-xs text-text-muted">
					No live document bills this part right now.
				</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full min-w-[34rem] border-collapse">
						<thead>
							<tr className="border-b border-border-subtle bg-surface">
								<th
									className={`${COL_LABEL} px-3 py-1.5 text-left`}
								>
									<span className="sr-only">
										Document
									</span>
								</th>
								<th
									className={`${COL_LABEL} px-3 py-1.5 text-left`}
								>
									Client
								</th>
								<th
									className={`${COL_LABEL} px-3 py-1.5 text-left`}
								>
									Date
								</th>
								<th
									className={`${COL_LABEL} px-3 py-1.5 text-right`}
								>
									Qty
								</th>
								<th
									className={`${COL_LABEL} px-3 py-1.5 text-right`}
								>
									Total
								</th>
							</tr>
						</thead>
						<tbody>
							{lines.map((l) => {
								const href = documentHref(l);
								return (
									<tr
										key={`${l.entity}-${l.line_id}`}
										className="border-b border-border-subtle last:border-0 hover:bg-surface-raised"
									>
										<td className="px-3 py-1.5">
											{href ? (
												<Link
													to={
														href
													}
													className={`inline-flex items-center gap-1 text-xs font-medium text-primary-text transition-colors hover:underline ${FOCUS_RING}`}
												>
													{documentLabel(
														l
													)}
													<ExternalLink
														size={
															10
														}
														className="flex-shrink-0"
													/>
												</Link>
											) : (
												<span className="text-xs text-text-secondary">
													{documentLabel(
														l
													)}
												</span>
											)}
										</td>
										<td className="max-w-[10rem] truncate px-3 py-1.5 text-xs text-text-muted">
											{l.client_name ??
												"—"}
										</td>
										<td className="whitespace-nowrap px-3 py-1.5 text-xs tabular-nums text-text-muted">
											{shortDate(
												l.occurred_at
											)}
										</td>
										<td className="whitespace-nowrap px-3 py-1.5 text-right text-xs tabular-nums text-text-secondary">
											{formatQty(
												l.quantity,
												unit
											)}
										</td>
										<td className="whitespace-nowrap px-3 py-1.5 text-right text-xs font-medium tabular-nums text-text-primary">
											{money(
												l.value
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
