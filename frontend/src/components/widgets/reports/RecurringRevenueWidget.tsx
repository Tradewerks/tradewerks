import { useMemo } from "react";
import { useRecurringRevenueQuery } from "../../../hooks/useReports";
import { format, parse, subDays } from "date-fns";
import type { RecurringRevenueSummary } from "../../../types/reports";
import Card from "../../ui/Card";
import { formatCurrency } from "../../../util/util";
import { AlertCircle, LoaderCircle, Triangle } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Link } from "react-router-dom";

interface RecurringRevenueProps {
	startDate?: string;
	endDate?: string;
}

// "2026-09" → "Sep"; parsed as local time, new Date() would read it as UTC
const monthLabel = (key?: string, fmt = "MMM") => (key ? format(parse(key, "yyyy-MM", new Date()), fmt) : "");

interface ChartPoint {
	month: string;
	full: number | null;
	partial: number | null;
}

// Same look as the report page's TrendTooltip; the shared month is in both series, so show it once
function TrendTooltip({ active, payload }: { active?: boolean; payload?: { payload: ChartPoint }[] }) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;
	return (
		<div className="rounded-lg px-3 py-2 bg-base/90 backdrop-blur-md shadow-lg border border-border-subtle">
			<p className="text-xs text-text-tertiary">{monthLabel(d.month, "MMM yyyy")}</p>
			<p className="text-sm font-semibold text-primary">{formatCurrency(d.full ?? d.partial ?? 0)}</p>
		</div>
	);
}

export default function RecurringRevenueWidget ({ startDate, endDate}: RecurringRevenueProps) {
    const { start, end } = useMemo(() => {
        const e = endDate ?? new Date().toISOString();
        const s = startDate ?? subDays(new Date(e), 30).toISOString();
        return { start: s, end: e };
    }, [startDate, endDate]);
    const { data, isLoading, error } = useRecurringRevenueQuery({ startDate: start, endDate: end, limit: 1 });

    const s = data?.summary as RecurringRevenueSummary | undefined;
    const last = s?.trend.at(-2)?.revenue ?? 0;   
    const prior = s?.trend.at(-3)?.revenue ?? 0; 
    const delta = prior > 0 ? Math.round(((last - prior) / prior) * 100) : null;

    const chart = useMemo(() => {
        const t = s?.trend ?? [];
        return t.map((p, i) => ({
            month: p.month,
            full: i < t.length -1 ? p.revenue : null,
            partial: i >= t.length - 2 ? p.revenue : null
        }))
    }, [s]);

    if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load Recurring Revenue</p>
		</div>
	);

    return (
        <Card
            title="Recurring Revenue"
            headerAction={(
                <p className="text-text-muted" >as of today</p>
            )}
            className="h-full"
        >   
        {isLoading ? (
            <LoaderCircle size={14} className="animate-spin text-text-muted"/>
        ) : s ? (
            <div className="flex flex-1 flex-col">
                <div className="flex flex-1 flex-col justify-center">
                <span className="flex flex-wrap items-end mb-2 gap-x-4 gap-y-1">
                    <h2 className="text-5xl">
                        {formatCurrency(s.mrr)}
                    </h2>
                    <p className="text-text-muted">/mo</p>
                    {delta !== null && delta !== 0 && (
                        <p className={`${delta > 0 ? "bg-success/40 text-green-500" : "bg-error/40 text-red-500"} h-fit font-bold w-fit flex rounded-xl px-2`}>
                            <Triangle size={12} className={`${delta > 0 ? "fill-green-500" : "fill-red-500 rotate-180"} mt-2 mr-1 `}/> 
                            {Math.abs(delta)} %
                        </p>
                    )}
                </span>
                <p className="text-text-muted" >
                    {formatCurrency(s.arr)} ARR
                    {delta !== null && delta !== 0 && (
                        <> · {monthLabel(s.trend.at(-2)?.month)} vs {monthLabel(s.trend.at(-3)?.month)}</>
                    )}
                </p>
                <div className="h-16 mt-3">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                        <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                            <defs>
                                <linearGradient id="recurringRevenueWidgetFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0%" stopColor="var(--color-chart-primary)" stopOpacity={0.35} />
                                    <stop offset="100%" stopColor="var(--color-chart-primary)" stopOpacity={0.02} />
                                </linearGradient>
                            </defs>
                            <XAxis dataKey="month" hide />
                            <Tooltip content={<TrendTooltip />} cursor={{ stroke: "var(--color-chart-axis)" }} />
                            <Area type="monotone" dataKey="full" stroke="var(--color-chart-primary)" strokeWidth={2} fill="url(#recurringRevenueWidgetFill)" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                            <Area type="monotone" dataKey="partial" stroke="var(--color-chart-primary)" strokeWidth={2} strokeDasharray="4 4" fill="url(#recurringRevenueWidgetFill)" dot={false} activeDot={false} isAnimationActive={false} />
                        </AreaChart>
                    </ResponsiveContainer>
                </div>
                <div className="flex justify-between text-xs text-text-muted">
                    <span>{monthLabel(s.trend[0]?.month)}</span>
                    <span>{monthLabel(s.trend.at(-1)?.month)} (so far)</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-surface-inset px-3 py-2" title="Plans with a start date in the last 30 days, whatever the date range">
                        <p className="text-xs text-text-muted">Started · 30 days</p>
                        <p className="text-lg font-semibold text-success-text">+{s.newPlans}</p>
                    </div>
                    <div className="rounded-lg bg-surface-inset px-3 py-2" title="Plans cancelled or completed in the selected date range, and the monthly revenue they brought in">
                        <p className="text-xs text-text-muted">Ended · this range</p>
                        {s.churnedPlans > 0 ? (
                            <p className="text-lg font-semibold text-error-text whitespace-nowrap">
                                −{s.churnedPlans} · {formatCurrency(s.churnedMrr)}/mo
                            </p>
                        ) : (
                            <p className="text-lg font-semibold text-text-muted">0</p>
                        )}
                    </div>
                </div>
                </div>
                <div className="-mx-4 -mb-4 flex items-center justify-between gap-3 border-t border-border-subtle px-4 py-2.5 text-xs whitespace-nowrap">
                    <span className="text-text-muted">{s.activePlans} active · {s.pausedPlans} paused</span>
                    <Link to="/dispatch/reporting/recurring-revenue" className="font-semibold text-primary hover:underline">
                        Report →
                    </Link>
                </div>
            </div>

        ) : (
            <p></p>
        )

        }
        </Card>
    )
}