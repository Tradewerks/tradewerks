import { Link } from "react-router-dom";
import { AlertTriangle, Receipt, TriangleAlert } from "lucide-react";
import Card from "../ui/Card";
import { HEADER_META } from "../ui/headerActions";
import { useFieldPurchases } from "../../hooks/useFieldPurchases";
import { useAnyPermission } from "../../hooks/usePermission";
import { money } from "./fieldPurchaseFormat";
import {
	FIELD_PURCHASE_STATUS_LABELS,
	isPrePurchase,
	type FieldPurchase,
	type FieldPurchaseStatus,
} from "../../types/fieldPurchases";
import { purchaseHref } from "./queueFilters";

function statusTone(status: FieldPurchaseStatus) {
	switch (status) {
		case "approved":
			return "text-success";
		case "rejected":
		case "preauth_denied":
			return "text-error-text";
		case "queried":
			return "text-warning";
		default:
			return "text-text-secondary";
	}
}

/** Lines that actually reached the customer's bill. */
function billedCount(p: FieldPurchase): number {
	return p.lines.filter((l) => l.visit_line_item_id).length;
}

interface Props {
	jobId: string;
	/** Narrows to one visit's purchases. Omit on a job page. */
	visitId?: string;
}

/**
 * What THIS job owes of a receipt, which on a split is not the receipt. Attributing
 * the whole total to every job it touched double-counted the spend across their
 * two pages and overstated what each job cost.
 */
function shareOfJob(p: FieldPurchase, jobId: string): number {
	if (p.allocations.length <= 1) return Number(p.total);
	return Number(p.allocations.find((a) => a.job_id === jobId)?.amount ?? 0);
}

/**
 * What was bought in the field for this job - the other half of an allocation that
 * was written and read by nothing, leaving a part bought mid-job visible only
 * inside the review queue. Always rendered for anyone who may see purchases: it
 * pairs with Linked Invoices on the Financials tab, and a panel that vanished when
 * empty left that card with a hole beside it.
 */
export default function JobFieldPurchases({ jobId, visitId }: Props) {
	const canSee = useAnyPermission(["view_field_purchases", "review_field_purchases"]);
	const {
		data: purchases = [],
		isLoading,
		isError,
	} = useFieldPurchases({ job_id: jobId }, canSee);

	if (!canSee) return null;

	// A draft is a technician's unfinished sheet with no receipt behind it and an
	// allocation that is usually still zero. It is not a cost this job has
	// incurred, and dispatch has no action on one.
	const claimed = purchases.filter((p) => p.status !== "draft");
	// The list endpoint filters by job, not by visit — the visit lives on the
	// allocation, and a job's purchases are few enough to narrow here.
	const rows = visitId
		? claimed.filter((p) => p.allocations.some((a) => a.job_visit_id === visitId))
		: claimed;

	// Only money actually handed over. Before the counter `total` holds the estimate,
	// so summing every row reported an unspent ask as cost this job had incurred —
	// on the one panel a dispatcher reads to learn what the job cost.
	const bought = rows.filter((p) => !isPrePurchase(p.status));
	const total = bought.reduce((n, p) => n + shareOfJob(p, jobId), 0);
	const pending = rows.length - bought.length;

	const summary =
		!isLoading && !isError && rows.length > 0 ? (
			<span className={HEADER_META}>
				{bought.length} · {money(total)}
				{pending > 0 && <span className="ml-1.5">+{pending} not bought yet</span>}
			</span>
		) : undefined;

	return (
		<Card title="Field Purchases" headerAction={summary}>
			{isLoading ? (
				<div aria-busy="true">
					<span className="sr-only">Loading field purchases</span>
					{[0, 1, 2].map((i) => (
						<div key={i} className="flex items-center gap-3 py-2" aria-hidden="true">
							<div className="flex-1 h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
							<div className="w-16 h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
							<div className="w-20 h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
						</div>
					))}
				</div>
			) : isError ? (
				// This panel is the only place a job reports field spend, so a failed
				// fetch must not read as "nothing was bought".
				<div className="flex items-center gap-2 text-text-muted text-sm py-1">
					<TriangleAlert size={14} className="flex-shrink-0" aria-hidden="true" />
					<span>Couldn't load field purchases — this is not a statement that there are none</span>
				</div>
			) : rows.length === 0 ? (
				<div className="flex items-center gap-2 text-text-muted text-sm py-1">
					<Receipt size={14} className="flex-shrink-0" aria-hidden="true" />
					<span>No field purchases for {visitId ? "this visit" : "this job"}</span>
				</div>
			) : (
				<ul className="divide-y divide-border-subtle">
					{rows.map((p) => (
						<li key={p.id}>
							<Link
								to={purchaseHref(p.id, p.status)}
								className="-mx-2 flex items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 ease-out hover:bg-surface-raised"
							>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-sm text-text-primary">
										{p.vendor_name || "Vendor not recorded"}
										{p.kind === "refund" && (
											<span className="ml-1.5 text-xs text-text-muted">refund</span>
										)}
									</span>
									<span className="block truncate text-[11px] text-text-muted">
										{p.technician.name}
										{billedCount(p) > 0 && ` · ${billedCount(p)} billed to the visit`}
									</span>
								</span>
								<span className={`flex-shrink-0 text-xs font-medium ${statusTone(p.status)}`}>
									{FIELD_PURCHASE_STATUS_LABELS[p.status]}
								</span>
								{p.flags.length > 0 && (
									<span className="inline-flex flex-shrink-0 items-center gap-1 text-xs text-warning">
										<AlertTriangle aria-hidden size={11} />
										{p.flags.length}
									</span>
								)}
								<span className="w-20 flex-shrink-0 text-right text-sm tabular-nums text-text-primary">
									{money(shareOfJob(p, jobId))}
									{p.allocations.length > 1 && (
										<span className="block text-[10px] text-text-tertiary">
											of {money(p.total)}
										</span>
									)}
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
