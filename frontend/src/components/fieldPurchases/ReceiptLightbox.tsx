import { useEffect, type ReactNode } from "react";
import { RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useDialogA11y } from "../../hooks/useDialogA11y";
import { MAX_SCALE, MIN_SCALE, useImagePanZoom } from "../../hooks/useImagePanZoom";
import { FOCUS_RING } from "./fieldPurchaseFormat";

/**
 * The receipt, big enough to actually read. Shared by the dispatch reviewer, who
 * needs the tax line and the store name off the paper, and by the technician, who
 * is checking what they just photographed against what they typed.
 *
 * Zoom grows the image's layout WIDTH rather than transforming it, so the frame's
 * own scroll is the pan — momentum and rubber-banding included, and nothing to
 * clamp by hand. Rotation stays a caller's prop: in the dispatch viewer the inline
 * card and this sheet share one rotation, and owning it here would break that.
 */
export default function ReceiptLightbox({
	url,
	label,
	rotation,
	onRotate,
	onClose,
}: {
	url: string;
	label: string;
	rotation: number;
	onRotate: () => void;
	onClose: () => void;
}) {
	const { containerRef, scale, stepZoom, handlers } = useImagePanZoom(url);
	const dialogProps = useDialogA11y<HTMLDivElement>(onClose);

	// Captured, not bubbled. The dispatch review panel stays mounted behind this,
	// so an Escape allowed to propagate would close the sheet and act on the panel
	// in one keystroke. Stopping it here also keeps useDialogA11y's own
	// document-level Escape from double-firing.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			onClose();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	// Rotated a quarter turn the long edge is horizontal, so width is no longer
	// what "fit" means.
	const sideways = rotation % 180 !== 0;

	return (
		<div
			{...dialogProps}
			aria-label={label}
			// Above the technician bottom nav, which is fixed at z-50 — at z-50 the
			// nav paints over this sheet's own controls.
			className="fixed inset-0 z-[60] flex flex-col bg-overlay"
		>
			<div
				ref={containerRef}
				{...handlers}
				className="min-h-0 flex-1 overflow-auto overscroll-contain"
			>
				<img
					src={url}
					alt={label}
					style={{
						...(sideways
							? {
									height: `${scale * 100}%`,
									width: "auto",
								}
							: { width: `${scale * 100}%` }),
						transform: `rotate(${rotation}deg)`,
					}}
					className="mx-auto block max-w-none origin-center"
				/>
			</div>

			{/* At the bottom because that is where a thumb is. The sheet covers the
			    bottom nav outright, so the space is free. */}
			<div className="flex items-center justify-between gap-2 border-t border-border bg-base px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
				<Control label="Close" onClick={onClose}>
					<X aria-hidden size={18} />
				</Control>
				<span className="text-xs tabular-nums text-text-tertiary">
					{Math.round(scale * 100)}%
				</span>
				<div className="flex items-center gap-1">
					<Control
						label="Zoom out"
						disabled={scale <= MIN_SCALE + 0.01}
						onClick={() => stepZoom(-1)}
					>
						<ZoomOut aria-hidden size={18} />
					</Control>
					<Control
						label="Zoom in"
						disabled={scale >= MAX_SCALE - 0.01}
						onClick={() => stepZoom(1)}
					>
						<ZoomIn aria-hidden size={18} />
					</Control>
					<Control label="Rotate" onClick={onRotate}>
						<RotateCw aria-hidden size={18} />
					</Control>
				</div>
			</div>
		</div>
	);
}

function Control({
	label,
	onClick,
	disabled,
	children,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			disabled={disabled}
			className={`flex h-11 w-11 items-center justify-center rounded-md text-text-secondary transition-colors duration-150 hover:enabled:bg-surface-raised hover:enabled:text-text-primary disabled:opacity-30 ${FOCUS_RING}`}
		>
			{children}
		</button>
	);
}
