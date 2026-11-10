import { AlertTriangle } from "lucide-react";
import { ocrLineReason } from "./ocrFlagCopy";
import { useRevealPopover } from "./useRevealPopover";

/**
 * A line the reader was unsure of. Same reveal as OcrFieldChip, because a `title`
 * tooltip is invisible to touch and keyboard.
 */
export function OcrLineMark({ confidence }: { confidence: number }) {
	const { wrapperRef, popRef, reasonId, open, flip, toggle, hoverHandlers } =
		useRevealPopover();
	const reason = ocrLineReason(confidence);

	return (
		<span
			ref={wrapperRef}
			className="relative inline-flex align-middle"
			{...hoverHandlers}
		>
			<button
				type="button"
				aria-label="Read with low confidence"
				aria-expanded={open}
				aria-describedby={reasonId}
				onClick={toggle}
				className="inline-flex h-5 w-5 items-center justify-center rounded-full text-warning-text transition-colors hover:bg-warning-bg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
			>
				<AlertTriangle aria-hidden size={12} />
			</button>
			<span id={reasonId} className="sr-only">
				{reason}
			</span>
			{open && (
				<span
					ref={popRef}
					role="tooltip"
					aria-hidden="true"
					className={`absolute ${flip ? "right-0" : "left-0"} top-full z-50 mt-1.5 w-56 max-w-[calc(100vw-2rem)] rounded-md border border-border-strong bg-canvas px-2.5 py-1.5 text-xs font-normal leading-snug text-text-secondary shadow-lg shadow-black/50`}
				>
					{reason}
				</span>
			)}
		</span>
	);
}
