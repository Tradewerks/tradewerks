import { Children, Fragment, isValidElement } from "react";
import type { ReactNode } from "react";

/**
 * Capped at three. A fourth card wraps to a second row, which is exactly the
 * orphan this component exists to remove — so a fourth relation slot is a
 * layout decision to revisit here, not one to pass through.
 */
const COLUMNS: Record<number, string> = {
	1: "grid-cols-1",
	2: "grid-cols-1 sm:grid-cols-2",
	3: "grid-cols-1 sm:grid-cols-3",
};

// Children.toArray drops null/false branches, but it does not flatten a
// fragment's children — it hands back the <>...</> itself as one opaque
// item. The pages pass fragments of conditionally-rendered cards, so recurse
// into any fragment to count what it actually contains.
function countCards(children: ReactNode): number {
	return Children.toArray(children).reduce((total: number, child) => {
		if (isValidElement(child) && child.type === Fragment) {
			return total + countCards((child.props as { children?: ReactNode }).children);
		}
		return total + 1;
	}, 0);
}

/**
 * The row of relation cards under a detail page's info card, sized so it always
 * occupies exactly one row.
 */
interface RelationCardRowProps {
	children: ReactNode;
	/**
	 * Forces one card per row. Set when the row sits in the third-width rail,
	 * where side-by-side cards are too narrow to read.
	 */
	stacked?: boolean;
}

export default function RelationCardRow({ children, stacked = false }: RelationCardRowProps) {
	const count = countCards(children);

	if (count === 0) {
		return null;
	}

	const columns = stacked ? COLUMNS[1] : (COLUMNS[count] ?? COLUMNS[3]);

	return <div className={`grid gap-4 ${columns}`}>{children}</div>;
}
