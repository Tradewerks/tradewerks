import { useMemo } from "react";
import { startOfMonth, endOfMonth } from "date-fns";
import { AlertCircle } from "lucide-react";
import { useLeadsBySourceQuery } from "../../../hooks/useReports";
import LeadsBySourceChart from "../../reports/LeadsBySourceChart";

interface LeadsBySourceWidgetProps {
	startDate?: string;
	endDate?: string;
}

export default function LeadsBySourceWidget({ startDate, endDate }: LeadsBySourceWidgetProps = {}) {
	const now = useMemo(() => new Date(), []);
	const defaultStart = useMemo(() => startOfMonth(now).toISOString(), [now]);
	const defaultEnd   = useMemo(() => endOfMonth(now).toISOString(),   [now]);
	const start = startDate ?? defaultStart;
	const end   = endDate ?? defaultEnd;

	const { data, isLoading, error } = useLeadsBySourceQuery(start, end);

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load leads by source</p>
		</div>
	);

	if (isLoading || !data) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return <div className="h-full"><LeadsBySourceChart data={data.data} total={data.total} /></div>;
}
