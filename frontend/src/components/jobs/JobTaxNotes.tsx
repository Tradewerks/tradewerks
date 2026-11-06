import { Link } from "react-router-dom";
import type { JobTaxSummary } from "../../lib/jobTaxSummary";
import { formatCurrency } from "../../util/util";

const money = (cents: number) => formatCurrency(cents / 100);

/** Reconciles the Financials tax rows with invoices and with visits taxed differently. */
export default function JobTaxNotes({
	summary,
	jobId,
	qbCalculatesTax = false,
}: {
	summary: JobTaxSummary;
	jobId: string;
	qbCalculatesTax?: boolean;
}) {
	const { invoiced, notYetInvoicedCents, differs } = summary;
	if (invoiced.length === 0 && differs.length === 0 && !qbCalculatesTax) return null;
	return (
		<div className="space-y-1 text-xs text-text-muted">
			{invoiced.map((inv) => (
				<p key={inv.invoiceId}>
					Already invoiced: {money(inv.taxCents)} tax on {inv.number}
					{inv.draft ? " (draft)" : ""}
				</p>
			))}
			{invoiced.length > 0 && <p>Not yet invoiced: ≈ {money(notYetInvoicedCents)}</p>}
			{differs.map((d) => (
				<p key={d.text}>
					<Link
						to={`/dispatch/jobs/${jobId}/visits/${d.visitId}`}
						className="underline-offset-2 hover:text-text-secondary hover:underline"
					>
						{d.text}
					</Link>
				</p>
			))}
			{qbCalculatesTax && <p>QuickBooks calculates the final tax when this is invoiced.</p>}
		</div>
	);
}
