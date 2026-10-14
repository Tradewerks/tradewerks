import type { CSSProperties, ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { formatDayHeader } from "./scheduleBoardUtils";
import { TOOLBAR_FOCUS } from "./toolbarButton";

export interface DayHeaderCellProps {
	dateStr: string;
	isToday: boolean;
	isZoomed: boolean;
	height: number;
	onToggleZoom?: () => void;
	/** The pointer is somewhere in this day's column, not just on the header. */
	revealZoom?: boolean;
	actions?: ReactNode;
	style?: CSSProperties;
}

export default function DayHeaderCell({
	dateStr,
	isToday,
	isZoomed,
	height,
	onToggleZoom,
	revealZoom = false,
	actions,
	style,
}: DayHeaderCellProps) {
	const { weekday, day } = formatDayHeader(dateStr);
	const zoomLabel = `${isZoomed ? "Collapse" : "Expand"} ${weekday} ${day}`;
	return (
		<div
			data-day-header={dateStr}
			className="group"
			style={{
				height,
				flexShrink: 0,
				minWidth: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				paddingLeft: 10,
				paddingRight: 6,
				boxShadow: isToday ? "inset 0 -2px 0 var(--color-primary)" : undefined,
				...style,
			}}
		>
			<div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
				<span
					data-day-weekday
					style={{
						fontSize: 10,
						fontWeight: 600,
						color: isToday ? "var(--color-visit-driving-text)" : "var(--color-sched-text-secondary)",
						textTransform: "uppercase",
						letterSpacing: "0.05em",
					}}
				>
					{weekday}
				</span>
				<span
					data-day-num
					style={{
						fontSize: 15,
						fontWeight: 700,
						color: isToday ? "var(--color-primary)" : "var(--color-text-on-surface)",
					}}
				>
					{day}
				</span>
			</div>
			{(actions || onToggleZoom) && (
				<div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
					{actions}
					{onToggleZoom && (
						<button
							type="button"
							onClick={onToggleZoom}
							aria-label={zoomLabel}
							aria-pressed={isZoomed}
							title={zoomLabel}
							className={`h-5 w-5 flex items-center justify-center rounded transition-[color,background-color,opacity] duration-150 hover:bg-surface hover:text-text-primary focus-visible:opacity-100 ${TOOLBAR_FOCUS} ${
								isZoomed
									? "opacity-100 text-primary-text"
									: `${revealZoom ? "opacity-100" : "opacity-0 group-hover:opacity-100"} text-text-muted`
							}`}
						>
							{isZoomed ? <Minimize2 size={12} aria-hidden /> : <Maximize2 size={12} aria-hidden />}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
