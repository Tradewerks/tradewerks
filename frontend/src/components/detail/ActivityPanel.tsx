import type { ReactNode } from "react";

/**
 * Activity's two-column shell: what a dispatcher READS on the left (the record,
 * then the log), what they WRITE on the right.
 *
 * One layout, no branch. The main column can't come up empty — ChangeHistory
 * always renders its card, filter row and empty state, taller than the rail
 * beside it — so the underfill to guard is an empty rail, which `self-start`
 * answers by letting it end at its own height.
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
			{/* `items-start` is load-bearing rather than tidiness: a stretched
			    grid item has nowhere to move, so the rail's `sticky` would
			    silently do nothing.

			    DOM order is the reading order in both directions — record then
			    rail, left to right at `lg` and top to bottom below it. No
			    `order-*` reshuffle: it would leave the focus order pointing
			    one way and the layout the other. */}
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
				<div className="lg:col-span-2 space-y-4">
					{lifecycle}
					{history}
				</div>
				{/* Sticky only from `lg`, where there is a rail to pin: the
				    scrolling ancestor is DispatchLayout's overflow container,
				    and `top-6` clears the tab strip's own breathing room. */}
				<div className="lg:col-span-1 lg:self-start lg:sticky lg:top-6">
					{notes}
				</div>
			</div>
		</div>
	);
}
