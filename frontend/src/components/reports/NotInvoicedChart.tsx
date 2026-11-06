import {
	BarChart,
	Bar,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	Legend,
	ResponsiveContainer,
	Rectangle,
} from "recharts";
import Card from "../ui/Card";
import { formatCurrency } from "../../util/util";

const formatAxisCurrency = (value: number) => {
	if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
	if (value >= 1000) return `$${+(value / 1000).toFixed(1)}k`;
	return `$${value}`;
};

interface props {
    agedBuckets: {
        bucket: string; 
        in_progress: number; 
        approved: number; 
        ready: number; 
        total: number
    }[]
}    

const STAGES = [
	{ key: "in_progress", label: "In progress", fill: "var(--color-chart-warning)" },
	{ key: "approved", label: "Approved", fill: "var(--color-chart-primary)" },
	{ key: "ready", label: "Ready to bill", fill: "var(--color-chart-success)" },
] as const;

// Round only the top segment of each stack (stack order: in progress, approved, ready)
const topKey = (d: props["agedBuckets"][number]) =>
	d.ready > 0 ? "ready" : d.approved > 0 ? "approved" : "in_progress";

function CustomTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: { payload: props["agedBuckets"][number] }[];
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;
	if (!d?.bucket) return null;

	return (
		<div className="rounded-lg px-3 py-2 bg-base/90 backdrop-blur-md shadow-lg border border-border-subtle">
			<p className="text-xs text-text-tertiary">{d.bucket} days old</p>
			<p className="text-sm font-semibold text-primary">{formatCurrency(d.total)}</p>
			{STAGES.filter((s) => d[s.key] > 0).map((s) => (
				<p key={s.key} className="flex items-center gap-1.5 text-xs text-text-tertiary">
					<span className="size-2 rounded-full" style={{ background: s.fill }} />
					{s.label} · {formatCurrency(d[s.key])}
				</p>
			))}
		</div>
	);
}

export default function NotInvoicedChart ({ agedBuckets }: props) {    
    
    return (
        <Card title="Not Invoiced Chart" className="mb-4 h-80">
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                        <BarChart data={agedBuckets} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
                            <CartesianGrid
                                vertical={false}
                                stroke="var(--color-border-subtle)"
                                />
                            <XAxis
                                dataKey="bucket"
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: "var(--color-chart-axis)", fontSize: 12 }}
                            />
                            <YAxis
                                axisLine={false}
                                tickLine={false}
                                tick={{ fill: "var(--color-chart-axis)", fontSize: 12 }}
                                width={56}
                                tickFormatter={formatAxisCurrency}
                            />
                            <Tooltip content={<CustomTooltip />} cursor={false} />
                            <Legend
                                iconType="circle"
                                iconSize={8}
                                itemSorter={null}
                                wrapperStyle={{ color: "var(--color-chart-axis)", fontSize: 12 }}
                            />
                            <Bar
                                dataKey="in_progress"
                                name="In progress" 
                                stackId="a" 
                                fill="var(--color-chart-warning)"
                                shape={(p) => <Rectangle {...p} radius={topKey(p.payload) === "in_progress" ? [4, 4, 0, 0] : 0} />}
								maxBarSize={64}
                            >
                            </Bar>
                            <Bar
                                dataKey="approved"
                                name="Approved" 
                                stackId="a" 
                                fill="var(--color-chart-primary)"
                                shape={(p) => <Rectangle {...p} radius={topKey(p.payload) === "approved" ? [4, 4, 0, 0] : 0} />}
								maxBarSize={64}
                            >
                            </Bar>
                            <Bar
                                dataKey="ready"
                                name="Ready to bill" 
                                stackId="a" 
                                fill="var(--color-chart-success)"
                                radius={[4, 4, 0, 0]}
								maxBarSize={64}
                            >
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
                <p className="text-xs text-center mt-2">
                    <span className="text-text-tertiary">
                        Total outstanding ·{" "}
                    </span>
                    <span className="font-semibold text-text-primary tabular-nums">
                        {formatCurrency(agedBuckets.reduce((s, b) => s + b.total, 0))}
                    </span> 
                    
                </p>
            </div>
        </Card>
    )
}
