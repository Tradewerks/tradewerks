import { useCallback, useLayoutEffect, useState } from "react";

// Space a page keeps clear on its right for the collapsed drawer rail (mr-7).
const RAIL_RESERVE_PX = 28;
// Breathing room between the page content and an open drawer.
const DRAWER_GAP_PX = 16;

/**
 * Collapse state for a DockedPanel. The panel starts open when the
 * layout's side gutter (wide monitors, past the 1920px content cap) can hold it
 * without covering the page; once the user toggles, their choice wins.
 * Measured from the layout scroller's padding, which no page changes.
 */
export function useGutterPanel(openWidthPx: number) {
	const [fits, setFits] = useState(false);
	const [userCollapsed, setUserCollapsed] = useState<boolean | null>(null);

	// Layout effect: measured before paint, so a drawer that fits renders open
	// instead of animating open on load.
	useLayoutEffect(() => {
		const scroller = document.querySelector<HTMLElement>("[data-layout-scroller]");
		if (!scroller) return;
		const update = () => {
			const contentRight =
				scroller.getBoundingClientRect().right -
				parseFloat(getComputedStyle(scroller).paddingRight);
			const free = window.innerWidth - contentRight + RAIL_RESERVE_PX;
			setFits(free >= openWidthPx + DRAWER_GAP_PX);
		};
		update();
		const resize = new ResizeObserver(update);
		resize.observe(scroller);
		return () => resize.disconnect();
	}, [openWidthPx]);

	const isCollapsed = userCollapsed ?? !fits;
	const toggle = useCallback(() => setUserCollapsed(!isCollapsed), [isCollapsed]);

	return { isCollapsed, toggle };
}
