import { Fragment } from "react";
import { formatStat, STAT_DESCRIPTIONS } from "./pageSummaryFormat";
import type { PageReportState } from "./usePageReport";

const Dot = () => <span aria-hidden className="text-text-faint">·</span>;

// Current-state numbers only; the popover's date range never reaches the header.
export default function PageReportKpis({ report }: { report: PageReportState }) {
	const { canView, snapshot, page, label, open, setOpen } = report;
	if (!canView || snapshot.error) return null;

	const stats = snapshot.data?.stats;

	return (
		<button
			type="button"
			onClick={() => setOpen(true)}
			aria-label={`Open ${label}`}
			aria-haspopup="dialog"
			aria-expanded={open}
			className="group flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left text-sm"
		>
			{stats ? (
				stats.map((stat, i) => {
					const description = STAT_DESCRIPTIONS[page]?.[stat.label];
					const title = [description, stat.note].filter(Boolean).join("\n") || undefined;
					return (
						<Fragment key={stat.label}>
							{i > 0 && <Dot />}
							<span title={title} className="whitespace-nowrap">
								<span className="font-medium tabular-nums text-text-secondary transition-colors duration-150 group-hover:text-text-primary">
									{formatStat(stat.value, stat.format, { compact: true })}
								</span>{" "}
								<span className="text-text-faint">{stat.label}</span>
							</span>
						</Fragment>
					);
				})
			) : (
				<span aria-busy="true" className="h-3.5 w-48 self-center animate-pulse rounded bg-surface-raised" />
			)}
		</button>
	);
}
