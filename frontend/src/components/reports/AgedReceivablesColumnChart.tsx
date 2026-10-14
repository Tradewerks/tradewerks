import { useState } from "react";
import {
	BarChart,
	Bar,
	Cell,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import Card from "../ui/Card";
import { formatCurrency } from "../../util/util";
import type {
	AgedReceivablesResponse,
	AgedReceivablesBucket,
} from "../../types/reports";

type Bucket = AgedReceivablesBucket["bucket"];

interface BucketMeta {
	bucket: Bucket;
	label: string;
	shortLabel: string;
	barFill: string;
}

// Severity is green -> yellow -> orange -> red as the debt ages 
const BUCKET_META: BucketMeta[] = [
	{
		bucket: "0-30",
		label: "Overdue by less than 30 days",
		shortLabel: "0-30",
		barFill: "var(--color-chart-success)",
	},
	{
		bucket: "31-60",
		label: "Overdue by 30 to 60 days",
		shortLabel: "31-60",
		barFill: "var(--color-chart-warning)",
	},
	{
		bucket: "61-90",
		label: "Overdue by 60 to 90 days",
		shortLabel: "61-90",
		barFill: "var(--color-orange)",
	},
	{
		bucket: "90+",
		label: "Overdue by greater than 90 days",
		shortLabel: "90+",
		barFill: "var(--color-chart-error)",
	},
];

interface AgedReceivablesColumnChartProps {
	data: AgedReceivablesResponse;
}

interface ColumnDatum {
	bucket: Bucket;
	label: string;
	shortLabel: string;
	amount: number;
	count: number;
	fill: string;
}

// Compact currency for the value axis ($31.4k / $1.2M) so ticks stay readable.
const formatAxisCurrency = (value: number) => {
	if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
	if (value >= 1000) return `$${(value / 1000).toFixed(0)}k`;
	return `$${value}`;
};

function CustomTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: { payload: ColumnDatum }[];
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;
	if (!d?.bucket) return null;

	return (
		<div className="rounded-lg px-3 py-2 bg-base/90 backdrop-blur-md shadow-lg border border-border-subtle">
			<p className="text-xs text-text-tertiary">{d.label}</p>
			<p className="text-sm font-semibold text-primary">
				{formatCurrency(d.amount)}
			</p>
			<p className="text-xs text-text-tertiary">
				{d.count} {d.count === 1 ? "invoice" : "invoices"}
			</p>
		</div>
	);
}

export default function AgedReceivablesColumnChart({
	data,
}: AgedReceivablesColumnChartProps) {
	const { data: buckets, totalOutstanding, disputedTotal, disputedCount } = data;
	const [activeBucket, setActiveBucket] = useState<Bucket | null>(null);

	const isEmpty = totalOutstanding === 0;

	const amountFor = (bucket: Bucket) =>
		buckets.find((b) => b.bucket === bucket)?.amount ?? 0;
	const countFor = (bucket: Bucket) =>
		buckets.find((b) => b.bucket === bucket)?.count ?? 0;

	// totalOutstanding includes the disputed balance, so the count beside it
	// has to include the disputed invoices the buckets deliberately exclude.
	const totalCount = buckets.reduce((sum, b) => sum + b.count, 0) + disputedCount;

	const chartData: ColumnDatum[] = BUCKET_META.map((m) => ({
		bucket: m.bucket,
		label: m.label,
		shortLabel: m.shortLabel,
		amount: amountFor(m.bucket),
		count: countFor(m.bucket),
		fill: m.barFill,
	}));

	return (
		<Card
			className="h-full"
			title="Aged Receivables"
			headerAction={
				<span className="text-xl font-bold text-primary">
					{formatCurrency(totalOutstanding)}
				</span>
			}
		>
			{isEmpty ? (
				<div className="flex-1 min-h-0 flex items-center justify-center">
					<p className="text-sm text-text-muted">
						No outstanding receivables
					</p>
				</div>
			) : (
				<div className="flex-1 min-h-0 flex flex-col">
					{/* Column chart */}
					<div className="flex-1 min-h-0">
						<ResponsiveContainer width="100%" height="100%" minWidth={0}>
							<BarChart
								data={chartData}
								margin={{ top: 8, right: 8, bottom: 4, left: 8 }}
							>
								<CartesianGrid
									vertical={false}
									stroke="var(--color-border-subtle)"
								/>
								<XAxis
									dataKey="shortLabel"
									axisLine={false}
									tickLine={false}
									tick={{ fill: "var(--color-chart-axis)", fontSize: 12 }}
								/>
								<YAxis
									axisLine={false}
									tickLine={false}
									tick={{ fill: "var(--color-chart-axis)", fontSize: 12 }}
									tickFormatter={formatAxisCurrency}
									width={56}
								/>
								<Tooltip content={<CustomTooltip />} cursor={false} />
								<Bar
									dataKey="amount"
									radius={[4, 4, 0, 0]}
									maxBarSize={64}
									onMouseEnter={(_, index) =>
										setActiveBucket(chartData[index]?.bucket ?? null)
									}
									onMouseLeave={() => setActiveBucket(null)}
								>
									{chartData.map((d) => (
										<Cell
											key={d.bucket}
											fill={d.fill}
											fillOpacity={
												!activeBucket || activeBucket === d.bucket
													? 1
													: 0.3
											}
											className="cursor-pointer transition-opacity"
										/>
									))}
								</Bar>
							</BarChart>
						</ResponsiveContainer>
					</div>

					<p className="text-xs text-center mt-2">
						<span className="text-text-tertiary">
							Total outstanding ·{" "}
						</span>
						<span className="font-semibold text-text-primary tabular-nums">
							{formatCurrency(totalOutstanding)}
						</span>
						<span className="text-text-tertiary">
							{" "}
							· {totalCount}{" "}
							{totalCount === 1 ? "invoice" : "invoices"}
						</span>
						{disputedTotal > 0 && (
							<span className="text-warning-text">
								{" "}
								· {formatCurrency(disputedTotal)} in dispute
							</span>
						)}
					</p>
				</div>
			)}
		</Card>
	);
}
