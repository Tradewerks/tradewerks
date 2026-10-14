import { Fragment } from "react";
import { Link } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import Card from "../ui/Card";
import { useOpenDisputesQuery } from "../../hooks/useDisputes";
import OpenDisputeRow, { ROW_GRID } from "../disputes/OpenDisputeRow";
import type { DisputeKind, OpenDisputeList } from "../../types/disputes";

export default function OpenDisputesWidget() {
	const { data, isLoading, isError, refetch } = useOpenDisputesQuery();

	return (
		<Card
			title="Open Disputes"
			className="h-full pb-3"
			headerAction={data && data.total > 0 ? <KindLinks counts={data.counts} /> : undefined}
		>
			{isLoading ? (
				<RowsSkeleton />
			) : isError ? (
				<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-lg">
					<AlertCircle size={14} className="text-error-text shrink-0" />
					<p className="text-xs text-error-text">Failed to load disputes</p>
					<button
						type="button"
						onClick={() => refetch()}
						className="ml-auto text-xs font-medium text-error-text hover:underline"
					>
						Retry
					</button>
				</div>
			) : !data || data.total === 0 ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center gap-1 py-4">
					<p className="text-sm text-text-tertiary">No open disputes</p>
					<p className="text-xs text-text-muted">
						When a customer disputes a quote or invoice, it lands here.
					</p>
				</div>
			) : (
				<DisputeLedger data={data} />
			)}
		</Card>
	);
}

const KIND_LINKS: Array<{ kind: DisputeKind; path: string; one: string; many: string }> = [
	{ kind: "quote", path: "/dispatch/quotes?status=Disputed", one: "quote", many: "quotes" },
	{ kind: "invoice", path: "/dispatch/invoices?status=Disputed", one: "invoice", many: "invoices" },
];

function KindLinks({ counts }: { counts: OpenDisputeList["counts"] }) {
	const links = KIND_LINKS.filter((l) => counts[l.kind] > 0);
	return (
		<div className="flex items-center gap-1 -my-1 -mr-2">
			{links.map((l, i) => {
				const n = counts[l.kind];
				const noun = n === 1 ? l.one : l.many;
				return (
					<Fragment key={l.kind}>
						{i > 0 && <span className="w-px h-3 bg-border-subtle" aria-hidden="true" />}
						<Link
							to={l.path}
							title={`View disputed ${l.many}`}
							className="px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
						>
							<span className="font-semibold tabular-nums text-text-primary">{n}</span> {noun}
						</Link>
					</Fragment>
				);
			})}
		</div>
	);
}

/** Actionable first; the API's oldest-first order is kept inside each group. */
function DisputeLedger({ data }: { data: OpenDisputeList }) {
	const groups = [
		{ label: "You can resolve", items: data.items.filter((d) => d.can_resolve) },
		{ label: "Needs a resolver", items: data.items.filter((d) => !d.can_resolve) },
	].filter((g) => g.items.length > 0);
	const capped = data.total > data.items.length;

	return (
		// Scrolls itself: the dashboard auto-grows any widget whose Card body overflows.
		<div className="@container -mx-4 -my-4 flex-1 min-h-0 overflow-y-auto">
			{groups.map((g) => (
				<section key={g.label} aria-label={g.label}>
					<h4 className="sticky top-0 z-10 flex items-baseline justify-between px-4 py-1.5 bg-base border-b border-border-subtle text-xs font-medium text-text-tertiary">
						{g.label}
						<span className="tabular-nums text-text-muted">{g.items.length}</span>
					</h4>
					<ul className="divide-y divide-border-subtle">
						{g.items.map((d) => (
							<OpenDisputeRow key={d.dispute_id} dispute={d} lead="client" />
						))}
					</ul>
				</section>
			))}
			{capped && (
				<p className="px-4 py-2 border-t border-border-subtle text-xs text-text-muted">
					Showing the oldest {data.items.length} of {data.total}.
				</p>
			)}
		</div>
	);
}

function RowsSkeleton() {
	return (
		<div className="-mx-4 -my-4 divide-y divide-border-subtle" aria-hidden="true">
			{Array.from({ length: 3 }).map((_, i) => (
				<div key={i} className={ROW_GRID}>
					<div className="h-3.5 w-2/3 rounded bg-surface-raised animate-pulse" />
					<div className="h-3.5 w-16 rounded bg-surface-raised animate-pulse" />
					<div className="h-2.5 w-1/2 rounded bg-surface-raised animate-pulse" />
					<div className="h-2.5 w-14 justify-self-end rounded bg-surface-raised animate-pulse" />
				</div>
			))}
		</div>
	);
}
