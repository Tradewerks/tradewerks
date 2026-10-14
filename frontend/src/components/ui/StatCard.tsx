import type { ReactNode } from "react";

export interface StatCardProps {
	label: string;
	/**
	 * ReactNode, not string: the detail stat rows style the number and its unit
	 * separately, and the invoice's Paid tile puts a meter in its hint.
	 */
	value: ReactNode;
	hint?: ReactNode;
	tone?: "error" | "warning";
	/** Small glyph beside the label, as ItemStatRow's tiles carry. */
	icon?: ReactNode;
	/** Row sizing (e.g. `flex-1 min-w-[150px]`), owned by the caller's layout. */
	className?: string;
	/**
	 * `lg` for a tile that stands on its own; `xl` where the strip shares its
	 * column edges with Card-bodied sections below, so the corners match. Not a
	 * `className` job — two `rounded-*` utilities are settled by stylesheet
	 * order, not by which was appended last.
	 */
	radius?: "lg" | "xl";
	/** Half the height, same facts: the hint joins the value's line. */
	dense?: boolean;
}

export default function StatCard({
	label,
	value,
	hint,
	tone,
	dense,
	icon,
	className = "",
	radius = "lg",
}: StatCardProps) {
	const radiusClass = radius === "xl" ? "rounded-xl" : "rounded-lg";
	const valueTone =
		tone === "error"
			? "text-error-text"
			: tone === "warning"
				? "text-warning-text"
				: "text-text-primary";

	if (dense) {
		return (
			<div className={`px-3 py-2 bg-base border border-border-subtle ${radiusClass} ${className}`}>
				<p className="flex items-center gap-1.5 text-[10px] text-text-muted uppercase tracking-wide font-semibold">
					{icon}
					{label}
				</p>
				<p className="flex items-baseline gap-1.5 min-w-0">
					<span className={`text-lg font-bold tabular-nums ${valueTone}`}>{value}</span>
					{hint && <span className="text-[11px] text-text-muted truncate">{hint}</span>}
				</p>
			</div>
		);
	}

	return (
		<div className={`p-4 bg-base border border-border-subtle ${radiusClass} ${className}`}>
			<p className="flex items-center gap-1.5 text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
				{icon}
				{label}
			</p>
			<div className={`text-xl font-bold tabular-nums ${valueTone}`}>
				{value}
			</div>
			{hint && <div className="text-xs text-text-muted mt-0.5">{hint}</div>}
		</div>
	);
}
