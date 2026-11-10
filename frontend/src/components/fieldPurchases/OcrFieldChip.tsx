import type { ComponentType } from "react";
import { AlertTriangle, Check, CircleSlash, Pencil, Sigma } from "lucide-react";
import type { OcrFieldFlag, OcrFieldKey, OcrFlagKind } from "../../types/fieldPurchases";
import { ocrFlagReason } from "./ocrFlagCopy";
import { useRevealPopover } from "./useRevealPopover";

const KIND: Record<
	OcrFlagKind,
	{ label: string; Icon: ComponentType<{ size?: number }>; tone: string }
> = {
	unsure: {
		label: "Unsure",
		Icon: AlertTriangle,
		tone: "border-warning-border bg-warning-bg text-warning-text",
	},
	calculated: {
		label: "Calculated",
		Icon: Sigma,
		tone: "border-info-border bg-info-bg text-info-text",
	},
	not_found: {
		label: "Not found",
		Icon: CircleSlash,
		tone: "border-border bg-surface-raised text-text-muted",
	},
};

/** The technician reads their own sheet; "by tech" is for the dispatcher reviewing it. */
const RESOLVED = {
	dispatcher: {
		confirmed: {
			label: "Checked by tech",
			Icon: Check,
			reason: "Checked against the photo by the technician.",
		},
		edited: {
			label: "Edited by tech",
			Icon: Pencil,
			reason: "Changed by the technician from the scanned value.",
		},
	},
	technician: {
		confirmed: {
			label: "Checked",
			Icon: Check,
			reason: "You checked this against the photo.",
		},
		edited: {
			label: "Edited",
			Icon: Pencil,
			reason: "You changed this from the scanned value.",
		},
	},
} as const;

/**
 * The reason lives in a hidden span (always in the DOM) for aria-describedby, and
 * in a popover for sighted users. The popover opens on click/tap/Enter/Space, so
 * touch and keyboard get it too; hover alone would shut them out.
 */
export function OcrFieldChip({
	field,
	flag,
	review,
	audience = "dispatcher",
}: {
	field: OcrFieldKey;
	flag: OcrFieldFlag;
	review?: "confirmed" | "edited" | null;
	audience?: "dispatcher" | "technician";
}) {
	const { wrapperRef, popRef, reasonId, open, flip, toggle, hoverHandlers } =
		useRevealPopover();
	const resolved = review ? RESOLVED[audience][review] : null;
	const reason = resolved ? resolved.reason : ocrFlagReason(field, flag);
	const { label, Icon } = resolved ?? KIND[flag.kind];
	const tone = resolved
		? "border-border bg-transparent text-text-muted"
		: KIND[flag.kind].tone;

	return (
		<span ref={wrapperRef} className="relative inline-flex" {...hoverHandlers}>
			<button
				type="button"
				aria-expanded={open}
				aria-describedby={reasonId}
				onClick={toggle}
				className={`inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none transition-colors hover:brightness-125 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary ${tone}`}
			>
				<Icon size={11} />
				{label}
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
