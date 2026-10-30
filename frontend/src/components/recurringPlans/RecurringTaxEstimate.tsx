import { formatCurrency } from "../../util/util";
import type { TaxEstimate } from "../../types/recurringPlans";

export default function RecurringTaxEstimate({ estimate }: { estimate: TaxEstimate | undefined }) {
	if (!estimate) return null;

	if (estimate.status === "exempt") {
		return <p className="text-xs text-text-muted">Client is tax exempt</p>;
	}
	if (estimate.status === "unknown") {
		return (
			<p className="text-xs text-text-muted">
				Tax is added to each job at the service address rate.
			</p>
		);
	}

	const money = (cents: number) => formatCurrency(cents / 100);
	return (
		<div className="space-y-0.5">
			<p className="text-sm text-text-secondary tabular-nums">
				{`Plan price ${money(estimate.subtotal_cents)} · Est. tax ${money(estimate.tax_cents)} · Est. total ${money(estimate.total_cents)}`}
			</p>
			{estimate.place && (
				<p className="text-xs text-text-muted">
					{`Estimated at today's ${estimate.place} rate. Each job is taxed when it's created.`}
				</p>
			)}
		</div>
	);
}
