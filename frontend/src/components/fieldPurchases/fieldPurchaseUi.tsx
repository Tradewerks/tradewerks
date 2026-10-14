import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
	COL_LABEL,
	FOCUS_RING,
	ageLabel,
	ageTone,
	hoursWaiting,
	spokenAge,
} from "./fieldPurchaseFormat";
import { FLAG_META, flagsBySeverity, type FieldPurchaseFlag } from "../../types/fieldPurchases";

/**
 * Shared vocabulary for the field-purchase surfaces. Queue row, review panel and
 * grants panel all speak in the same chips, so the pieces live here rather than
 * being re-declared per file with a one-pixel difference. Formatting and
 * thresholds live next door in fieldPurchaseFormat.ts, which keeps this module a
 * clean fast-refresh boundary.
 */

// ── Age ──────────────────────────────────────────────────────────────────────

export function AgeChip({ since, className }: { since: string | null; className?: string }) {
	const hours = hoursWaiting(since);
	if (hours === null) return null;
	const tone = ageTone(hours);
	const toneClass =
		tone === "error"
			? "border-error-border bg-error-bg text-error-text"
			: tone === "warning"
				? "border-warning-border bg-warning-bg text-warning-text"
				: "border-transparent text-text-tertiary";
	return (
		<span
			title={`Waiting since ${new Date(since!).toLocaleString()}`}
			// "12h" is an abbreviation and the tone carries the urgency, neither of
			// which survives being read aloud. The `title` said it in full already
			// and was reachable by neither a screen reader nor a touch device.
			// See FlagChip on why the role is required for the label to survive.
			role="img"
			aria-label={`Waiting ${spokenAge(hours)}, since ${new Date(since!).toLocaleString()}`}
			className={`inline-flex h-4 flex-shrink-0 items-center rounded border px-1 text-[10px] font-semibold tabular-nums ${toneClass} ${className ?? ""}`}
		>
			{ageLabel(hours)}
		</span>
	);
}

// ── Flags ────────────────────────────────────────────────────────────────────

// At 10px each of these has to clear 4.5:1 — text-muted on surface-raised lands
// at 4.07 and reads as a smudge on the selected row.
const FLAG_TONE = {
	high: "border-error-border bg-error-bg text-error-text",
	medium: "border-warning-border bg-warning-bg text-warning-text",
	low: "border-border bg-surface-raised text-text-secondary",
} as const;

/**
 * Names the worst flag instead of counting them. "2" told a dispatcher nothing
 * about whether to open the row now or after lunch.
 */
export function FlagChip({ flags }: { flags: FieldPurchaseFlag[] }) {
	const ranked = flagsBySeverity(flags);
	const worst = ranked[0];
	if (!worst) return null;
	const meta = FLAG_META[worst.code] ?? { label: worst.code, severity: "low" as const };
	const extra = ranked.length - 1;
	return (
		<span
			title={ranked.map((f) => f.message).join("\n")}
			// The chip shows the worst flag and a count, so "+2" is the only trace of
			// findings meant to be acted on; every message sat in `title`, which touch
			// and AT cannot reach. Worst first, so the spoken list matches the count.
			// `role="img"` is what makes the label carry - name-from-author is
			// prohibited on a bare span's implicit `generic` role, so Chromium drops it.
			role="img"
			aria-label={`${ranked.length} flag${ranked.length === 1 ? "" : "s"}: ${ranked
				.map((f) => f.message)
				.join("; ")}`}
			className={`inline-flex h-5 max-w-full items-center gap-1 rounded border px-1.5 text-[10px] font-medium ${FLAG_TONE[meta.severity]}`}
		>
			<AlertTriangle size={10} aria-hidden className="flex-shrink-0" />
			<span className="truncate">{meta.label}</span>
			{/* No opacity: dimming an already-small label is what drops it under 3:1. */}
			{extra > 0 && <span className="tabular-nums">+{extra}</span>}
		</span>
	);
}

// ── Generic chip ─────────────────────────────────────────────────────────────

export type ChipTone = "neutral" | "primary" | "warning" | "error" | "success";

const CHIP_TONE: Record<ChipTone, string> = {
	neutral: "border-border bg-surface-raised text-text-secondary",
	primary: "border-primary-border bg-primary-bg text-primary-text",
	warning: "border-warning-border bg-warning-bg text-warning-text",
	error: "border-error-border bg-error-bg text-error-text",
	success: "border-success-border bg-success-bg text-success-text",
};

export function Chip({
	tone = "neutral",
	icon,
	children,
	title,
}: {
	tone?: ChipTone;
	icon?: ReactNode;
	children: ReactNode;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={`inline-flex h-5 items-center gap-1 rounded border px-1.5 text-[11px] font-medium ${CHIP_TONE[tone]}`}
		>
			{/* Hidden here rather than at every call site: the icon restates the
			    label beside it, and there are dozens of callers. */}
			{icon && <span aria-hidden>{icon}</span>}
			{children}
		</span>
	);
}

// ── Buttons ──────────────────────────────────────────────────────────────────

/**
 * `components/ui/Button.tsx` is a presentational icon+label div with no click
 * target and no variants, so the decision bar needs a real one. Kept local to the
 * field-purchase surfaces rather than promoted, until a second caller wants it.
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Record<ButtonVariant, string> = {
	primary:
		"bg-primary-hover text-on-primary hover:enabled:bg-primary-active border border-transparent",
	secondary:
		"border border-border bg-base text-text-secondary hover:enabled:bg-surface-raised hover:enabled:text-text-primary",
	danger: "border border-error-border bg-transparent text-error-text hover:enabled:bg-error-bg",
	ghost:
		"border border-transparent text-text-muted hover:enabled:bg-surface-raised hover:enabled:text-text-primary",
};

export function ActionButton({
	variant = "secondary",
	icon,
	children,
	onClick,
	disabled,
	title,
	className,
	fullWidth,
}: {
	variant?: ButtonVariant;
	icon?: ReactNode;
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	title?: string;
	className?: string;
	fullWidth?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={title}
			className={`inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${VARIANT[variant]} ${FOCUS_RING} ${fullWidth ? "flex-1" : ""} ${className ?? ""}`}
		>
			{/* Decorative by contract: the verb is the button's text. */}
			{icon && <span aria-hidden>{icon}</span>}
			{children}
		</button>
	);
}

// ── Layout atoms ─────────────────────────────────────────────────────────────

export function SectionBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-4 py-1.5">
			<span className={COL_LABEL}>{children}</span>
			{right}
		</div>
	);
}

export function MetaCell({
	label,
	value,
	tone,
}: {
	label: string;
	value: ReactNode;
	tone?: "muted";
}) {
	return (
		<div className="min-w-0">
			<span className={`block ${COL_LABEL}`}>{label}</span>
			{/* Vendor and technician names read here; a cut tail is the half a
			    reviewer needs, so the cell grows instead. */}
			<span
				className={`block break-words text-sm ${tone === "muted" ? "text-text-muted" : "text-text-secondary"}`}
			>
				{value}
			</span>
		</div>
	);
}
