import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, Clock, MapPin, UserRound, Wrench, X, type LucideIcon } from "lucide-react";
import { PriorityColors, PriorityLabels, type Priority } from "../../../types/common";
import { TOOLBAR_FOCUS } from "./toolbarButton";
import { CLICK_POPUP_H, CLICK_POPUP_W } from "./scheduleBoardUtils";
import { snapshotWhen, type SnapshotTiming } from "./snapshotWhen";

export const SNAPSHOT_CHIP =
	"inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide";

const BTN = `inline-flex h-7 items-center justify-center gap-1.5 rounded-md text-[11px] transition-colors duration-150 ease-out ${TOOLBAR_FOCUS}`;
export const SNAPSHOT_BTN_PRIMARY = `${BTN} flex-1 bg-primary font-semibold text-on-primary hover:bg-primary-hover disabled:cursor-default disabled:opacity-55 disabled:hover:bg-primary`;
export const SNAPSHOT_BTN_SECONDARY = `${BTN} flex-1 border border-border bg-surface font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary`;
const SNAPSHOT_BTN_ICON = `${BTN} w-7 shrink-0 border border-border bg-surface text-text-muted hover:bg-surface-raised hover:text-text-primary`;

type FactTone = "default" | "warn" | "muted";

interface SnapshotFact {
	key: string;
	icon: LucideIcon;
	content: ReactNode;
	tone?: FactTone;
	/** Full text for rows that truncate. */
	title?: string;
}

const TONE: Record<FactTone, string> = {
	default: "text-sched-text-secondary",
	warn: "text-warning-text",
	muted: "text-text-muted",
};

const ELEVATED_PRIORITY = new Set<Priority>(["High", "Urgent", "Emergency"]);

function textFact(key: string, icon: LucideIcon, text: string | null | undefined) {
	return text
		? [{ key, icon, content: <span className="block truncate">{text}</span>, title: text }]
		: [];
}

interface SchedulePopupShellProps {
	style: React.CSSProperties;
	popupRef?: React.RefObject<HTMLDivElement | null>;
	onClose: () => void;
	chips: ReactNode;
	/** Appended to `chips` only when above normal. */
	priority?: Priority | null;
	title: string;
	subtitle?: string | null;
	timing: SnapshotTiming;
	crew: { content: ReactNode; tone?: FactTone };
	client?: string | null;
	address?: string | null;
	description?: string | null;
	actions: ReactNode;
	/** When provided, a trailing clock button opens the reschedule popup. */
	onRescheduleClick?: () => void;
}

export default function SchedulePopupShell({
	style,
	popupRef,
	onClose,
	chips,
	priority,
	title,
	subtitle,
	timing,
	crew,
	client,
	address,
	description,
	actions,
	onRescheduleClick,
}: SchedulePopupShellProps) {
	const innerRef = useRef<HTMLDivElement | null>(null);
	const ref = popupRef ?? innerRef;
	const titleId = useId();

	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	});
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			// Another overlay (search, confirm, picker) opened on top owns this Escape.
			const layer =
				e.target instanceof Element
					? e.target.closest('[role="dialog"], [aria-modal="true"]')
					: null;
			if (layer && layer !== ref.current) return;
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [ref]);

	useEffect(() => {
		const opener = document.activeElement as HTMLElement | null;
		const node = ref.current;
		node?.focus({ preventScroll: true });
		return () => {
			const active = document.activeElement;
			// Only hand focus back if the user hasn't already moved it somewhere else.
			const stranded = !active || active === document.body || node?.contains(active);
			if (stranded && opener?.isConnected) opener.focus({ preventScroll: true });
		};
	}, [ref]);

	const when = snapshotWhen(timing);
	const facts: SnapshotFact[] = [
		{
			key: "when",
			icon: CalendarClock,
			content: (
				<>
					<span className="font-medium text-sched-text-primary">{when.date}</span>
					<span className="text-text-muted"> · </span>
					{when.time}
				</>
			),
		},
		{ key: "crew", icon: Wrench, ...crew },
		...textFact("client", UserRound, client),
		...textFact("address", MapPin, address),
	];

	const popup = (
		<div
			ref={ref}
			role="dialog"
			aria-labelledby={titleId}
			tabIndex={-1}
			className="overflow-y-auto rounded-lg border border-border bg-popup-bg p-3 text-left shadow-xl shadow-black/40 outline-none"
			// Callers clamp to CLICK_POPUP_H, so anything taller (many techs) scrolls instead of spilling off-screen.
			style={{ zIndex: 1000, width: CLICK_POPUP_W, maxHeight: CLICK_POPUP_H, ...style }}
		>
			<div className="flex items-start gap-1.5">
				<h3
					id={titleId}
					title={title}
					className="min-w-0 flex-1 line-clamp-2 text-[13px] font-semibold leading-snug break-words text-sched-text-primary"
				>
					{title}
				</h3>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className={`-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-sched-text-faint transition-colors duration-150 ease-out hover:bg-surface hover:text-text-secondary ${TOOLBAR_FOCUS}`}
				>
					<X size={13} />
				</button>
			</div>
			{subtitle && (
				<p title={subtitle} className="mt-0.5 truncate text-[11px] text-text-tertiary">
					{subtitle}
				</p>
			)}
			<div className="mt-1.5 flex flex-wrap items-center gap-1">
				{chips}
				{priority && ELEVATED_PRIORITY.has(priority) && (
					<span className={`${SNAPSHOT_CHIP} ${PriorityColors[priority]}`}>
						{PriorityLabels[priority]}
					</span>
				)}
			</div>

			<ul className="mt-2.5 space-y-1.5">
				{facts.map(({ key, icon: Icon, content, tone = "default", title: full }) => (
					<li
						key={key}
						title={full}
						className={`flex items-start gap-2 text-[11px] leading-4 ${TONE[tone]}`}
					>
						<Icon size={12} className="mt-0.5 shrink-0 text-text-muted" aria-hidden />
						<div className="min-w-0 flex-1">{content}</div>
					</li>
				))}
			</ul>

			{description && (
				<p
					title={description}
					className="mt-2.5 line-clamp-2 border-t border-border-subtle pt-2 text-[11px] leading-relaxed break-words text-text-secondary"
				>
					{description}
				</p>
			)}

			<div className="mt-3 flex gap-1.5">
				{actions}
				{onRescheduleClick && (
					<button
						type="button"
						onClick={onRescheduleClick}
						title="Edit scheduled time"
						aria-label="Edit scheduled time"
						className={SNAPSHOT_BTN_ICON}
					>
						<Clock size={12} />
					</button>
				)}
			</div>
		</div>
	);

	// A transformed ancestor (react-grid-layout dashboard widgets) re-anchors `fixed` and its
	// overflow clips the popup, so viewport-positioned callers render at <body>.
	return style.position === "fixed" ? createPortal(popup, document.body) : popup;
}
