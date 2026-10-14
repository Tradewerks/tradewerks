import { useEffect, useState, type ReactNode } from "react";
import { ImageOff, Maximize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import ReceiptLightbox from "./ReceiptLightbox";
import { FOCUS_RING } from "./fieldPurchaseFormat";

/**
 * Reimbursement has no upstream record of the spend — the photo is the only
 * proof there was one — so the reviewer needs to actually read it: the tax line,
 * the store name, the date printed on the paper. A thumbnail cannot do that.
 */

const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

export default function ReceiptViewer({
	url,
	technicianName,
	onFullscreenChange,
}: {
	url: string | null;
	technicianName: string;
	/** The sheet covers whatever mounted this without unmounting it, so a parent
	 *  with keyboard shortcuts needs to know when to stand them down. */
	onFullscreenChange?: (open: boolean) => void;
}) {
	const [zoom, setZoom] = useState(0);
	const [rotation, setRotation] = useState(0);
	const [full, setFull] = useState(false);

	const openFull = (open: boolean) => {
		setFull(open);
		onFullscreenChange?.(open);
	};

	// A new receipt is a new document; carrying the last one's zoom into it just
	// hides the top of the page, and carrying the open sheet shows one purchase's
	// receipt over another purchase's panel.
	useEffect(() => {
		setZoom(0);
		setRotation(0);
		setFull(false);
		onFullscreenChange?.(false);
	}, [url, onFullscreenChange]);

	// If the panel swaps this out for the "no photo" or pre-purchase state while
	// the sheet is open, this instance unmounts and the url-change effect above
	// never fires again to say the sheet closed — report it on the way out so the
	// panel's shortcuts don't stay dead behind a receipt that is no longer there.
	useEffect(() => {
		return () => onFullscreenChange?.(false);
	}, [onFullscreenChange]);

	if (!url) {
		return (
			<div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-surface px-4 py-10 text-center">
				<ImageOff aria-hidden size={24} className="text-text-faint" />
				<p className="text-sm text-text-muted">
					No receipt image on this one.
				</p>
				<p className="max-w-64 text-xs text-text-tertiary">
					Without the photo the only evidence is what the technician
					typed.
				</p>
			</div>
		);
	}

	const scale = ZOOM_STEPS[zoom]!;

	return (
		<>
			<div className="overflow-hidden rounded-md border border-border bg-surface">
				<div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
					<span className="text-[11px] font-medium tabular-nums text-text-tertiary">
						{Math.round(scale * 100)}%
					</span>
					<div className="flex items-center gap-0.5">
						<IconButton
							label="Zoom out"
							disabled={zoom === 0}
							onClick={() =>
								setZoom((z) => Math.max(0, z - 1))
							}
						>
							<ZoomOut aria-hidden size={14} />
						</IconButton>
						<IconButton
							label="Zoom in"
							disabled={zoom === ZOOM_STEPS.length - 1}
							onClick={() =>
								setZoom((z) =>
									Math.min(
										ZOOM_STEPS.length -
											1,
										z + 1
									)
								)
							}
						>
							<ZoomIn aria-hidden size={14} />
						</IconButton>
						<IconButton
							label="Rotate"
							onClick={() =>
								setRotation((r) => (r + 90) % 360)
							}
						>
							<RotateCw aria-hidden size={14} />
						</IconButton>
						<IconButton
							label="View full screen"
							onClick={() => openFull(true)}
						>
							<Maximize2 aria-hidden size={14} />
						</IconButton>
					</div>
				</div>

				{/* Yields to the viewport while stacked; in its own xl column it has height to spare. */}
				<div className="max-h-[min(26rem,38vh)] overflow-auto bg-base p-2 xl:max-h-[min(34rem,52vh)]">
					<img
						src={url}
						alt={`Receipt from ${technicianName}`}
						style={{
							transform: `rotate(${rotation}deg) scale(${scale})`,
						}}
						className="mx-auto max-w-full origin-center transition-transform duration-150"
					/>
				</div>
			</div>

			{full && (
				<ReceiptLightbox
					url={url}
					label={`Receipt from ${technicianName}`}
					rotation={rotation}
					onRotate={() => setRotation((r) => (r + 90) % 360)}
					onClose={() => openFull(false)}
				/>
			)}
		</>
	);
}

function IconButton({
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
			title={label}
			onClick={onClick}
			disabled={disabled}
			className={`cursor-pointer rounded p-1 text-text-tertiary transition-colors duration-150 hover:enabled:bg-surface-raised hover:enabled:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 ${FOCUS_RING}`}
		>
			{children}
		</button>
	);
}
