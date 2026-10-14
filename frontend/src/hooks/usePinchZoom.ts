import { useEffect, useRef, useState } from "react";
import type { CameraZoomCaps } from "./useCameraStream";

/**
 * Two-finger zoom over a camera preview, with the transient labels that tell a
 * technician whether the pinch did anything. Shared by the barcode scanner and
 * receipt capture — both are a live video the user instinctively pinches.
 */

const INDICATOR_MS = 1000;
const HINT_MS = 1500;

interface UsePinchZoomOptions {
	zoomCaps: CameraZoomCaps | null;
	zoomLevel: number;
	setZoom: (level: number) => void;
	/** Skip while the preview is replaced by a still or an error. */
	enabled?: boolean;
}

function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function usePinchZoom({
	zoomCaps,
	zoomLevel,
	setZoom,
	enabled = true,
}: UsePinchZoomOptions) {
	const containerRef = useRef<HTMLDivElement>(null);
	const pointers = useRef(new Map<number, { x: number; y: number }>());
	const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);
	const [zoomIndicator, setZoomIndicator] = useState<string | null>(null);
	const [pinchHint, setPinchHint] = useState<string | null>(null);
	const indicatorTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hintTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Belt-and-braces: iOS Safari can let a two-finger pinch leak through to page zoom
	// even with touch-action: none, unless touchmove is preventDefault'd non-passively.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = (e: TouchEvent) => {
			if (e.touches.length > 1) e.preventDefault();
		};
		el.addEventListener("touchmove", handler, { passive: false });
		return () => el.removeEventListener("touchmove", handler);
	}, []);

	useEffect(
		() => () => {
			if (indicatorTimeout.current) clearTimeout(indicatorTimeout.current);
			if (hintTimeout.current) clearTimeout(hintTimeout.current);
		},
		[]
	);

	const showZoomIndicator = (level: number) => {
		setZoomIndicator(`${level.toFixed(1)}×`);
		if (indicatorTimeout.current) clearTimeout(indicatorTimeout.current);
		indicatorTimeout.current = setTimeout(() => setZoomIndicator(null), INDICATOR_MS);
	};

	const showPinchHint = () => {
		setPinchHint("Zoom not supported — move the phone closer");
		if (hintTimeout.current) clearTimeout(hintTimeout.current);
		hintTimeout.current = setTimeout(() => setPinchHint(null), HINT_MS);
	};

	const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!enabled) return;
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 2) {
			const [p1, p2] = [...pointers.current.values()];
			pinchStart.current = { dist: pointerDistance(p1, p2), zoom: zoomLevel };
		}
	};

	const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!enabled || !pointers.current.has(e.pointerId)) return;
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 2 && pinchStart.current) {
			if (!zoomCaps) {
				showPinchHint();
				return;
			}
			const [p1, p2] = [...pointers.current.values()];
			const dist = pointerDistance(p1, p2);
			const nextZoom = pinchStart.current.zoom * (dist / pinchStart.current.dist);
			setZoom(nextZoom);
			showZoomIndicator(nextZoom);
		}
	};

	const clearPointer = (e: React.PointerEvent<HTMLDivElement>) => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) pinchStart.current = null;
	};

	return {
		containerRef,
		zoomIndicator,
		pinchHint,
		pinchHandlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp: clearPointer,
			onPointerCancel: clearPointer,
		},
	};
}
