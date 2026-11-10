import { useMemo } from "react";
import { subDays } from "date-fns";
import { AlertCircle, LoaderCircle, Triangle } from "lucide-react";
import { Link } from "react-router-dom";
import { useFirstTimeFixQuery } from "../../../hooks/useReports";
import type { FirstTimeFixSummary } from "../../../types/reports";
import Card from "../../ui/Card";
import { formatDate } from "../../../util/util";

interface FirstTimeFixRateWidgetProps {
	startDate?: string;
	endDate?: string;
}

export default function FirstTimeFixRateWidget ({ startDate, endDate}: FirstTimeFixRateWidgetProps) {


    // Memoized so the default range doesn't change the query key every render
    const { start, end, prevStart } = useMemo(() => {
        const e = endDate ?? new Date().toISOString();
        const s = startDate ?? subDays(new Date(e), 30).toISOString();
        return { start: s, end: e, prevStart: new Date(2 * +new Date(s) - +new Date(e)).toISOString() };
    }, [startDate, endDate]);
    const current = useFirstTimeFixQuery({ startDate: start, endDate: end, limit: 1 });
    const prev = useFirstTimeFixQuery({ startDate: prevStart, endDate: start, limit: 1 });
    
    const s = current.data?.summary as FirstTimeFixSummary | undefined;  // ftfrPercent, firstTimeFix, repeatVisit, completedJobs
    const p = prev.data?.summary as FirstTimeFixSummary | undefined;
    const delta = s && p && p.completedJobs > 0 ? Math.round(s.ftfrPercent) - Math.round(p.ftfrPercent) : null;
    const percent = s?.completedJobs ? (s.firstTimeFix / s.completedJobs) * 100 : 0;

    if (current.error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load First Time Fix Rate</p>
		</div>
	);

    return (
        <Card
            title="First Time Fix Rate"
            headerAction={(
                <p className="text-text-muted" >{formatDate(start)} - {formatDate(end)}</p>
            )}
            className="h-full"
        >
            {current.isLoading ? (
                <LoaderCircle size={14} className="animate-spin text-text-muted"/>
            ) : s ? (
                <div className="flex flex-1 flex-col">
                    <div className="flex flex-1 flex-col justify-center">
                    <div>
                        <span className="flex flex-wrap items-end mb-2 gap-x-4 gap-y-1">
                            <h2 className="text-7xl">
                                {Math.round(s.ftfrPercent)}%
                            </h2>
                            {delta !== null && delta !== 0 && (
                                <p className={`${delta > 0 ? "bg-success/40 text-green-500" : "bg-error/40 text-red-500"} h-fit font-bold w-fit flex rounded-xl px-2`}>
                                    <Triangle size={12} className={`${delta > 0 ? "fill-green-500" : "fill-red-500 rotate-180"} mt-2 mr-1 `}/> 
                                    {Math.abs(delta)} pts
                                </p>
                            )}
                        </span>
                        {p && <p className="text-text-muted"> vs {Math.round(p.ftfrPercent)}% previous period</p>}
                    </div>
                    <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-inset">
                        <div style={{ width: `${percent}%`}}
                            className="bg-success"
                        />
                        <div style={{ width: `${100-percent}%`}} 
                            className="bg-warning"
                        />
                    </div>
                    <div className="mt-2 flex w-full flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-text-secondary">
                        <span className="flex items-center gap-1.5">
                            <span className="size-2 shrink-0 rounded-sm bg-success" />
                            {s.firstTimeFix} fixed first visit
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="size-2 shrink-0 rounded-sm bg-warning" />
                            {s.repeatVisit} needed a return
                        </span>
                    </div>
                    </div>
                    <div className="-mx-4 -mb-4 flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-2.5 text-xs whitespace-nowrap">
                        <span className="text-text-muted">{s.completedJobs} completed job{s.completedJobs !== 1 ? "s" : ""}</span>
                        <Link to="/dispatch/reporting/first-time-fix" className="font-semibold text-primary hover:underline">
                            Report →
                        </Link>
                    </div>
                </div>
            ) : (
                <p></p>
            )}
        </Card>
    )
}