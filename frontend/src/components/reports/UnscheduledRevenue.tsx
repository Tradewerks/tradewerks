import { Link } from "react-router-dom";
import Card from "../ui/Card";
import { formatCurrency } from "../../util/util";
import type { UnscheduledRevenueResponse, UnscheduledJobRevenue } from "../../types/reports";

interface UnscheduledRevenueProps {
	data: UnscheduledRevenueResponse;
}

interface RevenueLevelConfig {
	key: "new" | "warning" | "critical";
	label: string;
	color: string;
	dotClass: string;
	days: string;
}

const REVENUE_LEVELS: RevenueLevelConfig[] = [
	{ key: "new", label: "New", color: "var(--color-success)", dotClass: "bg-success", days: "< 7 days" },
	{ key: "warning", label: "Aging", color: "var(--color-warning)", dotClass: "bg-warning", days: "7–30 days" },
	{ key: "critical", label: "Critical", color: "var(--color-error)", dotClass: "bg-error", days: "> 30 days" },
];

export default function UnscheduledRevenue({ data }: UnscheduledRevenueProps) {
	const { totalRevenue, jobCount } = data;

	const segments = REVENUE_LEVELS.map((b) => {
		const bucket: UnscheduledJobRevenue = data[b.key];
		const pct = totalRevenue > 0 ? (bucket.revenue / totalRevenue) * 100 : 0;
		return { ...b, bucket, pct };
	});

	return (
		<Card
			className="h-full"
			title="Unscheduled Job Revenue"
			headerAction={
				<Link
					to="/dispatch/jobs?status=Unscheduled"
					className="text-[11px] font-medium text-text-tertiary bg-surface px-2 py-0.5 rounded-full hover:text-text-primary hover:bg-surface-raised transition-colors"
				>
					{jobCount} {jobCount === 1 ? "Job" : "Jobs"} →
				</Link>
			}
		>
			<p className="text-3xl font-bold text-primary tracking-tight mb-5">
				{formatCurrency(totalRevenue)}
			</p>

			<div className="flex w-full h-3 rounded-full overflow-hidden mb-6">
				{segments.map((seg) =>
					seg.pct > 0 ? (
						<div
							key={seg.key}
							className="h-full transition-all duration-300"
							style={{
								width: `${seg.pct}%`,
								backgroundColor: seg.color,
							}}
						/>
					) : null,
				)}
			</div>

			<div className="flex flex-col gap-1">
				{segments.map((seg) => (
					<div
						key={seg.key}
						className="group flex items-center justify-between text-sm px-2 py-2 rounded-lg transition-colors hover:bg-surface-raised"
					>
						<div className="flex items-center gap-2.5">
							<span
								className={`w-2 h-2 rounded-full shrink-0 ${seg.dotClass}`}
							/>
							<span className="text-text-tertiary">{seg.label}</span>
							<span className="text-[11px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
								{seg.days}
							</span>
						</div>
						<span
							className={`font-medium ${
								seg.key === "critical" && seg.bucket.revenue > 0
									? "text-error-text"
									: seg.key === "critical"
										? "text-secondary"
										: "text-primary"
							}`}
						>
							{formatCurrency(seg.bucket.revenue)}
						</span>
					</div>
				))}
			</div>
		</Card>
	);
}
