import { useLayoutEffect, useRef } from "react";
import {
	CARD_BG,
	OCCURRENCE_CARD_BG,
	TEXT_MUTED,
	VISIT_TITLE,
	OCCURRENCE_TITLE,
} from "./scheduleTokens";

interface MiniCardTech {
	id: string;
	color: string;
}

interface MonthMiniCardProps {
	visitName: string;
	priorityColor: string;
	timeLabel: string;
	techs: MiniCardTech[];
	maxLines?: number;
	size?: "sm" | "lg";
	isOccurrence?: boolean;
	isDragging?: boolean;
	isGhost?: boolean;
	onDragStart?: (e: React.DragEvent) => void;
	onDragEnd?: () => void;
	onClick?: (e: React.MouseEvent) => void;
}

const SIZE_CONFIG = {
	sm: { stripeW: 5, padding: "2px 5px 2px 4px", titleFont: 9, timeFont: 8, dotSize: 6, overflowFont: 7, metaH: 11 },
	lg: { stripeW: 6, padding: "4px 8px 4px 6px", titleFont: 12, timeFont: 10, dotSize: 8, overflowFont: 9, metaH: 14 },
} as const;

export default function MonthMiniCard({
	visitName,
	priorityColor,
	timeLabel,
	techs,
	maxLines = 2,
	size = "sm",
	isOccurrence = false,
	isDragging = false,
	isGhost = false,
	onDragStart,
	onDragEnd,
	onClick,
}: MonthMiniCardProps) {
	const hasTechs = techs.length > 0;
	const visibleTechs = techs.slice(0, 5);
	const overflow = techs.length - visibleTechs.length;

	const cfg = SIZE_CONFIG[size];
	const maxTitleH = Math.ceil(cfg.titleFont * 1.3 * maxLines);
	const titleRef = useRef<HTMLSpanElement>(null);

	useLayoutEffect(() => {
		const el = titleRef.current;
		if (!el) return;

		el.textContent = visitName;
		if (el.scrollHeight <= maxTitleH) return;

		let lo = 0;
		let hi = visitName.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			el.textContent = visitName.slice(0, mid) + "…";
			if (el.scrollHeight <= maxTitleH) lo = mid;
			else hi = mid - 1;
		}
		el.textContent = lo > 0 ? visitName.slice(0, lo) + "…" : "…";
	}, [visitName, maxLines, maxTitleH]);

	return (
		<div
			draggable={!!onDragStart}
			className="focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1!"
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			onClick={onClick}
			onKeyDown={
				onClick
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onClick(
									e as unknown as React.MouseEvent
								);
							}
						}
					: undefined
			}
			style={{
				display: "flex",
				alignItems: "stretch",
				borderRadius: 3,
				overflow: "hidden",
				cursor: onDragStart ? "grab" : onClick ? "pointer" : "default",
				backgroundColor: isOccurrence ? OCCURRENCE_CARD_BG : CARD_BG,
				border: `1px solid ${isOccurrence ? "var(--color-occurrence-border)" : "var(--color-primary-border)"}`,
				opacity: isDragging ? 0.4 : isGhost ? 0.5 : 1,
				userSelect: "none",
				flexShrink: 0,
				outline: isGhost ? "1px dashed var(--color-primary)" : undefined,
				outlineOffset: isGhost ? "1px" : undefined,
				boxShadow: isGhost
					? "inset 0 0 0 999px var(--color-primary-bg-dim)"
					: undefined,
			}}
		>
			{/* Priority strip — stretches to full card height */}
			<div style={{ width: cfg.stripeW, flexShrink: 0, backgroundColor: priorityColor }} />

			{/*
			 * Layout:
			 *   • The meta cluster (time + dots) is floated right at height 11px —
			 *     strictly less than one title line-height (9 × 1.3 ≈ 11.7px) so
			 *     line 2 of the title fully clears the float and extends full-width.
			 *   • The title span is display:block with NO overflow:hidden so its
			 *     line-boxes shrink around the float on line 1, then expand on line 2.
			 *   • Truncation to 2 lines with "…" is handled by the useLayoutEffect
			 *     binary search above (writing textContent directly so React's
			 *     reconciler, which sees no JSX children on the span, never clobbers it).
			 *   • maxHeight + overflow:hidden on this container is a safety-net only.
			 */}
			<div
				style={{
					flex: 1,
					minWidth: 0,
					padding: cfg.padding,
					boxSizing: "border-box",
					maxHeight: maxTitleH + 4,
					overflow: "hidden",
				}}
			>
				{/* Float declared FIRST so the title's line-boxes wrap around it */}
				{(timeLabel || hasTechs) && (
					<div
						style={{
							float: "right",
							display: "flex",
							alignItems: "center",
							gap: 4,
							height: cfg.metaH,
							marginLeft: 4,
						}}
					>
						{timeLabel && (
							<span
								style={{
									fontSize: cfg.timeFont,
									color: TEXT_MUTED,
									whiteSpace: "nowrap",
									lineHeight: 1,
								}}
							>
								{timeLabel}
							</span>
						)}

						{hasTechs && (
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 2,
								}}
							>
								{visibleTechs.map((t) => (
									<span
										key={t.id}
										style={{
											display: "block",
											width: cfg.dotSize,
											height: cfg.dotSize,
											borderRadius:
												"50%",
											backgroundColor:
												t.color,
											flexShrink: 0,
										}}
									/>
								))}
								{overflow > 0 && (
									<span
										style={{
											fontSize: cfg.overflowFont,
											color: "rgba(255,255,255,0.4)",
											lineHeight: 1,
											flexShrink: 0,
										}}
									>
										+{overflow}
									</span>
								)}
							</div>
						)}
					</div>
				)}

				{/* Title — display:block preserves float-line-box shrinking.
				    No JSX children: textContent is owned entirely by the
				    useLayoutEffect above, which also does the 2-line truncation. */}
				<span
					ref={titleRef}
					style={{
						display: "block",
						fontSize: cfg.titleFont,
						fontWeight: 600,
						color: isOccurrence
							? OCCURRENCE_TITLE
							: VISIT_TITLE,
						fontStyle: isOccurrence ? "italic" : "normal",
						lineHeight: 1.3,
					}}
				/>
			</div>
		</div>
	);
}
