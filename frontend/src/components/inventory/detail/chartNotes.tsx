import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import { unitLabel } from "../../../lib/units";
import type { UnitBasis } from "../../../types/inventory";

// Its own module, not part of chartShared: this is a hook, and
// react-refresh/only-export-components reserves component files for components.

/**
 * One always-visible caveat plus an Info toggle for secondary details.
 *
 * `primary` never collapses since it changes how the numbers should be read;
 * `details` sit behind the toggle. Returns the trigger/caveat/panel separately
 * (rather than rendering them) since the trigger lives in the Card header
 * while the notes sit under the plot — they aren't siblings. Falsy detail
 * entries are dropped so callers can inline conditions.
 */
export function useChartNotes({
	primary,
	details,
}: {
	primary: string;
	details?: (string | null | false | undefined)[];
}): { trigger: ReactNode; caveat: ReactNode; panel: ReactNode; notes: ReactNode } {
	const [open, setOpen] = useState(false);
	const panelId = `chart-notes-${useId()}`;
	const lines = (details ?? []).filter((d): d is string => typeof d === "string" && d !== "");

	const trigger =
		lines.length === 0 ? null : (
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				aria-controls={panelId}
				aria-label="How this chart is measured"
				title="How this chart is measured"
				className={`p-1 rounded-md border transition-colors ${
					open
						? "border-border-subtle text-text-primary bg-surface"
						: // A visible-at-rest outline, not fully transparent — a control
							// this consistently present shouldn't only become findable
							// once the user is already hovering it.
							"border-border-subtle text-text-tertiary hover:text-text-primary hover:bg-surface"
				}`}
			>
				<Info size={14} />
			</button>
		);

	// text-tertiary, not text-faint: this line is deliberately kept OUTSIDE the
	// click-to-expand panel because it's important enough to always show —
	// styling it at the lowest-contrast token in the app contradicted that
	// decision.
	const caveat = <p className="mt-3 text-[11px] text-text-tertiary">{primary}</p>;

	const panel =
		open && lines.length > 0 ? (
			<div
				id={panelId}
				className="mt-2 space-y-1 rounded-lg border border-border-subtle bg-surface px-3 py-2"
			>
				{lines.map((line) => (
					<p key={line} className="text-[11px] text-text-faint">
						{line}
					</p>
				))}
			</div>
		) : null;

	const notes = (
		<div>
			{caveat}
			{panel}
		</div>
	);

	return { trigger, caveat, panel, notes };
}

// ── Mixed-unit copy ──────────────────────────────────────────────────────────

/**
 * The one sentence every surface uses when a series spans a unit change.
 * Informational, not an error — the history is intact, it just can't be
 * summed. Units are listed in whatever order `basis` gives them (no
 * chronology tracked), so never render this as "each → box" implying a
 * direction.
 */
export function unitBreakNote(basis: UnitBasis | undefined, subject: string): string | null {
	if (!basis?.mixed) return null;
	const names = basis.units.map((u) => unitLabel(u)).join(", ");
	return `This item's history spans ${basis.units.length} units (${names}), so ${subject} can't be totalled — quantities in different units aren't added together, and nothing here converts between them.`;
}

/** Why the break exists and what to do about it. Belongs behind the Info toggle. */
export const UNIT_BREAK_DETAIL =
	"The unit is recorded on every movement when it happens, so past movements keep the unit they were made in even after the item's unit is changed. Nothing was lost — the totals resume once the whole range shares one unit.";

/**
 * Compact form for table cells/stat tiles where the full sentence doesn't fit.
 * Deliberately not an em dash: `—` already means "no value" in these tables,
 * and a unit break is a different fact from an absent one.
 */
export const UNIT_BREAK_SHORT = "Mixed units";

/**
 * `Mixed units (boxes, units)` — the short label plus what the units actually
 * are, in the same lowercase display words a quantity is rendered with, not the
 * picker's title-case labels.
 */
export function unitBreakShort(basis: UnitBasis | undefined): string | null {
	if (!basis?.mixed) return null;
	return `${UNIT_BREAK_SHORT} (${basis.units.map((u) => unitLabel(u)).join(", ")})`;
}
