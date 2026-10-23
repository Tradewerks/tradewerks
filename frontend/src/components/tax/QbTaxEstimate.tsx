import { formatDocRatePercent } from "../../lib/formatTax";
import { collapseSnapshotRates } from "../../lib/taxBreakdown";
import type { TaxSnapshotV2 } from "../../types/tax";
import { formatCurrency } from "../../util/util";

/**
 * QuickBooks' tax is the invoice's tax; this discloses our own estimate beside it,
 * the figure QuickBooks is compared against when the two disagree.
 */
export function QbTaxEstimate({ snapshot }: { snapshot: TaxSnapshotV2 }) {
	const rows = collapseSnapshotRates(snapshot);
	return (
		<details className="mt-1">
			<summary className="cursor-pointer text-xs text-text-tertiary">
				Our estimate {formatCurrency(snapshot.total_tax_cents / 100)}
			</summary>
			<ul className="mt-1 space-y-0.5">
				{rows.map((row) => (
					<li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
						<span className="min-w-0 truncate text-text-secondary">
							<span data-testid="qb-estimate-name">{row.name}</span>
							{" · "}
							<span className="tabular-nums">{formatDocRatePercent(row.rate)}</span>
						</span>
						<span className="tabular-nums text-text-secondary">
							{formatCurrency(row.amountCents / 100)}
						</span>
					</li>
				))}
			</ul>
		</details>
	);
}
