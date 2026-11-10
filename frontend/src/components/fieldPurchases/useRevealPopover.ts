import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Hover and pin are separate so leaving a pinned trigger, or tapping on touch (no mouse
 * pointerenter), never toggles the popover twice. Click covers tap, Enter and Space.
 */
export function useRevealPopover() {
	const [hovered, setHovered] = useState(false);
	const [pinned, setPinned] = useState(false);
	const open = hovered || pinned;
	const [flip, setFlip] = useState(false);
	const wrapperRef = useRef<HTMLSpanElement>(null);
	const popRef = useRef<HTMLSpanElement>(null);
	const reasonId = useId();

	useLayoutEffect(() => {
		if (!open) return;
		const wrapper = wrapperRef.current?.getBoundingClientRect();
		const pop = popRef.current?.getBoundingClientRect();
		if (!wrapper || !pop) return;
		const fitsRight = wrapper.left + pop.width <= window.innerWidth - 8;
		const fitsLeft = wrapper.right - pop.width >= 8;
		setFlip(!fitsRight && fitsLeft);
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const close = () => {
			setPinned(false);
			setHovered(false);
		};
		const onDown = (e: PointerEvent) => {
			if (!wrapperRef.current?.contains(e.target as Node)) close();
		};
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return {
		wrapperRef,
		popRef,
		reasonId,
		open,
		flip,
		toggle: () => setPinned((p) => !p),
		hoverHandlers: {
			onPointerEnter: (e: React.PointerEvent) =>
				e.pointerType === "mouse" && setHovered(true),
			onPointerLeave: (e: React.PointerEvent) =>
				e.pointerType === "mouse" && setHovered(false),
		},
	};
}
