import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export type ColumnPlacement = "main" | "rail";

export interface ColumnBalance {
	placement: ColumnPlacement;
	/**
	 * False until the decision is made. While false the grid must stay
	 * top-aligned: the cards stretch to fill their cells, so a stretched rail
	 * reports the main column's height back and every record measures as
	 * perfectly balanced — the hook would be reading its own absorbers instead
	 * of the content.
	 */
	ready: boolean;
}

/** `gap-4` between stacked cards, in px. */
const GAP = 16;

/**
 * How much taller the same cards run in the rail, which is a third of the grid
 * rather than two thirds: titles and subtitles wrap where they did not before.
 * Measured against the seeded records, not derived — a card that wraps harder on
 * some record only costs a placement that is a little off, never a broken layout.
 */
const RAIL_WRAP = 1.25;

/**
 * A move has to be worth making. The block is wider in the main column and wraps
 * in the rail, so a marginal predicted gain sits inside the prediction's own
 * error — acting on it swaps the layout for nothing.
 */
const HYSTERESIS = 40;

const DESKTOP = "(min-width: 1024px)";

interface ColumnBalanceOptions {
	/** Latch key: a new record gets a fresh decision, a re-render does not. */
	recordId: string;
	/** Cards in the movable block — a row in main, stacked in the rail. */
	cardCount: number;
	infoRef: RefObject<HTMLElement | null>;
	railRef: RefObject<HTMLElement | null>;
	blockRef: RefObject<HTMLElement | null>;
}

/**
 * Which column the movable relation block should sit in, decided by measuring
 * the two columns rather than guessing from content.
 *
 * The block is what makes this hard: moving it changes both heights that decided
 * the move, so a hook that re-measures freely flip-flops forever. Two guards
 * prevent that — the prediction is built from the three pieces measured
 * SEPARATELY (info card, client card, block) rather than from the column totals
 * the move would invalidate, and the answer is latched per record so a
 * ResizeObserver firing after the move cannot re-open the question.
 */
export default function useColumnBalance({
	recordId,
	cardCount,
	infoRef,
	railRef,
	blockRef,
}: ColumnBalanceOptions): ColumnBalance {
	const [placement, setPlacement] = useState<ColumnPlacement>("main");
	const [ready, setReady] = useState(false);
	// The record + breakpoint this placement was decided for. Null means the
	// question is still open — a layout we could not measure never spends it.
	const latch = useRef<string | null>(null);
	const placementRef = useRef<ColumnPlacement>("main");

	const decide = useCallback(() => {
		const isDesktop = window.matchMedia(DESKTOP).matches;
		const key = `${recordId}:${isDesktop}`;

		// Below lg the columns stack, so there is no pair to balance.
		if (!isDesktop) {
			latch.current = key;
			placementRef.current = "main";
			setPlacement("main");
			setReady(true);
			return;
		}

		if (latch.current === key) return;

		const info = infoRef.current?.getBoundingClientRect().height ?? 0;
		const rail = railRef.current?.getBoundingClientRect().height ?? 0;
		const block = blockRef.current?.getBoundingClientRect().height ?? 0;

		// Data lands after mount, so the first pass measures nothing. Leaving the
		// latch unspent means the observer gets to ask again once it can answer.
		if (info <= 0 || rail <= 0 || block <= 0) return;

		// Normalise the block to both widths: it was measured wherever it
		// currently sits, and the two columns are not the same width.
		const stacked = (row: number) => cardCount * row * RAIL_WRAP + (cardCount - 1) * GAP;
		const rowHeight =
			placementRef.current === "main"
				? block
				: (block - (cardCount - 1) * GAP) / (cardCount * RAIL_WRAP);

		const deltaMain = Math.abs(info + GAP + rowHeight - rail);
		const deltaRail = Math.abs(info - (rail + GAP + stacked(rowHeight)));

		const next: ColumnPlacement = deltaRail + HYSTERESIS < deltaMain ? "rail" : "main";

		latch.current = key;
		placementRef.current = next;
		setPlacement(next);
		setReady(true);
	}, [recordId, cardCount, infoRef, railRef, blockRef]);

	// A different record is a different question, so the latch reopens and the
	// block starts back in the main column.
	useLayoutEffect(() => {
		latch.current = null;
		placementRef.current = "main";
		setPlacement("main");
		setReady(false);
	}, [recordId]);

	// Layout effect, not effect: the decision lands before paint, so the block
	// does not visibly jump from one column to the other on load.
	useLayoutEffect(() => {
		decide();
	});

	useEffect(() => {
		const observer = new ResizeObserver(() => decide());
		const observed = [infoRef.current, railRef.current].filter(Boolean) as HTMLElement[];
		observed.forEach((el) => observer.observe(el));

		// Crossing the lg boundary is the one width change that changes the
		// answer; anything narrower is a single stacked column either way.
		const query = window.matchMedia(DESKTOP);
		const onBreakpoint = () => {
			latch.current = null;
			decide();
		};
		query.addEventListener?.("change", onBreakpoint);

		return () => {
			observer.disconnect();
			query.removeEventListener?.("change", onBreakpoint);
		};
	}, [decide, infoRef, railRef]);

	return { placement, ready };
}
