import { ShieldCheck } from "lucide-react";
import type { Technician, TechnicianStatus } from "../../types/technicians";
import {
	TechnicianStatusColors,
	TechnicianStatusDotColors,
	TechnicianStatusLabels,
} from "../../types/technicians";
import { VisitStatusLabels } from "../../types/jobs";
import { formatTime, initials, visitLabel } from "./technicianFormat";
import type { TechnicianActivity } from "./technicianActivity";

export function Avatar({
	technician,
	size,
	showStatus = true,
}: {
	technician: { name: string; status?: TechnicianStatus };
	size: "sm" | "md" | "lg" | "xl";
	// Account views (Admin → Users) show who, not live state.
	showStatus?: boolean;
}) {
	const box =
		size === "sm"
			? "h-7 w-7 rounded-lg text-xs"
			: size === "md"
				? "h-8 w-8 rounded-lg text-xs"
				: size === "lg"
					? "h-10 w-10 rounded-lg text-sm"
					: "h-14 w-14 rounded-xl text-xl";
	const dot = size === "xl" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
	return (
		<div className="relative shrink-0">
			<div
				aria-hidden
				className={`${box} flex items-center justify-center bg-avatar-bg font-semibold text-avatar-fg`}
			>
				{initials(technician.name)}
			</div>
			{showStatus && technician.status && (
				<span
					aria-hidden
					className={`absolute -bottom-0.5 -right-0.5 ${dot} rounded-full border-2 border-base ${TechnicianStatusDotColors[technician.status]}`}
				/>
			)}
		</div>
	);
}

export function StatusPill({ technician }: { technician: Technician }) {
	return (
		<span
			className={`inline-flex w-fit items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TechnicianStatusColors[technician.status]}`}
		>
			{TechnicianStatusLabels[technician.status]}
		</span>
	);
}

export function MfaMark({ enabled }: { enabled?: boolean }) {
	if (!enabled) return null;
	return (
		<span title="Two-factor authentication enabled" className="text-success-text">
			<ShieldCheck size={14} aria-hidden />
			<span className="sr-only">MFA enabled</span>
		</span>
	);
}

export function NowText({ activity }: { activity: TechnicianActivity }) {
	const { current, next } = activity;
	if (current) {
		return (
			<div className="min-w-0">
				<p className="truncate text-sm text-text-primary">
					{visitLabel(current)}
				</p>
				<p className="truncate text-xs text-text-tertiary">
					{VisitStatusLabels[current.visit.status]}
				</p>
			</div>
		);
	}
	if (next) {
		return (
			<div className="min-w-0">
				<p className="truncate text-sm text-text-secondary">
					{visitLabel(next)}
				</p>
				<p className="truncate text-xs text-text-tertiary">
					Next at {formatTime(next.visit.scheduled_start_at)}
				</p>
			</div>
		);
	}
	return <p className="truncate text-sm text-text-muted">No upcoming visits today</p>;
}

export function TodayProgress({ done, total }: { done: number; total: number }) {
	if (total === 0) return <span className="text-sm text-text-muted">None</span>;
	return (
		<div
			title={`${done} of ${total} visits completed today`}
			className="flex flex-col gap-1"
		>
			<span className="text-sm tabular-nums text-text-primary">
				{done}
				<span className="text-text-tertiary"> of {total} done</span>
			</span>
			<div
				aria-hidden
				className="h-1 w-full overflow-hidden rounded-full bg-surface-raised"
			>
				<div
					className="h-full rounded-full bg-success"
					style={{ width: `${(done / total) * 100}%` }}
				/>
			</div>
		</div>
	);
}
