import { useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import DayHeaderCell from "./DayHeaderCell";
import type { AgendaEntry } from "./agendaRows";
import { formatDayHeader } from "./scheduleBoardUtils";
import { TOOLBAR_FOCUS } from "./toolbarButton";
import { useFitCount } from "./useFitCount";

export type CompactItem = AgendaEntry & { key: string };

const CARD_GAP = 2;
const MORE_ROW_H = 16;
const STRIP_HEADER_H = 32;

function colMaxLines(pxWidth: number): number {
	if (pxWidth >= 180) return 2;
	if (pxWidth >= 120) return 3;
	if (pxWidth >= 80) return 4;
	return 5;
}

export interface WeekStripDayColumnProps {
	dateStr: string;
	isToday: boolean;
	isZoomed: boolean;
	showZoomButton: boolean;
	isLast: boolean;
	onToggleZoom: () => void;
	onShowMore: () => void;
	onOpenInSchedule?: () => void;
	isDragOver: boolean;
	onDragOver: (e: DragEvent) => void;
	onDragLeave: (e: DragEvent) => void;
	onDrop: (e: DragEvent) => void;
	items: CompactItem[];
	renderCard: (item: CompactItem, maxLines: number) => ReactNode;
	agenda: ReactNode;
}

export default function WeekStripDayColumn({
	dateStr,
	isToday,
	isZoomed,
	showZoomButton,
	isLast,
	onToggleZoom,
	onShowMore,
	onOpenInSchedule,
	isDragOver,
	onDragOver,
	onDragLeave,
	onDrop,
	items,
	renderCard,
	agenda,
}: WeekStripDayColumnProps) {
	const colRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);

	useLayoutEffect(() => {
		const el = colRef.current;
		if (!el) return;
		setWidth(Math.round(el.getBoundingClientRect().width));
		const ro = new ResizeObserver(([entry]) => {
			const w = Math.round(entry.contentRect.width);
			setWidth((prev) => (prev === w ? prev : w));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const maxLines = colMaxLines(width || 120);
	const bodyRef = useRef<HTMLDivElement>(null);
	const { fit, measuring } = useFitCount({
		bodyRef,
		itemKeys: items.map((ci) => ci.key),
		layoutKey: `${width}|${maxLines}`,
		gap: CARD_GAP,
		moreRowH: MORE_ROW_H,
		enabled: !isZoomed,
	});
	const visible = measuring ? items : items.slice(0, fit);
	const hidden = items.length - visible.length;

	const { weekday, day } = formatDayHeader(dateStr);
	const openLabel = `Open ${weekday} ${day} in schedule`;
	const headerActions =
		isZoomed && onOpenInSchedule ? (
			<button
				type="button"
				aria-label={openLabel}
				title={openLabel}
				onClick={onOpenInSchedule}
				className={`h-5 w-5 shrink-0 flex items-center justify-center rounded text-text-muted hover:bg-surface hover:text-text-primary transition-colors duration-150 ${TOOLBAR_FOCUS}`}
			>
				<ArrowUpRight size={12} aria-hidden />
			</button>
		) : undefined;

	return (
		<div
			ref={colRef}
			data-strip-day={dateStr}
			className="group"
			style={{
				borderRight: isLast ? "none" : "1px solid var(--color-border-subtle)",
				display: "flex",
				flexDirection: "column",
				minHeight: 0,
				minWidth: 0,
				overflow: "hidden",
			}}
		>
			<DayHeaderCell
				dateStr={dateStr}
				isToday={isToday}
				isZoomed={isZoomed}
				height={STRIP_HEADER_H}
				onToggleZoom={showZoomButton ? onToggleZoom : undefined}
				actions={headerActions}
				style={{
					borderBottom: "1px solid var(--color-border-subtle)",
					backgroundColor: "var(--color-base)",
				}}
			/>
			<div
				ref={bodyRef}
				data-strip-body
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				onDrop={onDrop}
				style={{
					flex: 1,
					minHeight: 0,
					overflowY: isZoomed ? "auto" : "hidden",
					padding: 4,
					display: "flex",
					flexDirection: "column",
					gap: CARD_GAP,
					backgroundColor: isDragOver
						? "rgba(59,130,246,0.08)"
						: isToday
							? "rgba(59,130,246,0.035)"
							: "transparent",
					outline: isDragOver ? "2px inset rgba(59,130,246,0.4)" : "none",
					transition: "background-color 0.1s",
				}}
			>
				{isZoomed ? (
					agenda
				) : (
					<>
						{visible.map((ci) => (
							<div key={ci.key} data-fit-item style={{ flexShrink: 0 }}>
								{renderCard(ci, maxLines)}
							</div>
						))}
						{hidden > 0 && (
							<button
								type="button"
								data-show-more
								onClick={onShowMore}
								className={`shrink-0 text-left rounded-sm ${TOOLBAR_FOCUS}`}
								style={{
									height: MORE_ROW_H,
									lineHeight: `${MORE_ROW_H}px`,
									fontSize: 9,
									fontWeight: 600,
									color: "var(--color-visit-driving-text)",
									background: "none",
									border: "none",
									padding: 0,
									fontFamily: "inherit",
								}}
							>
								+{hidden} more
							</button>
						)}
					</>
				)}
			</div>
		</div>
	);
}
