import { useMemo } from "react";
import { startOfMonth, endOfMonth } from "date-fns";
import { AlertCircle } from "lucide-react";
import { useRevenueByJobTypeQuery } from "../../../hooks/useReports";
import RevenueByJobTypeChart from "../../reports/RevenueByJobTypeChart";

interface RevenueByJobTypeWidgetProps {
	startDate?: string;
	endDate?: string;
}

export default function RevenueByJobTypeWidget({ startDate, endDate }: RevenueByJobTypeWidgetProps = {}) {
	const now = useMemo(() => new Date(), []);
	const defaultStart = useMemo(() => startOfMonth(now).toISOString(), [now]);
	const defaultEnd   = useMemo(() => endOfMonth(now).toISOString(),   [now]);
	const start = startDate ?? defaultStart;
	const end   = endDate ?? defaultEnd;

	const { data, isLoading, error } = useRevenueByJobTypeQuery(start, end);

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load revenue by job type</p>
		</div>
	);

	if (isLoading || !data) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return <div className="h-full"><RevenueByJobTypeChart data={data.data} total={data.total} /></div>;
}
