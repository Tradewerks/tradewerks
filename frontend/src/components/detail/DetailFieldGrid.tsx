import type { ReactNode } from "react";

export interface DetailField {
	label: string;
	value: ReactNode;
	/** Tones the value only. */
	tone?: "error" | "warning";
}

interface DetailFieldGridProps {
	/** Long-form content, full width above the pairs, rendered bare. */
	lead?: ReactNode;
	fields: DetailField[];
	/**
	 * Distributes the lead and the field list to the card's top and base rather
	 * than stacking both at the top. For a card whose grid cell is stretched
	 * past its content: the slack becomes the gutter between two zones instead
	 * of a hole beneath them.
	 */
	fill?: boolean;
}

const TONE_CLASSES: Record<NonNullable<DetailField["tone"]>, string> = {
	error: "text-error-text",
	warning: "text-warning-text",
};

/**
 * A card's short fields as label-left / value-right pairs, two per row. Pairs
 * rather than three columns, which leave a dead cell whenever the field count
 * isn't a multiple of three.
 *
 * Real dl/dt/dd, so a screen reader hears the pairing and a field name doesn't
 * consume a heading level. `tabular-nums` on every value, not just numeric
 * ones: it touches digits only, and it's the digits inside mixed values (a
 * street number, a date) that otherwise refuse to line up.
 */
export default function DetailFieldGrid({ lead, fields, fill = false }: DetailFieldGridProps) {
	return (
		<div className={fill ? "flex flex-1 flex-col justify-between gap-4" : "space-y-4"}>
			{lead}
			{fields.length > 0 && (
				<dl
					className={`grid gap-x-8 gap-y-2.5 sm:grid-cols-2 ${
						lead ? "border-t border-border-subtle pt-4" : ""
					}`}
				>
					{fields.map((field) => (
						<div
							key={field.label}
							className="grid grid-cols-[minmax(96px,auto)_1fr] gap-3"
						>
							<dt className="text-sm text-text-tertiary">
								{field.label}
							</dt>
							<dd
								className={`min-w-0 break-words text-sm tabular-nums ${
									field.tone
										? TONE_CLASSES[
												field
													.tone
											]
										: "text-text-primary"
								}`}
							>
								{field.value}
							</dd>
						</div>
					))}
				</dl>
			)}
		</div>
	);
}
