import { useId } from "react";
import { Link } from "react-router-dom";
import { Plus, Receipt, TriangleAlert } from "lucide-react";
import Card from "../ui/Card";
import { HEADER_BTN_SECONDARY, HEADER_BTN_SECONDARY_INERT } from "../ui/headerActions";
import { NO_PERMISSION } from "../lifecycle/actionBuilder";
import {
	InvoiceStatusColors,
	InvoiceStatusLabels,
	type Invoice,
	type InvoiceStatus,
} from "../../types/invoices";
import { formatCurrency, formatDate } from "../../util/util";

/**
 * Which entity's invoices these are. A union, not two optional ids: every
 * derivation below branches on it, and optionals would let a caller pass neither.
 */
export type LinkedInvoicesScope =
	| { kind: "visit"; visitId: string }
	| { kind: "job"; jobId: string };

interface LinkedInvoicesCardProps {
	invoices: Invoice[];
	isLoading: boolean;
	/** The query failed. Distinct from an empty list: nothing is known yet. */
	isError?: boolean;
	scope: LinkedInvoicesScope;
	/** The parent's line-item total — the denominator for the billing verdict. */
	scopeTotal: number;
	canCreate: boolean;
	onCreate: () => void;
	tz?: string;
}

/** Draft and Void invoices exist but commit nothing. */
const isCommitted = (invoice: Invoice) =>
	invoice.status !== "Draft" && invoice.status !== "Void";

/**
 * What one invoice bills to the parent, and whether that number is an explicit
 * billed amount or the invoice's own total standing in for one.
 *
 * The two joins count different things: `invoice_visit.billed_amount` is every
 * line sourced from that visit, while `invoice_job.billed_amount` covers the
 * job-direct lines only (`source_visit_id === null`), since visit-sourced lines
 * reach the job through its visits. A job's share is therefore job-direct plus
 * every linked visit of that job — the same basis as the job page's denominator.
 *
 * A null `invoice_job.billed_amount` with nothing billed through the visits
 * means traceability-only, not zero, so the invoice total stands in; a real
 * zero from the backend is left alone.
 */
function billingForScope(invoice: Invoice, scope: LinkedInvoicesScope) {
	if (scope.kind === "visit") {
		const billed = invoice.visits?.find(
			(v) => v.visit_id === scope.visitId
		)?.billed_amount;
		return billed != null
			? { amount: Number(billed), isBilled: true }
			: { amount: Number(invoice.total ?? 0), isBilled: false };
	}
	const jobBilled = invoice.jobs?.find(
		(j) => j.job_id === scope.jobId
	)?.billed_amount;
	const visitBilled = (invoice.visits ?? [])
		.filter((v) => v.visit.job.id === scope.jobId)
		.reduce((sum, v) => sum + Number(v.billed_amount ?? 0), 0);
	if (jobBilled == null && visitBilled === 0) {
		return { amount: Number(invoice.total ?? 0), isBilled: false };
	}
	return { amount: Number(jobBilled ?? 0) + visitBilled, isBilled: true };
}

type Verdict = {
	count: number;
	total: number;
	status: "fully-billed" | "partially-billed";
};

/** Null when nothing is committed yet — the summary row is omitted entirely. */
function deriveVerdict(
	invoices: Invoice[],
	scope: LinkedInvoicesScope,
	scopeTotal: number
): Verdict | null {
	const committed = invoices.filter(isCommitted);
	if (committed.length === 0) return null;
	const total = committed.reduce(
		(sum, inv) => sum + billingForScope(inv, scope).amount,
		0
	);
	return {
		count: committed.length,
		total,
		status:
			scopeTotal > 0 && total >= scopeTotal
				? "fully-billed"
				: "partially-billed",
	};
}

export default function LinkedInvoicesCard({
	invoices,
	isLoading,
	isError,
	scope,
	scopeTotal,
	canCreate,
	onCreate,
	tz,
}: LinkedInvoicesCardProps) {
	const reasonId = useId();
	const scopeWord = scope.kind === "visit" ? "this visit" : "this job";
	const verdict = deriveVerdict(invoices, scope, scopeTotal);

	// Always rendered, never hidden. `aria-disabled` rather than `disabled`,
	// because a disabled control isn't focusable and its reason unreachable.
	const headerAction = (
		<>
			<button
				type="button"
				onClick={() => {
					if (canCreate) onCreate();
				}}
				aria-disabled={!canCreate}
				aria-describedby={canCreate ? undefined : reasonId}
				className={canCreate ? HEADER_BTN_SECONDARY : HEADER_BTN_SECONDARY_INERT}
			>
				<Plus size={13} aria-hidden="true" />
				Create Invoice
			</button>
			{!canCreate && (
				<span id={reasonId} className="sr-only">
					{NO_PERMISSION}
				</span>
			)}
		</>
	);

	return (
		<Card title="Linked Invoices" headerAction={headerAction}>
			{/* Whether this entity is billed is the question the tab exists to
			    answer, so it leads the card rather than captioning the list. */}
			{verdict && (
				<div className="mb-3 pb-3 border-b border-border-subtle flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<span
						className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
							verdict.status === "fully-billed"
								? "bg-success-bg text-success-text border-success-border"
								: "bg-warning-bg text-warning-text border-warning-border"
						}`}
					>
						{verdict.status === "fully-billed"
							? "Fully Billed"
							: "Partially Billed"}
					</span>
					<span className="text-text-primary text-sm font-medium tabular-nums">
						{formatCurrency(verdict.total)}
					</span>
					<span className="text-text-tertiary text-xs">
						committed on {verdict.count} invoice
						{verdict.count !== 1 ? "s" : ""}
					</span>
				</div>
			)}

			{isLoading ? (
				<div aria-busy="true">
					<span className="sr-only">
						Loading linked invoices
					</span>
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="flex items-center gap-3 py-2"
							aria-hidden="true"
						>
							<div className="w-24 h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
							<div className="w-[86px] h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
							<div className="flex-1 hidden sm:block h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
							<div className="w-24 ml-auto h-4 rounded bg-surface-raised animate-pulse motion-reduce:animate-none" />
						</div>
					))}
				</div>
			) : isError ? (
				/* Ahead of the empty state: a failed fetch knows nothing
				   about this entity's billing, so "No invoices linked"
				   would assert what the card cannot answer. */
				<div className="flex items-center gap-2 text-text-muted text-sm py-1">
					<TriangleAlert
						size={14}
						className="flex-shrink-0"
						aria-hidden="true"
					/>
					<span>Couldn't load linked invoices</span>
				</div>
			) : invoices.length === 0 ? (
				<div className="flex items-center gap-2 text-text-muted text-sm py-1">
					<Receipt
						size={14}
						className="flex-shrink-0"
						aria-hidden="true"
					/>
					<span>No invoices linked to {scopeWord}</span>
				</div>
			) : (
				/* Fixed column widths, not a grid: each row is its own link, a
				   shared grid can't align across separate flex boxes, and an
				   anchor with `display: contents` loses its hover box. */
				<div>
					{/* Decoration: each row names its own columns in its
					    aria-label, so these spans would be orphans. */}
					<div
						aria-hidden="true"
						className="flex items-center gap-3 pb-2 text-[10px] uppercase tracking-wide font-semibold text-text-tertiary"
					>
						<span className="w-24 shrink-0">Invoice</span>
						<span className="w-[86px] shrink-0">Status</span>
						<span className="flex-1 hidden sm:block">
							Issued
						</span>
						<span className="w-24 shrink-0 ml-auto text-right">
							Amount
						</span>
					</div>
					<ul className="divide-y divide-border-subtle">
						{invoices.map((invoice) => {
							const { amount, isBilled } =
								billingForScope(
									invoice,
									scope
								);
							const statusLabel =
								InvoiceStatusLabels[
									invoice.status as InvoiceStatus
								] ?? invoice.status;
							const issued = invoice.issue_date
								? `created ${formatDate(invoice.issue_date, tz)}`
								: "not yet created";
							const amountPhrase = isBilled
								? `${formatCurrency(amount)} billed ${scopeWord}`
								: `${formatCurrency(amount)} invoice total`;
							return (
								<li key={invoice.id}>
									<Link
										to={`/dispatch/invoices/${invoice.id}`}
										aria-label={`Invoice ${invoice.invoice_number}, ${statusLabel}, ${issued}, ${amountPhrase}`}
										/* px-2/-mx-2: the hover fill breathes
										   past its text while the negative
										   margin keeps the columns and the
										   divide-y rules where they were. */
										className="group -mx-2 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors duration-150 ease-out hover:bg-surface-raised"
									>
										<span className="w-24 shrink-0 truncate text-text-primary font-semibold text-sm group-hover:text-primary-text transition-colors duration-150 ease-out tabular-nums">
											{
												invoice.invoice_number
											}
										</span>
										<span
											className={`min-w-[86px] shrink-0 truncate inline-flex items-center justify-center px-2 py-0.5 rounded text-xs font-medium border ${
												InvoiceStatusColors[
													invoice.status as InvoiceStatus
												] ??
												"bg-surface-raised text-text-tertiary border-border-strong"
											}`}
										>
											{statusLabel}
										</span>
										{/* First column to go when the card
										    is narrow: the amount and who it
										    belongs to outrank when it was
										    issued. */}
										<span className="flex-1 hidden sm:block text-xs text-text-tertiary">
											{invoice.issue_date
												? formatDate(
														invoice.issue_date,
														tz
													)
												: "—"}
										</span>
										<span className="w-24 shrink-0 ml-auto text-right text-text-primary font-semibold text-sm tabular-nums">
											{formatCurrency(
												amount
											)}
											{!isBilled && (
												<span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
													total
												</span>
											)}
										</span>
									</Link>
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</Card>
	);
}
