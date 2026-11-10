import { useCallback, useRef, useState } from "react";

/**
 * Live border-box height of whatever element the returned ref lands on; 0 while
 * nothing is mounted. For fixed bars whose height changes with their content, so
 * the page under them can reserve exactly that much instead of a guessed constant.
 */
export function useMeasuredHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
	const [height, setHeight] = useState(0);
	const observer = useRef<ResizeObserver | null>(null);

	const ref = useCallback((el: T | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!el) {
			setHeight(0);
			return;
		}
		// Measured in the commit, so the first paint already has the right room.
		setHeight(el.getBoundingClientRect().height);
		if (typeof ResizeObserver === "undefined") return;
		observer.current = new ResizeObserver(([entry]) => {
			const box = entry.borderBoxSize?.[0];
			setHeight(box ? box.blockSize : entry.target.getBoundingClientRect().height);
		});
		observer.current.observe(el);
	}, []);

	return [ref, height];
}
