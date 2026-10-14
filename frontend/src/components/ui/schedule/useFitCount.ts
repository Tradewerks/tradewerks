import { useLayoutEffect, useState, type RefObject } from "react";
import { computeFitCount } from "./fitCount";

export interface UseFitCountOptions {
	bodyRef: RefObject<HTMLElement | null>;
	itemKeys: string[];
	layoutKey: string;
	gap: number;
	moreRowH: number;
	enabled: boolean;
}

function contentHeight(el: HTMLElement): number {
	const cs = getComputedStyle(el);
	const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
	return Math.max(0, el.getBoundingClientRect().height - pad);
}

/**
 * Measure-then-slice. When the item list or its layout (width, line clamp) changes,
 * `measuring` asks the caller to render every item; a layout effect reads their
 * heights before paint and the caller re-renders with the slice. Height-only resizes
 * reuse cached heights. The body is sized by its parent, never by its children, so
 * slicing cannot re-trigger the ResizeObserver.
 */
export function useFitCount({
	bodyRef,
	itemKeys,
	layoutKey,
	gap,
	moreRowH,
	enabled,
}: UseFitCountOptions): { fit: number; measuring: boolean } {
	const signature = `${layoutKey}::${itemKeys.join("|")}`;
	const [measured, setMeasured] = useState<{ sig: string; heights: number[] } | null>(null);
	const [available, setAvailable] = useState<number | null>(null);
	const measuring = enabled && measured?.sig !== signature;

	useLayoutEffect(() => {
		if (!measuring) return;
		const body = bodyRef.current;
		if (!body) return;
		const heights = Array.from(
			body.querySelectorAll<HTMLElement>(":scope > [data-fit-item]"),
			(el) => el.getBoundingClientRect().height
		);
		setAvailable(contentHeight(body));
		setMeasured({ sig: signature, heights });
	}, [measuring, signature, bodyRef]);

	useLayoutEffect(() => {
		if (!enabled) return;
		const body = bodyRef.current;
		if (!body) return;
		const ro = new ResizeObserver(() => {
			const next = contentHeight(body);
			setAvailable((prev) => (prev === next ? prev : next));
		});
		ro.observe(body);
		return () => ro.disconnect();
	}, [enabled, bodyRef]);

	if (!enabled || measuring || measured === null || available === null) {
		return { fit: itemKeys.length, measuring };
	}
	return {
		fit: computeFitCount(measured.heights, gap, available, moreRowH),
		measuring: false,
	};
}
