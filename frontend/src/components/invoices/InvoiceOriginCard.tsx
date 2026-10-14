import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Briefcase, FileText, Inbox, MapPin, Repeat } from "lucide-react";
import Card from "../ui/Card";
import type { Invoice } from "../../types/invoices";
import { RecurringPlanStatusColors, RecurringPlanStatusLabels } from "../../types/recurringPlans";
import { QuoteStatusColors, QuoteStatusLabels } from "../../types/quotes";
import { RequestStatusColors, RequestStatusLabels } from "../../types/requests";
import { getGenericStatusColor } from "../../types/common";
import { formatCurrency, formatDate } from "../../util/util";
import { buildLinkedJobGroups, jobRoute, upstreamOf, visitRoute } from "./invoiceSources";

interface InvoiceOriginCardProps {
	invoice: Invoice;
}

const STATUS_PILL =
	"inline-flex flex-shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap";

const GROUP_LABEL = "mb-1.5 text-[11px] font-semibold text-text-tertiary";

/**
 * One record: what it is, what it is called, what it came to, where it stands.
 * The four zones are fixed so the figures read down a single edge.
 */
function OriginRow({
	to,
	icon,
	label,
	title,
	meta,
	amount,
	status,
	nested = false,
}: {
	to: string;
	icon?: ReactNode;
	/** "Quote", "Visit" — what kind of record this is. */
	label?: string;
	title: string;
	meta?: string;
	amount?: number | null;
	status?: { label: string; className: string };
	/** A visit under its job. */
	nested?: boolean;
}) {
	return (
		<Link
			to={to}
			className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-surface"
		>
			{/* Indent as a spacer INSIDE the row, not margin on it: a margin
			    would carry the amount and status columns left with it, and
			    those columns exist to hold one edge. */}
			{nested && <span aria-hidden className="w-4 flex-shrink-0" />}
			{icon && (
				<span className="flex-shrink-0 text-text-muted transition-colors duration-150 ease-out group-hover:text-primary-text">
					{icon}
				</span>
			)}
			{label && (
				<span className="hidden w-14 flex-shrink-0 text-[11px] text-text-faint sm:inline">
					{label}
				</span>
			)}
			<span className="flex min-w-0 flex-1 items-baseline gap-2">
				<span
					className="min-w-0 truncate text-sm font-medium text-text-primary transition-colors duration-150 ease-out group-hover:text-primary-text"
					title={title}
				>
					{title}
				</span>
				{meta && (
					<span className="hidden flex-shrink-0 text-xs text-text-muted sm:inline">
						{meta}
					</span>
				)}
			</span>
			{/* Held open whether or not the row fills it: a status pill on one
			    row must not shunt the amount above it out of line. */}
			<span className="w-20 flex-shrink-0 text-right text-sm tabular-nums text-text-secondary sm:w-24">
				{/* Zero is the absence of an amount, not an amount: a job whose
				    lines all arrived through its visits bills 0 at the job
				    level, and "$0.00" beside a visit billing $1,090 reads as
				    work done for free. */}
				{amount ? formatCurrency(amount) : ""}
			</span>
			<span className="hidden w-[5.5rem] flex-shrink-0 justify-end sm:flex">
				{status && (
					<span className={`${STATUS_PILL} ${status.className}`}>
						{status.label}
					</span>
				)}
			</span>
		</Link>
	);
}

/**
 * Where this invoice came from: the documents that produced it, and the work it
 * bills. Two groups, not one list — "what was agreed" and "what was done" are
 * different questions. Visits nest under their job behind one continuous rule,
 * drawn as a single element so there is no joint to misalign.
 */
export default function InvoiceOriginCard({ invoice }: InvoiceOriginCardProps) {
	const groups = buildLinkedJobGroups(invoice);
	const { quotes, requests, plan } = upstreamOf(invoice);

	const hasUpstream = requests.length > 0 || quotes.length > 0 || plan != null;
	const hasWork = groups.length > 0;

	if (!hasUpstream && !hasWork) {
		return (
			<Card title="Origin">
				<p className="text-sm text-text-faint">
					Created manually — not linked to a job, visit or recurring plan.
				</p>
			</Card>
		);
	}

	return (
		<Card title="Origin">
			{hasUpstream && (
				<div>
					{/* Named only when the second group follows it; alone, the
					    card title already says what these are. */}
					{hasWork && <p className={GROUP_LABEL}>From</p>}
					<div className="-mx-2">
						{requests.map((request) => (
							<OriginRow
								key={request.id}
								to={`/dispatch/requests/${request.id}`}
								icon={<Inbox size={14} />}
								label="Request"
								title={request.title}
								meta={formatDate(request.created_at)}
								status={{
									label:
										RequestStatusLabels[
											request.status as keyof typeof RequestStatusLabels
										] ?? request.status,
									className:
										RequestStatusColors[
											request.status as keyof typeof RequestStatusColors
										] ||
										getGenericStatusColor(request.status),
								}}
							/>
						))}
						{quotes.map((quote) => (
							<OriginRow
								key={quote.id}
								to={`/dispatch/quotes/${quote.id}`}
								icon={<FileText size={14} />}
								label="Quote"
								title={`${quote.quote_number} · ${quote.title}`}
								amount={Number(quote.total)}
								status={{
									label:
										QuoteStatusLabels[
											quote.status as keyof typeof QuoteStatusLabels
										] ?? quote.status,
									className:
										QuoteStatusColors[
											quote.status as keyof typeof QuoteStatusColors
										] || getGenericStatusColor(quote.status),
								}}
							/>
						))}
						{plan && (
							<OriginRow
								to={`/dispatch/recurring-plans/${plan.id}`}
								icon={<Repeat size={14} />}
								label="Plan"
								title={plan.name}
								status={{
									label:
										RecurringPlanStatusLabels[
											plan.status as keyof typeof RecurringPlanStatusLabels
										] ?? plan.status,
									className:
										RecurringPlanStatusColors[
											plan.status as keyof typeof RecurringPlanStatusColors
										] || getGenericStatusColor(plan.status),
								}}
							/>
						)}
					</div>
				</div>
			)}

			{hasWork && (
				<div className={hasUpstream ? "mt-3 border-t border-border-subtle pt-3" : ""}>
					{hasUpstream && <p className={GROUP_LABEL}>Billed work</p>}
					<div className="-mx-2 flex flex-col gap-1">
						{groups.map((group) => (
							<div key={group.jobId}>
								<OriginRow
									to={jobRoute(group.jobId)}
									icon={<Briefcase size={14} />}
									label="Job"
									title={`${group.jobNumber} · ${group.jobName}`}
									amount={group.billedAmount}
								/>
								{group.visits.map((visit) => (
									<OriginRow
										key={visit.visitId}
										to={visitRoute(
											visit.jobId,
											visit.visitId
										)}
										icon={<MapPin size={14} />}
										label="Visit"
										title={formatDate(
											visit.scheduledStartAt
										)}
										amount={visit.billedAmount}
										nested
									/>
								))}
							</div>
						))}
					</div>
				</div>
			)}
		</Card>
	);
}
