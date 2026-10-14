import { AlertCircle } from "lucide-react";
import { useRevenueYTDQuery } from "../../../hooks/useReports";
import RevenueYTDChart from "../../reports/RevenueYTDChart";

export default function RevenueYTDWidget() {
	const { data, isLoading, error } = useRevenueYTDQuery();

	if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load revenue data</p>
		</div>
	);

	if (isLoading || !data) return <div className="bg-base border border-border-subtle rounded-xl h-full animate-pulse" />;

	return <div className="h-full"><RevenueYTDChart data={data.data} total={data.total} year={data.year} /></div>;
}
