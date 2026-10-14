import type { ArrivalStatus } from "../../types/arrivals";
import { ARRIVAL_STATUS_META } from "./arrivalPresentation";

interface ArrivalStatusBadgeProps {
	status: ArrivalStatus;
	size?: "sm" | "md";
}

export default function ArrivalStatusBadge({ status, size = "sm" }: ArrivalStatusBadgeProps) {
	const meta = ARRIVAL_STATUS_META[status];
	const Icon = meta.icon;
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-md border font-medium whitespace-nowrap ${meta.badge} ${
				size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-1 text-sm"
			}`}
		>
			<Icon size={size === "sm" ? 12 : 14} aria-hidden="true" />
			{meta.label}
		</span>
	);
}
