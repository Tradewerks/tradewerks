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

interface props {
    timeBuckets: {
        bucket: string; 
        paid: number; 
        open: number
    }[]
}    

const STAGES = [
    { key: "paid", label: "Paid", fill: "var(--color-chart-success)" },
    { key: "open", label: "Open, overdue", fill: "var(--color-chart-error)" },
] as const;

function CustomTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: { payload: props["timeBuckets"][number] }[];
}) {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    if (!d?.bucket) return null;

    return (
        <div className="rounded-lg px-3 py-2 bg-base/90 backdrop-blur-md shadow-lg border border-border-subtle">
            <p className="text-xs text-text-tertiary">{d.bucket === "Early" || d.bucket === "On time" ? d.bucket : `${d.bucket} days late`}</p>
            <p className="text-sm font-semibold text-primary">{d.open + d.paid} invoice{d.open + d.paid === 1 ? "" : "s"}</p>
            {STAGES.filter((s) => d[s.key] > 0).map((s) => (
                <p key={s.key} className="flex items-center gap-1.5 text-xs text-text-tertiary">
                    <span className="size-2 rounded-full" style={{ background: s.fill }} />
                    {s.label} · {d[s.key]}
                </p>
            ))}
        </div>
    );
}

export default function InvoiceLifeCycleChart ({ timeBuckets }: props) {    
    
    return (
        <Card title="Payment Timing" className="mb-4 h-80">
            <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex-1 min-h-0">
                    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                        <BarChart data={timeBuckets} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
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
                                allowDecimals={false}
                            />
                            <Tooltip content={<CustomTooltip />} cursor={false} />
                            <Legend
                                iconType="circle"
                                iconSize={8}
                                itemSorter={null}
                                wrapperStyle={{ color: "var(--color-chart-axis)", fontSize: 12 }}
                            />
                            <Bar
                                dataKey="paid"
                                name="Paid"
                                stackId="a"
                                fill="var(--color-chart-success)"
                                shape={(p) => <Rectangle {...p} radius={p.payload.open ? 0 : [4, 4, 0, 0]} />}
                                maxBarSize={64}
                            >
                            </Bar>
                            <Bar
                                dataKey="open"
                                name="Open, overdue"
                                stackId="a"
                                fill="var(--color-chart-error)"
                                radius={[4, 4, 0, 0]}
                                maxBarSize={64}
                            >
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
                <p className="text-xs text-center mt-2">
                    <span className="text-text-tertiary">
                        Total open ·{" "}
                    </span>
                    <span className="font-semibold text-text-primary tabular-nums">
                        {timeBuckets.reduce((s, b) => s + b.open, 0)}
                    </span> 
                    
                </p>
            </div>
        </Card>
    )
}
