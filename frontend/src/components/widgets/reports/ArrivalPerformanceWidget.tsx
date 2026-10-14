import { useMemo } from "react";
import { startOfMonth, endOfMonth, format } from "date-fns";
import { AlertCircle } from "lucide-react";
import { useArrivalPerformanceQuery } from "../../../hooks/useReports";
import ArrivalPerformanceChart from "../../reports/ArrivalPerformanceChart";

interface ArrivalPerformanceWidgetProps {
	startDate?: string;
	endDate?: string;
}

export default function ArrivalPerformanceWidget({ startDate, endDate }: ArrivalPerformanceWidgetProps = {}) {
	const now = useMemo(() => new Date(), []);
	const defaultStart = useMemo(() => startOfMonth(now).toISOString(), [now]);
	const defaultEnd   = useMemo(() => endOfMonth(now).toISOString(),   [now]);
	const start = startDate ?? defaultStart;
	const end   = endDate ?? defaultEnd;
	const rangeLabel = useMemo(
		() => `${format(new Date(start), "MMM d, yyyy")} - ${format(new Date(end), "MMM d, yyyy")}`,
		[start, end]
	);

	const { data, isLoading, error } = useArrivalPerformanceQuery(start, end);

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load arrival performance</p>
		</div>
	);

	if (isLoading || !data) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return <div className="h-full"><ArrivalPerformanceChart data={data} rangeLabel={rangeLabel} /></div>;
}
