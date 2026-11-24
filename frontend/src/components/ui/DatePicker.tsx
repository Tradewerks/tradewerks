import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import { Calendar, X, RotateCcw } from "lucide-react";
import { format } from "date-fns";
import "react-day-picker/dist/style.css";

type DatePickerProps = {
	value: Date | null;
	onChange: (date: Date | null) => void;
	required?: boolean;
	disabled?: boolean;
	mode?: "create" | "edit";
	originalValue?: Date | null;
	onClear?: () => void;
	align?: "left" | "right";
	position?: "above" | "below" | "auto";
	/** portal option for formwizard since it goes off the display */
	portal?: boolean;
	/** Days before this are not selectable. */
	minDate?: Date;
};

export default function DatePicker({
	value,
	onChange,
	required = false,
	disabled,
	mode = "create",
	originalValue,
	onClear,
	align = "left",
	position = "auto",
	portal = false,
	minDate,
}: DatePickerProps) {
	const [open, setOpen] = useState(false);
	const [ready, setReady] = useState(false);
	const [calculatedPosition, setCalculatedPosition] = useState<"above" | "below">("below");
	// Portal mode only: coords measured off the trigger, since a portaled popup
	// has no positioned ancestor to anchor to.
	const [popupStyle, setPopupStyle] = useState<React.CSSProperties>({});

	const buttonRef = useRef<HTMLButtonElement>(null);
	const calendarRef = useRef<HTMLDivElement>(null);

	const isEdit = mode === "edit";
	const hasOriginal = originalValue !== undefined && originalValue !== null;
	const isDirty = isEdit && hasOriginal && value?.getTime() !== originalValue?.getTime();

	useEffect(() => {
		if (!open) {
			setReady(false);
			return;
		}

		// Calculate based on available space
		const CAL_H = 350;
		const rect = buttonRef.current!.getBoundingClientRect();
		const hasSpaceBelow = window.innerHeight - rect.bottom >= CAL_H;

		if (position === "auto") {
			setCalculatedPosition(hasSpaceBelow ? "below" : "above");
		}

		if (portal) {
			const GAP = 4;
			const MARGIN = 8;
			const hasSpaceAbove = rect.top >= CAL_H;
			// A fixed popup escapes the modal but not the viewport, so treat
			// `position` as a preference and flip when the chosen side has no room.
			const wanted = position === "auto" ? (hasSpaceBelow ? "below" : "above") : position;
			const side =
				wanted === "below"
					? hasSpaceBelow || !hasSpaceAbove
						? "below"
						: "above"
					: hasSpaceAbove || !hasSpaceBelow
						? "above"
						: "below";

			setPopupStyle({
				position: "fixed",
				...(side === "below"
					? {
							top: rect.bottom + GAP,
							maxHeight: window.innerHeight - rect.bottom - GAP - MARGIN,
						}
					: {
							bottom: window.innerHeight - rect.top + GAP,
							maxHeight: rect.top - GAP - MARGIN,
						}),
				// Anchoring the far edge to the viewport right-aligns without
				// having to measure the calendar's own width.
				...(align === "left"
					? { left: rect.left }
					: { right: Math.max(MARGIN, window.innerWidth - rect.right) }),
				overflowY: "auto",
			});
		}

		requestAnimationFrame(() => setReady(true));
	}, [open, position, align, portal]);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			const inBtn = buttonRef.current?.contains(e.target as Node);
			const inCal = calendarRef.current?.contains(e.target as Node);
			if (!inBtn && !inCal) setOpen(false);
		};
		document.addEventListener("click", handler, true);
		return () => document.removeEventListener("click", handler, true);
	}, [open]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		const onScroll = () => setOpen(false);
		window.addEventListener("keydown", onKey);
		window.addEventListener("scroll", onScroll, true);
		// Portal coords are measured once on open, so a resize would leave the
		// calendar stranded away from its trigger.
		if (portal) window.addEventListener("resize", onScroll);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", onScroll, true);
			if (portal) window.removeEventListener("resize", onScroll);
		};
	}, [open, portal]);

	const handleClear = (e: React.MouseEvent) => {
		e.stopPropagation();
		onChange(null);
		onClear?.();
		setOpen(false);
	};

	const handleUndo = (e: React.MouseEvent) => {
		e.stopPropagation();
		if (originalValue !== undefined) {
			onChange(originalValue);
			setOpen(false);
		}
	};

	const finalPosition = position === "auto" ? calculatedPosition : position;

	// Portal mode gets its placement from popupStyle (position:fixed) and needs a
	// z-index above the modal layers (backdrop 4000 / panel 5000).
	const popupClasses = portal
		? "z-[6000] bg-canvas border border-border rounded-sm shadow-xl p-0.5"
		: `
    absolute z-50 bg-canvas border border-border
    rounded-sm shadow-xl p-0.5
    ${finalPosition === "above" ? "bottom-full mb-1" : "top-full mt-1"}
    ${align === "left" ? "left-0" : "right-0"}
  `;

	return (
		<div className="relative w-full">
			<style>{`
        .date-picker-dark {
  --rdp-accent-color: var(--color-primary);
  --rdp-background-color: var(--color-base);
  --rdp-accent-background-color: var(--color-primary-active);
  color: var(--color-text-on-surface);
  border-radius: 4px;
  pointer-events: auto !important;
  overscroll-behavior: contain;
  font-size: 0.75rem;
}
.date-picker-dark .rdp-month_caption {
  color: var(--color-text-on-surface);
  font-weight: 600;
  padding: 0 0 0 0.5rem;
  margin-bottom: 0.15rem;
  font-size: 0.8rem;
}
.date-picker-dark .rdp-weekdays { padding: 0 0.1rem; }
.date-picker-dark .rdp-weekday {
  color: var(--color-text-tertiary);
  font-size: 0.65rem;
  padding: 0.05rem 0.1rem;
  width: 1.8rem;
}
.date-picker-dark .rdp-day {
  width: 1.8rem;
  height: 1.8rem;
}
.date-picker-dark .rdp-day_button {
  width: 1.6rem;
  height: 1.6rem;
  padding: 0;
  border-radius: 3px;
  font-size: 0.72rem;
  line-height: 1rem;
}
.date-picker-dark .rdp-day_button:hover:not([disabled]):not(.rdp-day_selected) {
  background-color: var(--color-surface);
}
.date-picker-dark .rdp-day_button.rdp-day_selected {
  background-color: var(--color-primary);
  color: white;
}
.date-picker-dark .rdp-day_button.rdp-day_today:not(.rdp-day_selected) {
  color: var(--color-primary);
  font-weight: 600;
}
.date-picker-dark .rdp-day_button:disabled { opacity: 0.25; }
.date-picker-dark .rdp-nav_button {
  padding: 0.15rem;
  border-radius: 4px;
  color: var(--color-text-on-surface);
  width: 1.4rem;
  height: 1.4rem;
}
.date-picker-dark .rdp-nav_button:hover { background-color: var(--color-surface); }
.date-picker-dark .rdp-months { padding: 0.25rem; }
.date-picker-dark .rdp-month { width: 100%; }
.date-picker-dark .rdp-caption_label { font-size: 0.8rem; }
      `}</style>

			<button
				ref={buttonRef}
				type="button"
				disabled={disabled}
				onClick={() => setOpen((o) => !o)}
				className="border border-border bg-base px-2.5 h-[34px] w-full rounded text-left
					flex items-center justify-between hover:border-border-strong focus:border-primary focus:outline-none
					transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm lg:text-base"
			>
				<span className={!value ? "text-text-muted" : "text-text-primary"}>
					{!value ? "Select date..." : format(value, "MMMM dd, yyyy")}
				</span>

				<div className="flex items-center gap-1">
					{/* Undo: shown when editing and dirty (regardless of required) */}
					{isEdit && isDirty && !disabled && (
						<span
							onClick={handleUndo}
							title="Undo"
							className="hover:bg-surface rounded p-0.5 transition-colors cursor-pointer inline-flex"
						>
							<RotateCcw className="h-3 w-3 text-text-tertiary hover:text-text-primary" />
						</span>
					)}

					{/* Clear: shown when NOT required, has value, and not disabled */}
					{!required && value && !disabled && (
						<span
							onClick={handleClear}
							title="Clear"
							className="hover:bg-surface rounded p-0.5 transition-colors cursor-pointer inline-flex"
						>
							<X className="h-3 w-3 text-text-tertiary hover:text-text-primary" />
						</span>
					)}

					<Calendar className="h-4 w-4 text-text-muted" />
				</div>
			</button>

			{open &&
				ready &&
				(() => {
					const calendar = (
						<div
							ref={calendarRef}
							className={popupClasses}
							style={portal ? popupStyle : undefined}
						>
							<DayPicker
								mode="single"
								selected={value || undefined}
								onSelect={(date) => {
									onChange(date ?? null);
									setOpen(false);
								}}
								disabled={minDate ? { before: minDate } : undefined}
								className="date-picker-dark"
							/>
						</div>
					);
					// The portal keeps the calendar in this React tree, so clicks still
					// bubble to the modal's stopPropagation guard and won't close it.
					return portal ? createPortal(calendar, document.body) : calendar;
				})()}
		</div>
	);
}
