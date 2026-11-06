import type { ReactNode } from "react";

/**
 * Activity's two-column shell: what a dispatcher READS on the left (the record,
 * then the log), what they WRITE on the right.
 *
 * One layout, no branch. Both columns end on one bottom line at `lg`: the main
 * column sets the row height, and its last card stretches into any extra.
 * The rail's `contain-size` stops its content (many notes) from growing the
 * row, so the rail scrolls internally instead; `min-h-104` is its floor, and
 * the main column stretches up to it when shorter. Sticky was dropped on
 * purpose (spec 2026-10-27-activity-tab-flat-bottom).
 */
interface ActivityPanelProps {
	/** The write surface. Rides the rail. */
	notes: ReactNode;
	/** May render null: LifecycleRecord does when there is nothing to record. */
	lifecycle: ReactNode;
	history: ReactNode;
}

export default function ActivityPanel({ notes, lifecycle, history }: ActivityPanelProps) {
	return (
		<div
			role="tabpanel"
			id="tabpanel-activity"
			aria-labelledby="tab-activity"
			className="mt-6"
		>
			<h2 className="sr-only">Activity</h2>
			{/* DOM order is the reading order in both directions — record then
			    rail, left to right at `lg` and top to bottom below it. No
			    `order-*` reshuffle: it would leave the focus order pointing
			    one way and the layout the other. */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
				<div className="lg:col-span-2 flex flex-col gap-4 [&>:last-child]:flex-1">
					{lifecycle}
					{history}
				</div>
				{/* Its only child gets a definite height at `lg` (`h-full`), so a
				    card there fills the row without ever sizing it. */}
				<div className="lg:col-span-1 lg:contain-size lg:min-h-104 lg:[&>*]:h-full">
					{notes}
				</div>
			</div>
		</div>
	);
}
