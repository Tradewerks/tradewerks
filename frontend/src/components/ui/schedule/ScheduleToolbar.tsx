import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, Eye, EyeOff } from "lucide-react";
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_IDLE, TOOLBAR_FOCUS } from "./toolbarButton";

export interface ScheduleToolbarProps {
	periodLabel: string;
	prevLabel: string;
	nextLabel: string;
	onToday: () => void;
	onPrev: () => void;
	onNext: () => void;
	viewMode?: "week" | "month";
	onViewModeChange?: (mode: "week" | "month") => void;
	showVisits: boolean;
	onToggleVisits: () => void;
	showOccurrences: boolean;
	onToggleOccurrences: () => void;
	compact?: boolean;
	techFilter: ReactNode;
	className?: string;
}

const RECURRING_ON = "bg-reviewing-bg border-reviewing-border text-reviewing-text";
const SEGMENT = `h-6 px-3 rounded-sm text-[11px] font-medium transition-colors duration-150 ${TOOLBAR_FOCUS}`;
const SEGMENT_ON = "bg-surface-raised text-text-primary";
const SEGMENT_OFF = "text-text-muted hover:text-text-secondary hover:bg-surface";
const NAV_BTN = `${TOOLBAR_BTN_BASE} ${TOOLBAR_BTN_IDLE} w-7 shrink-0 flex items-center justify-center`;

function Divider() {
	return <div aria-hidden className="w-px h-4 bg-border-subtle mx-1 shrink-0" />;
}

function LayerToggle({
	label,
	on,
	onClass,
	onClick,
	compact,
}: {
	label: string;
	on: boolean;
	onClass: string;
	onClick: () => void;
	compact: boolean;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			aria-label={compact ? label : undefined}
			title={compact ? label : undefined}
			onClick={onClick}
			className={`${TOOLBAR_BTN_BASE} flex items-center gap-1.5 px-2.5 shrink-0 ${on ? onClass : TOOLBAR_BTN_IDLE}`}
		>
			{on ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
			{!compact && label}
		</button>
	);
}

export default function ScheduleToolbar({
	periodLabel,
	prevLabel,
	nextLabel,
	onToday,
	onPrev,
	onNext,
	viewMode,
	onViewModeChange,
	showVisits,
	onToggleVisits,
	showOccurrences,
	onToggleOccurrences,
	compact = false,
	techFilter,
	className = "",
}: ScheduleToolbarProps) {
	return (
		<div
			data-schedule-toolbar
			className={`flex items-center gap-1.5 px-3 h-11 border-b border-border-subtle shrink-0 ${className}`}
		>
			<button
				type="button"
				onClick={onToday}
				className={`${TOOLBAR_BTN_BASE} ${TOOLBAR_BTN_IDLE} px-3 shrink-0`}
			>
				Today
			</button>

			<div className="flex items-center gap-1 min-w-0">
				<button type="button" aria-label={prevLabel} title={prevLabel} onClick={onPrev} className={NAV_BTN}>
					<ChevronLeft size={14} aria-hidden />
				</button>
				<span
					className={`text-[13px] font-semibold text-text-primary text-center tracking-tight truncate ${compact ? "min-w-0" : "min-w-[176px]"}`}
				>
					{periodLabel}
				</span>
				<button type="button" aria-label={nextLabel} title={nextLabel} onClick={onNext} className={NAV_BTN}>
					<ChevronRight size={14} aria-hidden />
				</button>
			</div>

			{viewMode && onViewModeChange && (
				<>
					<Divider />
					<div
						data-segmented
						className="flex items-center bg-base border border-border-subtle rounded p-0.5 shrink-0"
					>
						{(["week", "month"] as const).map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={viewMode === m}
								onClick={() => onViewModeChange(m)}
								className={`${SEGMENT} ${viewMode === m ? SEGMENT_ON : SEGMENT_OFF}`}
							>
								{m === "week" ? "Week" : "Month"}
							</button>
						))}
					</div>
				</>
			)}

			<Divider />
			<LayerToggle label="Visits" on={showVisits} onClass={TOOLBAR_BTN_ACTIVE} onClick={onToggleVisits} compact={compact} />
			<LayerToggle
				label="Recurring"
				on={showOccurrences}
				onClass={RECURRING_ON}
				onClick={onToggleOccurrences}
				compact={compact}
			/>
			<Divider />
			{techFilter}
		</div>
	);
}
