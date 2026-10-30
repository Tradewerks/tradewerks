import type { StaffChange, TierRow } from "../types";

// surface-inset is the canvas colour in dark mode, so an inset fill vanished; the border
// carries the shape wherever the fill alone can't.
export const chip =
	"rounded border border-border bg-surface-raised px-1.5 py-0.5 text-xs text-text-secondary";
// For chips sitting on the page canvas (record headers), where surface-raised barely differs.
export const canvasChip =
	"rounded border border-border bg-base px-1.5 py-0.5 text-xs text-text-secondary";
export const smallButton =
	"h-8 shrink-0 rounded-md border border-border px-3 text-sm text-text-secondary transition-colors duration-150 ease-out hover:enabled:border-border-strong hover:enabled:bg-surface-raised hover:enabled:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed";
export const dangerButton =
	"h-8 shrink-0 rounded-md border border-border px-3 text-sm text-error-text transition-colors duration-150 ease-out hover:enabled:border-error-border hover:enabled:bg-error-bg disabled:opacity-40 disabled:cursor-not-allowed";
export const primaryButton =
	"h-8 rounded-md bg-primary-hover px-3 text-sm font-medium text-on-primary transition-colors duration-150 ease-out hover:enabled:bg-primary-active disabled:opacity-40 disabled:cursor-not-allowed";
export const pageAction =
	"flex items-center gap-2 px-4 py-2 bg-primary-hover hover:enabled:bg-primary-active rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
export const onPill = "rounded px-1.5 py-0.5 text-xs bg-success/10 text-success-text";
const offPill = "rounded px-1.5 py-0.5 text-xs bg-error/10 text-error-text";
/** `projected` colours an Off as a loss; a current Off stays neutral. */
export const statePill = (on: boolean, projected = false) =>
	on ? onPill : projected ? offPill : chip;
// Reuses ActivityFeed's flash so "this just changed" reads the same app-wide.
export const flash = "motion-safe:animate-[feedFlash_600ms_ease-out]";

export type OpenChange = (d: { change: StaffChange; title: string }) => void;

export const shortDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});

export const isAssignable = (t: Pick<TierRow, "assignable" | "archived_at">) =>
	t.assignable && !t.archived_at;
export const assignable = (tiers: TierRow[]) => tiers.filter(isAssignable);
export function versionLabel(tiers: TierRow[], versionId: string | null) {
	for (const t of tiers) {
		const v = t.versions.find((x) => x.id === versionId);
		if (v) return `${t.label} v${v.version}`;
	}
	return null;
}
export function defaultTrialDate() {
	const d = new Date(Date.now() + 14 * 86_400_000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
