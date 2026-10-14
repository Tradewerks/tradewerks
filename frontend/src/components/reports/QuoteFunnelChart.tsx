import {
	BarChart,
	Bar,
	Cell,
	XAxis,
	YAxis,
	CartesianGrid,
	LabelList,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import Card from "../ui/Card";
import type { QuoteFunnelStages } from "../../types/reports";

interface QuoteFunnelChartProps {
	funnel: QuoteFunnelStages;
}

interface FunnelDatum {
	name: string;
	value: number;
	fill: string;
}

const STAGE_META: { key: keyof QuoteFunnelStages; label: string; fill: string }[] = [
	{ key: "created", label: "Created", fill: "var(--color-chart-primary)" },
	{ key: "issued", label: "Created", fill: "var(--color-chart-info)" },
	{ key: "sent", label: "Sent", fill: "var(--color-chart-warning)" },
	{ key: "viewed", label: "Viewed", fill: "var(--color-orange)" },
	{ key: "approved", label: "Approved", fill: "var(--color-chart-success)" },
];

function CustomTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: { payload: FunnelDatum }[];
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;
	return (
		<div className="rounded-lg px-3 py-2 bg-base/90 backdrop-blur-md shadow-lg border border-border-subtle">
			<p className="text-xs text-text-tertiary">{d.name}</p>
			<p className="text-sm font-semibold text-primary">
				{d.value} {d.value === 1 ? "quote" : "quotes"}
			</p>
		</div>
	);
}

function BarLabel({
	x,
	y,
	width,
	height,
	value,
}: {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	value?: number;
}) {
	if (x == null || y == null || width == null || height == null) return null;
	return (
		<text
			x={x + width + 8}
			y={y + height / 2}
			dominantBaseline="central"
			fontSize={12}
			fill="var(--color-chart-axis)"
		>
			<tspan className="font-semibold" fill="var(--color-text-primary)">
				{value?.toLocaleString()}
			</tspan>
		</text>
	);
}

export default function QuoteFunnelChart({ funnel }: QuoteFunnelChartProps) {
	const chartData: FunnelDatum[] = STAGE_META.map((m) => ({
		name: m.label,
		value: funnel[m.key],
		fill: m.fill,
	}));

	return (
		<Card className="h-full" title="Conversion Funnel">
			{funnel.created === 0 ? (
				<div className="flex-1 min-h-0 flex items-center justify-center">
					<p className="text-sm text-text-muted">No quotes in this period</p>
				</div>
			) : (
				<div className="flex-1 min-h-0">
					<ResponsiveContainer width="100%" height="100%" minWidth={0}>
						<BarChart
							data={chartData}
							layout="vertical"
							margin={{ top: 8, right: 64, bottom: 4, left: 8 }}
						>
							<CartesianGrid horizontal={false} stroke="var(--color-border-subtle)" />
							<XAxis type="number" hide />
							<YAxis
								type="category"
								dataKey="name"
								axisLine={false}
								tickLine={false}
								tick={{ fill: "var(--color-chart-axis)", fontSize: 12 }}
								width={72}
							/>
							<Tooltip content={<CustomTooltip />} cursor={false} />
							<Bar dataKey="value" radius={[0, 4, 4, 0]} maxBarSize={26}>
								{chartData.map((d) => (
									<Cell key={d.name} fill={d.fill} />
								))}
								<LabelList content={<BarLabel />} />
							</Bar>
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}
		</Card>
	);
}
