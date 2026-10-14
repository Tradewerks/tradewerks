import { Link } from "react-router-dom";
import { formatCurrency } from "../../util/util";
import { disputeAgeDays, openDisputePath, STALE_AFTER_DAYS } from "./openDisputeFormat";
import type { OpenDisputeSummary } from "../../types/disputes";

export const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-4 py-2";

interface OpenDisputeRowProps {
	dispute: OpenDisputeSummary;
	/** "document" is for surfaces already scoped to one client. */
	lead: "client" | "document";
	className?: string;
}

export default function OpenDisputeRow({ dispute: d, lead, className = "" }: OpenDisputeRowProps) {
	const age = disputeAgeDays(d.opened_at);
	const stale = age >= STALE_AFTER_DAYS;
	const days = `${age} ${age === 1 ? "day" : "days"}`;
	const amountLabel = d.kind === "invoice" ? "balance" : "quote total";
	const client = d.client?.name ?? "No client";
	const opener = d.opened_by ? ` by ${d.opened_by.name}` : "";
	const label = `${d.kind} ${d.document_number}, ${formatCurrency(d.amount)} ${amountLabel}, open ${days}`;

	return (
		<li className={`@container ${className}`}>
			<Link
				to={openDisputePath(d)}
				aria-label={lead === "client" ? `${client}, ${label}` : `${label}${opener}`}
				className={`${ROW_GRID} hover:bg-surface/40 focus-visible:outline-none focus-visible:bg-surface/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
			>
				<span className="truncate text-sm font-medium text-text-primary">
					{lead === "client" ? client : <span className="tabular-nums">{d.document_number}</span>}
				</span>
				<span className="text-right text-sm tabular-nums text-text-primary">
					{/* The number prefix already says which kind; the caption is a wide-cell nicety. */}
					<span className="mr-1.5 hidden text-xs text-text-muted @sm:inline">{amountLabel}</span>
					{formatCurrency(d.amount)}
				</span>

				<span className="flex min-w-0 items-baseline gap-2 text-xs">
					{lead === "client" && (
						<span className="shrink-0 tabular-nums text-text-secondary">{d.document_number}</span>
					)}
					<span className="truncate text-text-muted">{d.reason}</span>
				</span>
				<span className="flex items-center justify-end gap-1.5">
					<AgeMeter days={age} />
					<span
						title={`Opened ${days} ago${opener}`}
						className={`min-w-[1.75rem] text-right text-xs tabular-nums ${stale ? "font-medium text-warning-text" : "text-text-muted"}`}
					>
						{age}d
					</span>
				</span>
			</Link>
		</li>
	);
}

/** One tick per day up to the stale line, so the column reads as distance to it. */
function AgeMeter({ days }: { days: number }) {
	const filled = Math.min(days, STALE_AFTER_DAYS);
	const stale = days >= STALE_AFTER_DAYS;
	return (
		<span className="flex gap-px" aria-hidden="true" data-testid="age-meter">
			{Array.from({ length: STALE_AFTER_DAYS }, (_, i) => (
				<span
					key={i}
					className={`h-1.5 w-1 rounded-[1px] ${
						i < filled ? (stale ? "bg-warning" : "bg-text-faint") : "bg-border-subtle"
					}`}
				/>
			))}
		</span>
	);
}
