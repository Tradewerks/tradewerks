import type { EntitlementsData, UsageMeter, UsageSummary } from "../../../lib/permissionAccess";
import { meterText, meterTone, resetLabel } from "../../../lib/moduleGroups";

const sectionLabel = "text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

const ROWS: {
	key: keyof UsageSummary["meters"];
	label: string;
	monthly: boolean;
	module?: string;
}[] = [
	{ key: "dispatchers", label: "Dispatchers", monthly: false },
	{ key: "technicians", label: "Technicians", monthly: false },
	{ key: "ai_calls_month", label: "AI assistant requests", monthly: true, module: "ai_assistant" },
	{ key: "tax_lookups_month", label: "Tax lookups", monthly: true, module: "tax_auto" },
	{ key: "receipt_scans_month", label: "Receipt scans", monthly: true, module: "field_purchases" },
];

const BAR: Record<ReturnType<typeof meterTone>, string> = {
	normal: "bg-primary",
	warning: "bg-warning",
	full: "bg-error",
};

function Row({ label, meter, sub }: { label: string; meter: UsageMeter; sub?: string }) {
	const tone = meterTone(meter);
	const pct =
		meter.limit === null
			? 0
			: meter.limit === 0
				? 100
				: Math.min(100, (meter.used / meter.limit) * 100);
	return (
		<li>
			<div className="flex items-baseline justify-between gap-2">
				<span className="text-sm text-text-primary">{label}</span>
				<span
					className={`text-xs tabular-nums ${tone === "full" ? "text-error-text" : "text-text-secondary"}`}
				>
					{meterText(meter)}
				</span>
			</div>
			{meter.limit !== null && (
				<div
					className="mt-1 h-1 overflow-hidden rounded-full bg-surface-inset"
					role="progressbar"
					aria-label={label}
					aria-valuemin={0}
					aria-valuemax={meter.limit}
					aria-valuenow={meter.used}
				>
					<div
						className={`h-full ${BAR[tone]}`}
						style={{ width: `${pct}%` }}
					/>
				</div>
			)}
			{sub && (
				<span className="mt-0.5 block text-[11px] text-text-muted">
					{sub}
				</span>
			)}
		</li>
	);
}

export default function UsageMeters({
	usage,
	modules,
}: {
	usage: UsageSummary;
	modules: EntitlementsData["modules"];
}) {
	const reset = resetLabel(usage.period_start);
	// A module missing from the payload (older snapshot) keeps its meter rather than hiding it.
	const off = (key?: string) => !!key && modules.some((m) => m.key === key && m.state !== "on");
	return (
		<div className="border-t border-border-subtle p-4">
			<h3 className={sectionLabel}>Usage</h3>
			<ul className="mt-2 space-y-3">
				{/* The frontend can run ahead of the backend; a meter it does not send yet is skipped. */}
				{ROWS.filter((r) => usage.meters[r.key] && !off(r.module)).map((r) => (
					<Row
						key={r.key}
						label={r.label}
						meter={usage.meters[r.key]}
						sub={r.monthly ? reset : undefined}
					/>
				))}
			</ul>
		</div>
	);
}
