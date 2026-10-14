import { useMemo } from "react";
import { useContainerWidth } from "react-grid-layout";
import { startOfMonth, endOfMonth } from "date-fns";
import { AlertCircle } from "lucide-react";
import { useOverviewQuery } from "../../../hooks/useReports";
import Card from "../../ui/Card";
import OverviewSection from "../../reports/OverviewSection";

interface OverviewWidgetProps {
	startDate?: string;
	endDate?: string;
}

export default function OverviewWidget({ startDate, endDate }: OverviewWidgetProps = {}) {
	const { containerRef, width } = useContainerWidth();
	const now = useMemo(() => new Date(), []);
	const defaultStart = useMemo(() => startOfMonth(now).toISOString(), [now]);
	const defaultEnd   = useMemo(() => endOfMonth(now).toISOString(),   [now]);
	const start = startDate ?? defaultStart;
	const end   = endDate ?? defaultEnd;

	const { data, isLoading, error } = useOverviewQuery(start, end);

	// Skeleton col count driven by widget width, not viewport
	const skeletonCols = width < 500 ? "grid-cols-2" : "grid-cols-4";

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load overview</p>
		</div>
	);

	if (isLoading || !data) return (
		<Card className="h-full" title="Overview" scrollable>
			<div ref={containerRef} className={`grid ${skeletonCols} gap-3 h-full`}>
				{Array.from({ length: 4 }).map((_, i) => (
					<div key={i} className="bg-base border border-border-subtle rounded-lg p-4 animate-pulse" />
				))}
			</div>
		</Card>
	);

	return (
		<Card className="h-full" scrollable>
			<div ref={containerRef} className="flex-1 flex items-center w-full">
				<OverviewSection data={data} showComparison={true} />
			</div>
		</Card>
	);
}
