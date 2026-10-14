import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

// DayAgenda's flex gap (gap-0.5).
const GAP = 2;

/** Height inside the padding. jsdom reports "" for padding, hence the `|| 0`. */
function contentHeight(el: HTMLElement): number {
	const cs = getComputedStyle(el);
	return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
}

export interface AgendaOverflow {
	overflowing: boolean;
	below: number;
	pageDown: () => void;
}

function rowsBelow(root: HTMLElement, cut: number): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>("[data-agenda-row]")).filter(
		(r) => r.getBoundingClientRect().bottom > cut + 0.5
	);
}

export function useAgendaOverflow(
	rootRef: RefObject<HTMLElement | null>,
	hintRef: RefObject<HTMLElement | null>,
	signature: string
): AgendaOverflow {
	const [state, setState] = useState({ overflowing: false, below: 0 });

	useLayoutEffect(() => {
		const root = rootRef.current;
		const parent = root?.parentElement;
		if (!root || !parent) return;
		const recount = () => {
			const hint = hintRef.current;
			// Measured without the bar, so it can never cause the overflow it reports.
			const own = hint ? hint.offsetHeight + GAP : 0;
			const overflowing = root.scrollHeight - own > contentHeight(parent) + 0.5;
			const below =
				overflowing && hint ? rowsBelow(root, hint.getBoundingClientRect().top).length : 0;
			setState((p) =>
				p.overflowing === overflowing && p.below === below ? p : { overflowing, below }
			);
		};
		recount();
		parent.addEventListener("scroll", recount, { passive: true });
		const ro = new ResizeObserver(recount);
		ro.observe(parent);
		return () => {
			parent.removeEventListener("scroll", recount);
			ro.disconnect();
		};
		// state.overflowing: re-run once the bar mounts, so the count reads its position.
	}, [signature, state.overflowing, rootRef, hintRef]);

	// Pages the first hidden row to the top of the scroller; scrollBy clamps at the end.
	const pageDown = useCallback(() => {
		const root = rootRef.current;
		const parent = root?.parentElement;
		const hint = hintRef.current;
		if (!root || !parent || !hint) return;
		const next = rowsBelow(root, hint.getBoundingClientRect().top)[0];
		if (!next) return;
		// Tech sort: the group's sticky header would cover a row paged to the very top.
		const header = next
			.closest('[role="group"]')
			?.querySelector<HTMLElement>("[data-agenda-group]");
		const top =
			parent.getBoundingClientRect().top +
			parent.clientTop +
			(parseFloat(getComputedStyle(parent).paddingTop) || 0) +
			(header ? header.offsetHeight + GAP : 0);
		// The bar usually goes invisible at the end; keep focus on what it revealed.
		const refocus = document.activeElement === hint;
		parent.scrollBy({ top: Math.floor(next.getBoundingClientRect().top - top), behavior: "auto" });
		if (refocus) next.focus({ preventScroll: true });
	}, [rootRef, hintRef]);

	return { ...state, pageDown };
}
