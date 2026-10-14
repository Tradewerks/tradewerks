import { Children, Fragment, isValidElement, useRef } from "react";
import type { ReactNode } from "react";
import RelationCardRow from "./RelationCardRow";
import useColumnBalance from "./useColumnBalance";

/**
 * Counts cards through fragments, the way RelationCardRow does — the pages hand
 * this a fragment of conditionally-rendered cards, and the count drives both the
 * row's column class and the hook's rail-height prediction.
 */
function countCards(children: ReactNode): number {
	return Children.toArray(children).reduce((total: number, child) => {
		if (isValidElement(child) && child.type === Fragment) {
			return total + countCards((child.props as { children?: ReactNode }).children);
		}
		return total + 1;
	}, 0);
}

interface BalancedOverviewGridProps {
	/** Identifies the record, so a new one gets a fresh placement decision. */
	recordId: string;
	infoCard: ReactNode;
	/** The relation cards, which move between columns. */
	block?: ReactNode;
	railCard: ReactNode;
}

/**
 * The Overview tab's terminal two-column block.
 *
 * The relation cards start under the info card and move into the rail when that
 * leaves the two columns closer in height — a long info card otherwise stretches
 * the client card past its content and opens a hole inside it. The decision is
 * measured, not guessed from the record's content; see `useColumnBalance`.
 */
export default function BalancedOverviewGrid({
	recordId,
	infoCard,
	block,
	railCard,
}: BalancedOverviewGridProps) {
	const infoRef = useRef<HTMLDivElement>(null);
	const railRef = useRef<HTMLDivElement>(null);
	const blockRef = useRef<HTMLDivElement>(null);

	const cardCount = countCards(block);
	const { placement, ready } = useColumnBalance({
		recordId,
		cardCount,
		infoRef,
		railRef,
		blockRef,
	});

	const hasBlock = cardCount > 0;
	const inRail = hasBlock && placement === "rail";

	const blockRow = hasBlock ? (
		<div ref={blockRef}>
			{/* A third-width column cannot hold two cards side by side, so in the
			    rail the row stacks rather than shrinking every card to fit. */}
			<RelationCardRow stacked={inRail}>{block}</RelationCardRow>
		</div>
	) : null;

	// Top-aligned until the decision is made, so the hook measures content rather
	// than the stretch its own absorbers apply. One pre-paint frame; the layout
	// effect resolves it before anything is painted.
	return (
		<div
			className={`grid grid-cols-1 lg:grid-cols-3 gap-4${ready ? "" : " items-start"}`}
		>
			<div className="lg:col-span-2 flex flex-col gap-4">
				<div ref={infoRef} className="flex flex-1 flex-col">
					{infoCard}
				</div>
				{!inRail && blockRow}
			</div>
			<div className="lg:col-span-1 flex flex-col gap-4">
				<div ref={railRef} className="flex flex-1 flex-col">
					{railCard}
				</div>
				{inRail && blockRow}
			</div>
		</div>
	);
}
