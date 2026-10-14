import type { DragEvent, KeyboardEvent, MouseEvent } from "react";
import { CARD_BG, OCCURRENCE_CARD_BG, OCCURRENCE_TITLE, VISIT_TITLE } from "./scheduleTokens";

const DOT_CAP = 3;

function TechDot({ color }: { color: string }) {
	return <span className="block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />;
}

export interface AgendaRowProps {
	anytime: boolean;
	showTime: boolean;
	time: string;
	suffix: string;
	title: string;
	priorityColor: string;
	isOccurrence: boolean;
	techs: { id: string; color: string }[];
	who: string | null;
	isDragging?: boolean;
	isGhost?: boolean;
	onClick: (e: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void;
	onDragStart: (e: DragEvent) => void;
	onDragEnd: () => void;
}

export default function AgendaRow({
	anytime,
	showTime,
	time,
	suffix,
	title,
	priorityColor,
	isOccurrence,
	techs,
	who,
	isDragging = false,
	isGhost = false,
	onClick,
	onDragStart,
	onDragEnd,
}: AgendaRowProps) {
	const when = anytime ? "Anytime" : `${time} ${suffix}`.trim();
	// "who" shows as dots only; the names stay in aria-label.
	const dots =
		who === null
			? []
			: techs.length > 0
				? techs
				: [{ id: "unassigned", color: "var(--color-tech-unassigned)" }];

	function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		onClick(e);
	}

	return (
		<div className="flex gap-1.5 items-stretch">
			<div
				data-agenda-rail
				aria-hidden
				className="w-11 shrink-0 flex justify-end items-baseline gap-0.5 tabular-nums pt-1"
			>
				{showTime &&
					(anytime ? (
						<span className="text-[9px] font-semibold text-text-tertiary">Anytime</span>
					) : (
						<>
							<span className="text-[10px] font-semibold text-text-secondary">{time}</span>
							{suffix && (
								<span className="text-[8px] font-medium text-text-tertiary">{suffix}</span>
							)}
						</>
					))}
			</div>
			<div
				data-agenda-row
				role="button"
				tabIndex={0}
				draggable
				aria-label={`${when}, ${title}${who !== null ? `, ${who}` : ""}`}
				title={title}
				onClick={onClick}
				onKeyDown={onKeyDown}
				onDragStart={onDragStart}
				onDragEnd={onDragEnd}
				className="flex-1 min-w-0 flex rounded-[3px] overflow-hidden cursor-grab select-none focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-1!"
				style={{
					backgroundColor: isOccurrence ? OCCURRENCE_CARD_BG : CARD_BG,
					border: `1px solid ${isOccurrence ? "var(--color-occurrence-border)" : "var(--color-primary-border)"}`,
					opacity: isDragging ? 0.4 : isGhost ? 0.5 : 1,
					outline: isGhost ? "1px dashed var(--color-primary)" : undefined,
					outlineOffset: isGhost ? "1px" : undefined,
					boxShadow: isGhost ? "inset 0 0 0 999px var(--color-primary-bg-dim)" : undefined,
				}}
			>
				<div style={{ width: 4, flexShrink: 0, backgroundColor: priorityColor }} />
				<div className="flex-1 min-w-0 flex items-start gap-1.5 pr-2 pl-1.5 py-[3px]">
					<span
						data-agenda-title
						className="flex-1 min-w-0 line-clamp-2 break-words text-[11px] font-semibold leading-[1.3]"
						style={{
							color: isOccurrence ? OCCURRENCE_TITLE : VISIT_TITLE,
							fontStyle: isOccurrence ? "italic" : "normal",
						}}
					>
						{title}
					</span>
					{/* Dots sit on the title's first line (11px × 1.3 leading). */}
					{dots.length > 0 && (
						<span
							data-agenda-dots
							aria-hidden
							className="shrink-0 h-[14px] flex items-center gap-0.5"
						>
							{dots.slice(0, DOT_CAP).map((t) => (
								<TechDot key={t.id} color={t.color} />
							))}
							{dots.length > DOT_CAP && (
								<span className="text-[9px] font-medium text-text-muted">
									+{dots.length - DOT_CAP}
								</span>
							)}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
