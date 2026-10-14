import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Zoom for a still image, as distinct from `usePinchZoom` — that one drives a
 * camera track's own zoom constraint and has no scale to give. Here the image's
 * layout width is what grows, so the container's native scroll IS the pan:
 * momentum, rubber-banding and scrollbars all come free, and only a two-finger
 * gesture has to be intercepted.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 6;
/** What one double-tap is worth — enough to read receipt small print at arm's length. */
export const DOUBLE_TAP_SCALE = 2.5;
const ZOOM_STOPS = [1, 1.5, 2.5, 4, 6] as const;

const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP = 24;

export interface ImagePanZoom {
	containerRef: React.RefObject<HTMLDivElement | null>;
	scale: number;
	zoomTo: (next: number) => void;
	stepZoom: (direction: 1 | -1) => void;
	handlers: {
		onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
		onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
	};
}

const clamp = (n: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
	Math.hypot(a.x - b.x, a.y - b.y);

export function useImagePanZoom(resetKey: string | null): ImagePanZoom {
	const containerRef = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(MIN_SCALE);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinchStart = useRef<{ dist: number; scale: number } | null>(null);
	const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

	useEffect(() => setScale(MIN_SCALE), [resetKey]);

	// iOS Safari lets a two-finger pinch reach page zoom unless touchmove is
	// preventDefault'd non-passively. Registered by hand for that reason — React's
	// own touchmove is passive and cannot cancel.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const onTouchMove = (e: TouchEvent) => {
			if (e.touches.length > 1) e.preventDefault();
		};
		el.addEventListener("touchmove", onTouchMove, { passive: false });
		return () => el.removeEventListener("touchmove", onTouchMove);
	}, []);

	const zoomTo = useCallback((next: number) => setScale(clamp(next)), []);

	const stepZoom = useCallback((direction: 1 | -1) => {
		setScale((current) => {
			const stops = direction === 1 ? ZOOM_STOPS : [...ZOOM_STOPS].reverse();
			return (
				stops.find((s) =>
					direction === 1 ? s > current + 0.01 : s < current - 0.01
				) ?? current
			);
		});
	}, []);

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 2) {
			const [p1, p2] = [...pointers.current.values()];
			pinchStart.current = { dist: distance(p1!, p2!), scale };
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!pointers.current.has(e.pointerId)) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size !== 2 || !pinchStart.current) return;
		const [p1, p2] = [...pointers.current.values()];
		const dist = distance(p1!, p2!);
		setScale(clamp(pinchStart.current.scale * (dist / pinchStart.current.dist)));
	};

	const release = (e: React.PointerEvent<HTMLDivElement>) => {
		const was = pointers.current.size;
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) pinchStart.current = null;
		// Only a lone finger lifting is a tap; the second finger of a pinch is not.
		if (was !== 1) {
			lastTap.current = null;
			return;
		}
		const now = Date.now();
		const prev = lastTap.current;
		if (
			prev &&
			now - prev.t < DOUBLE_TAP_MS &&
			distance(prev, { x: e.clientX, y: e.clientY }) < DOUBLE_TAP_SLOP
		) {
			lastTap.current = null;
			setScale((s) => (s > MIN_SCALE + 0.01 ? MIN_SCALE : DOUBLE_TAP_SCALE));
			return;
		}
		lastTap.current = { t: now, x: e.clientX, y: e.clientY };
	};

	const cancel = (e: React.PointerEvent<HTMLDivElement>) => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) pinchStart.current = null;
		lastTap.current = null;
	};

	return {
		containerRef,
		scale,
		zoomTo,
		stepZoom,
		handlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp: release,
			onPointerCancel: cancel,
		},
	};
}
