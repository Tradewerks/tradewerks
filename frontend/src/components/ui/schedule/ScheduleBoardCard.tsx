import { Repeat } from "lucide-react";
import { getTechInitials } from "./scheduleBoardUtils";
import { CARD_METRICS, planCardLayout, type CardLayout } from "./cardLayout";
import type { AssignedTech, CardModel, ConstraintView } from "./cardModel";
import { VisitStatusLabels, type VisitStatus } from "../../../types/jobs";
import {
	CARD_BG,
	OCCURRENCE_CARD_BG,
	TEXT_PRIMARY,
	TEXT_CLIENT,
	TEXT_TIME,
	TEXT_MUTED,
	TEXT_FAINT,
	OCCURRENCE_TITLE,
	CARD_SHADOW,
	CARD_SHADOW_HOVERED,
	OCCURRENCE_SHADOW_HOVERED,
	OPEN_ENDED_GRADIENT,
	OPEN_ENDED_DASH,
	CHIP_BG,
	CHIP_TEXT,
	WINDOW_CHIP_BG,
	WINDOW_CHIP_TEXT,
	WINDOW_TICK,
	STRIP_WINDOW_ALPHA,
	VISIT_STATUS_COLOR,
} from "./scheduleTokens";


interface ScheduleBoardCardProps {
	cardId: string;
	model: CardModel;
	isHovered?: boolean;
	/** Applied to the root element; used for ghost-card drag feedback. */
	opacity?: number;
	/** Occurrence is generating a visit — not grabbable. */
	busy?: boolean;
	top: number;
	height: number;
	left: number;
	width: number;
	zIndex: number;
	onClick: (e: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => void;
	onMouseEnter: () => void;
	onMouseLeave: (e: React.MouseEvent) => void;
	onDragStart: (e: React.DragEvent) => void;
}

const M = CARD_METRICS;
const PAD_X = M.H_PAD / 2;
const PAD_Y = M.V_PAD / 2;
const DIM_OPACITY = 0.4;

const chipBase: React.CSSProperties = {
	height: M.CHIP_H,
	lineHeight: `${M.CHIP_H}px`,
	padding: "0 4px",
	borderRadius: 3,
	boxSizing: "border-box",
	fontSize: 9,
	fontWeight: 600,
	whiteSpace: "nowrap",
};

const titleTone = (isOcc: boolean): React.CSSProperties => ({
	fontSize: 11,
	fontWeight: 600,
	fontStyle: isOcc ? "italic" : "normal",
	color: isOcc ? OCCURRENCE_TITLE : TEXT_PRIMARY,
});

export default function ScheduleBoardCard({
	cardId,
	model,
	isHovered = false,
	opacity = 1,
	busy = false,
	top,
	height,
	left,
	width,
	zIndex,
	onClick,
	onMouseEnter,
	onMouseLeave,
	onDragStart,
}: ScheduleBoardCardProps) {
	const layout = planCardLayout(model, width, height);
	const isOcc = model.kind === "occurrence";
	const { constraint } = model;
	const bg = isOcc ? OCCURRENCE_CARD_BG : CARD_BG;

	return (
		<div
			draggable
			role="button"
			tabIndex={0}
			aria-label={model.ariaLabel}
			data-card-id={cardId}
			data-card-kind={model.kind}
			data-card-mode={layout.mode}
			onDragStart={onDragStart}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onClick(e);
				}
			}}
			onMouseEnter={onMouseEnter}
			onMouseLeave={onMouseLeave}
			style={{
				position: "absolute",
				top,
				left,
				width,
				height,
				zIndex,
				backgroundColor: bg,
				borderRadius: 4,
				overflow: "hidden",
				cursor: busy ? "default" : "grab",
				boxSizing: "border-box",
				display: "flex",
				opacity,
				pointerEvents: opacity === 0 ? "none" : "auto",
				transition: "box-shadow 0.15s ease-out, transform 0.15s ease-out, opacity 0.1s ease-out",
				boxShadow: isHovered
					? isOcc
						? OCCURRENCE_SHADOW_HOVERED
						: CARD_SHADOW_HOVERED
					: CARD_SHADOW,
				transform: isHovered ? "translateY(-1px)" : "none",
			}}
		>
			<PriorityStrip color={model.priorityColor} band={constraint.windowBand} />

			<div style={{ flex: 1, minWidth: 0, overflow: "hidden", position: "relative" }}>
				{layout.mode === "sliver" && <SliverBody model={model} layout={layout} />}
				{layout.mode === "inline" && <InlineBody model={model} layout={layout} />}
				{layout.mode === "column" && <ColumnBody model={model} layout={layout} />}

				{constraint.deadlineTick !== undefined && (
					<div
						data-card-tick
						style={{
							position: "absolute",
							left: 0,
							right: 0,
							top: `${constraint.deadlineTick * 100}%`,
							height: 0,
							borderTop: `1px dashed ${WINDOW_TICK}`,
							pointerEvents: "none",
						}}
					/>
				)}

				{constraint.openEnded && (
					<>
						<div
							data-card-open-end
							style={{
								position: "absolute",
								bottom: 0,
								left: 0,
								right: 0,
								height: 20,
								background: OPEN_ENDED_GRADIENT,
								pointerEvents: "none",
							}}
						/>
						<div
							style={{
								position: "absolute",
								bottom: 0,
								left: 0,
								right: 0,
								height: 3,
								boxSizing: "border-box",
								borderBottom: `3px dashed ${OPEN_ENDED_DASH}`,
								pointerEvents: "none",
							}}
						/>
					</>
				)}

				{model.stockWarning && (
					<div
						data-card-stock={model.stockWarning}
						style={{
							position: "absolute",
							top: 3,
							right: 3,
							width: 9,
							height: 9,
							borderRadius: "50%",
							backgroundColor:
								model.stockWarning === "out" ? "var(--color-error)" : "var(--color-warning)",
							boxShadow: `0 0 0 1.5px ${bg}`,
							pointerEvents: "none",
							zIndex: 1,
						}}
					/>
				)}
			</div>
		</div>
	);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type BodyProps = { model: CardModel; layout: CardLayout };

function StripSegment({
	color,
	from,
	to,
	tentative,
}: {
	color: string;
	from: number;
	to: number;
	tentative: boolean;
}) {
	return (
		<div
			{...(tentative ? { "data-card-strip-band": "" } : { "data-card-strip-solid": "" })}
			style={{
				position: "absolute",
				left: 0,
				right: 0,
				top: `${from * 100}%`,
				height: `${(to - from) * 100}%`,
				backgroundColor: color,
				opacity: tentative ? STRIP_WINDOW_ALPHA : 1,
			}}
		/>
	);
}

/**
 * Solid where the tech should be on site; faded across a `between` window, where arrival is
 * uncertain.
 */
function PriorityStrip({ color, band }: { color: string; band: ConstraintView["windowBand"] }) {
	const win = band && band.to > band.from ? band : null;
	return (
		<div data-card-strip style={{ width: M.STRIP_W, flexShrink: 0, position: "relative" }}>
			{win ? (
				<>
					{win.from > 0 && (
						<StripSegment color={color} from={0} to={win.from} tentative={false} />
					)}
					<StripSegment color={color} from={win.from} to={win.to} tentative />
					{win.to < 1 && (
						<StripSegment color={color} from={win.to} to={1} tentative={false} />
					)}
				</>
			) : (
				<StripSegment color={color} from={0} to={1} tentative={false} />
			)}
		</div>
	);
}

function ConstraintChip({ text, tone }: { text: string; tone: ConstraintView["tone"] }) {
	return (
		<span
			data-card-chip
			style={{
				...chipBase,
				display: "inline-block",
				minWidth: 0,
				maxWidth: "100%",
				overflow: "hidden",
				textOverflow: "ellipsis",
				flexShrink: 1,
				backgroundColor: tone === "window" ? WINDOW_CHIP_BG : CHIP_BG,
				color: tone === "window" ? WINDOW_CHIP_TEXT : CHIP_TEXT,
			}}
		>
			{text}
		</span>
	);
}

function StatusPill({ status }: { status: VisitStatus }) {
	return (
		<span
			data-card-status
			style={{
				...chipBase,
				display: "inline-flex",
				alignItems: "center",
				gap: 3,
				flexShrink: 0,
				backgroundColor: CHIP_BG,
				color: CHIP_TEXT,
			}}
		>
			<span
				style={{
					width: 5,
					height: 5,
					borderRadius: "50%",
					backgroundColor: VISIT_STATUS_COLOR[status],
				}}
			/>
			{VisitStatusLabels[status]}
		</span>
	);
}

function PlanMark({ color }: { color: string }) {
	return (
		<Repeat
			size={9}
			aria-hidden
			data-card-plan-mark
			style={{ color, flexShrink: 0, marginRight: 3, verticalAlign: "-1px", display: "inline-block" }}
		/>
	);
}

function SecondaryRow({ kind, text, color }: { kind: string; text: string; color: string }) {
	return (
		<span
			data-card-row={kind}
			style={{
				flexShrink: 0,
				height: M.SECONDARY_LH,
				fontSize: 10,
				lineHeight: `${M.SECONDARY_LH}px`,
				color,
				whiteSpace: "nowrap",
				overflow: "hidden",
				textOverflow: "ellipsis",
			}}
		>
			{text}
		</span>
	);
}

function SliverBody({ model, layout }: BodyProps) {
	const flexible = model.constraint.tone === "window";
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				height: "100%",
				padding: `${PAD_Y}px ${PAD_X}px`,
				gap: M.ROW_GAP,
				overflow: "hidden",
				boxSizing: "border-box",
			}}
		>
			<span
				data-card-chip
				style={{
					fontSize: 9,
					fontWeight: 600,
					lineHeight: `${M.SECONDARY_LH}px`,
					color: flexible ? WINDOW_CHIP_TEXT : TEXT_TIME,
					whiteSpace: "nowrap",
				}}
			>
				{model.constraint.chip.sliver}
			</span>
			{layout.maxDots > 0 && <TechDots techs={model.techs} max={layout.maxDots} vertical />}
		</div>
	);
}

function InlineBody({ model, layout }: BodyProps) {
	const isOcc = model.kind === "occurrence";
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				height: "100%",
				padding: `0 ${PAD_X}px`,
				gap: 4,
				overflow: "hidden",
			}}
		>
			<span style={{ flexShrink: 0, display: "flex" }}>
				<ConstraintChip text={model.constraint.chip.inline} tone={model.constraint.tone} />
			</span>
			<span
				data-card-title
				style={{
					...titleTone(isOcc),
					flex: 1,
					minWidth: 0,
					whiteSpace: "nowrap",
					overflow: "hidden",
					textOverflow: "ellipsis",
					lineHeight: 1,
				}}
			>
				{model.title}
			</span>
			{layout.maxDots > 0 && <TechDots techs={model.techs} max={layout.maxDots} />}
		</div>
	);
}

function ColumnBody({ model, layout }: BodyProps) {
	const isOcc = model.kind === "occurrence";
	const { constraint } = model;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				height: "100%",
				padding: `${PAD_Y}px ${PAD_X}px ${PAD_Y + (constraint.openEnded ? M.OPEN_END_PAD : 0)}px`,
				gap: M.ROW_GAP,
				boxSizing: "border-box",
				overflow: "hidden",
			}}
		>
			{layout.chip && (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 3,
						height: M.CHIP_H,
						minWidth: 0,
						flexShrink: 0,
					}}
				>
					<ConstraintChip text={constraint.chip.column} tone={constraint.tone} />
					{model.status && <StatusPill status={model.status} />}
					{model.fromPlan && !isOcc && <PlanMark color={TEXT_MUTED} />}
				</div>
			)}

			{layout.titleLines > 0 && (
				<span
					data-card-title
					style={{
						...titleTone(isOcc),
						flexShrink: 0,
						lineHeight: `${M.TITLE_LH}px`,
						maxHeight: layout.titleLines * M.TITLE_LH,
						letterSpacing: "-0.01em",
						overflow: "hidden",
						overflowWrap: "anywhere",
						display: "-webkit-box",
						WebkitBoxOrient: "vertical",
						WebkitLineClamp: layout.titleLines,
					}}
				>
					<span>
						{isOcc && <PlanMark color={OCCURRENCE_TITLE} />}
						{model.title}
					</span>
				</span>
			)}

			{layout.client && model.client && (
				<SecondaryRow kind="client" text={model.client} color={TEXT_CLIENT} />
			)}
			{layout.address && model.address && (
				<SecondaryRow kind="address" text={model.address} color={TEXT_CLIENT} />
			)}
			{layout.ref && model.ref && <SecondaryRow kind="ref" text={model.ref} color={TEXT_TIME} />}

			{layout.descriptionLines > 0 && model.description && (
				<span
					data-card-description
					style={{
						flexShrink: 0,
						fontSize: 10,
						lineHeight: `${M.SECONDARY_LH}px`,
						maxHeight: layout.descriptionLines * M.SECONDARY_LH,
						color: TEXT_MUTED,
						overflow: "hidden",
						overflowWrap: "anywhere",
						display: "-webkit-box",
						WebkitBoxOrient: "vertical",
						WebkitLineClamp: layout.descriptionLines,
					}}
				>
					{model.description}
				</span>
			)}

			{layout.tech !== "none" && (
				<div style={{ marginTop: "auto", flexShrink: 0, display: "flex", minWidth: 0 }}>
					{layout.tech === "unassigned" && (
						<span
							data-card-unassigned
							style={{
								fontSize: 9,
								lineHeight: `${M.UNASSIGNED_H}px`,
								height: M.UNASSIGNED_H,
								fontStyle: "italic",
								color: TEXT_FAINT,
								whiteSpace: "nowrap",
								opacity: model.unassignedInFilter ? 1 : DIM_OPACITY,
							}}
						>
							Unassigned
						</span>
					)}
					{layout.tech === "bubbles" && <TechBubbles techs={model.techs} />}
					{layout.tech === "dots" && <TechDots techs={model.techs} max={layout.maxDots} />}
				</div>
			)}
		</div>
	);
}

function TechDots({
	techs,
	max,
	vertical = false,
}: {
	techs: AssignedTech[];
	max: number;
	vertical?: boolean;
}) {
	const visible = techs.slice(0, max);
	const overflow = techs.length - visible.length;
	return (
		<div
			style={{
				display: "flex",
				flexDirection: vertical ? "column" : "row",
				alignItems: "center",
				gap: M.DOT_GAP,
				flexShrink: 0,
			}}
		>
			{visible.map((t) => (
				<span
					key={t.id}
					data-card-tech
					data-in-filter={String(t.inFilter)}
					style={{
						width: M.DOT_SZ,
						height: M.DOT_SZ,
						borderRadius: "50%",
						backgroundColor: t.color,
						flexShrink: 0,
						opacity: t.inFilter ? 1 : DIM_OPACITY,
					}}
				/>
			))}
			{overflow > 0 && !vertical && (
				<span style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1, flexShrink: 0 }}>
					+{overflow}
				</span>
			)}
		</div>
	);
}

function TechBubbles({ techs }: { techs: AssignedTech[] }) {
	return (
		<div style={{ display: "flex", gap: M.BUBBLE_GAP, overflow: "hidden" }}>
			{techs.map((t) => (
				<span
					key={t.id}
					data-card-tech
					data-in-filter={String(t.inFilter)}
					style={{
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						width: M.BUBBLE_SZ,
						height: M.BUBBLE_SZ,
						borderRadius: "50%",
						fontSize: 7,
						fontWeight: 700,
						flexShrink: 0,
						backgroundColor: t.inFilter ? t.color : `color-mix(in srgb, ${t.color} 13%, transparent)`,
						color: t.inFilter ? "#fff" : t.color,
						border: t.inFilter ? "none" : `1px solid color-mix(in srgb, ${t.color} 33%, transparent)`,
					}}
				>
					{getTechInitials(t.name)}
				</span>
			))}
		</div>
	);
}
