import { AlertCircle } from "lucide-react";
import { useAgedReceivablesQuery } from "../../../hooks/useReports";
import AgedReceivablesColumnChart from "../../reports/AgedReceivablesColumnChart";

export default function AgedReceivablesColumnWidget() {
	const { data, isLoading, error } = useAgedReceivablesQuery();

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load aged receivables</p>
		</div>
	);

	if (isLoading || !data) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return <div className="h-full"><AgedReceivablesColumnChart data={data} /></div>;
}
