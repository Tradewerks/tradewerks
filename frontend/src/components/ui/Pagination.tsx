import { ChevronLeft, ChevronRight } from "lucide-react";
import SegmentedToggle from "./SegmentedToggle";
import { pageList } from "./pageList";

interface PaginationProps {
	/** 1-indexed. */
	page: number;
	/** 0 shows every row on one page. */
	pageSize: number;
	total: number;
	onPageChange: (page: number) => void;
	onPageSizeChange?: (size: number) => void;
	/** Multiples of 12 fill whole rows in a 2/3/4/6-column card grid. */
	pageSizeOptions?: number[];
	allowAll?: boolean;
	className?: string;
}

const NAV_BTN =
	"inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";

/** Client-side pagination for in-memory lists. Server-paged reports use reports/ReportPagination. */
export default function Pagination({
	page,
	pageSize,
	total,
	onPageChange,
	onPageSizeChange,
	pageSizeOptions = [12, 24, 48],
	allowAll = true,
	className = "",
}: PaginationProps) {
	const showsAll = pageSize === 0 || pageSize >= total;
	const totalPages = showsAll ? 1 : Math.ceil(total / pageSize);
	const current = Math.min(Math.max(1, page), totalPages);
	const first = showsAll ? 1 : (current - 1) * pageSize + 1;
	const last = showsAll ? total : Math.min(current * pageSize, total);

	// Only sizes that actually split the list, then one option that shows everything.
	// Sizes ≥ total all render the same rows, so offering them is a no-op choice.
	const splitting = pageSizeOptions.filter((n) => n < total);
	const coversAll = allowAll ? 0 : pageSizeOptions.find((n) => n >= total);
	const sizeOptions = [
		...splitting.map((n) => ({ id: String(n), label: String(n) })),
		...(coversAll === undefined ? [] : [{ id: String(coversAll), label: coversAll === 0 ? "All" : String(coversAll) }]),
	];
	const showSizes = !!onPageSizeChange && splitting.length > 0;

	// One page and nothing to choose: the list itself already says everything.
	if (total === 0 || (totalPages === 1 && !showSizes)) return null;

	return (
		<nav
			aria-label="Pagination"
			className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-3 ${className}`}
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="text-sm tabular-nums text-text-tertiary">
					{showsAll ? `Showing all ${total}` : `Showing ${first}–${last} of ${total}`}
				</span>
				{showSizes && (
					<div className="flex items-center gap-2">
						<span className="text-xs text-text-tertiary" aria-hidden>
							Per page
						</span>
						<SegmentedToggle
							ariaLabel="Rows per page"
							size="md"
							value={showsAll && coversAll !== undefined ? String(coversAll) : String(pageSize)}
							onChange={(id) => onPageSizeChange?.(Number(id))}
							options={sizeOptions}
						/>
					</div>
				)}
			</div>

			{totalPages > 1 && (
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => onPageChange(current - 1)}
						disabled={current === 1}
						aria-label="Previous page"
						className={`${NAV_BTN} border border-border bg-surface text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40`}
					>
						<ChevronLeft size={16} aria-hidden />
					</button>
					{pageList(current, totalPages).map((p, i) =>
						p === "gap" ? (
							<span key={`gap-${i}`} aria-hidden className="px-1 text-sm text-text-muted">
								…
							</span>
						) : (
							<button
								key={p}
								type="button"
								onClick={() => onPageChange(p)}
								aria-current={p === current ? "page" : undefined}
								className={`${NAV_BTN} ${
									p === current
										? "bg-primary-hover text-on-primary"
										: "text-text-tertiary hover:bg-surface hover:text-text-primary"
								}`}
							>
								{p}
							</button>
						)
					)}
					<button
						type="button"
						onClick={() => onPageChange(current + 1)}
						disabled={current === totalPages}
						aria-label="Next page"
						className={`${NAV_BTN} border border-border bg-surface text-text-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40`}
					>
						<ChevronRight size={16} aria-hidden />
					</button>
				</div>
			)}
		</nav>
	);
}
