import type { StaffChange, TierRow } from "../types";

export const chip = "rounded px-1.5 py-0.5 text-xs bg-surface-inset text-text-secondary";
export const card = "space-y-3 rounded-lg border border-border bg-surface p-4";
export const cardTitle = "text-sm font-semibold text-text-primary";
export const textButton =
	"text-sm text-primary hover:underline disabled:opacity-50 disabled:no-underline";
export const smallButton =
	"h-8 rounded-md border border-border px-3 text-sm text-text-primary hover:bg-surface-inset disabled:opacity-50";
export const primaryButton =
	"h-8 rounded-md bg-primary px-3 text-sm font-medium text-white disabled:opacity-50";
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
