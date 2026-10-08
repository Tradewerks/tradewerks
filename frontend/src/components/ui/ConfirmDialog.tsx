import { useEffect, useRef, type ReactNode } from "react";
import { useDialogA11y } from "../../hooks/useDialogA11y";

export interface ConfirmDialogProps {
	open: boolean;
	title: string;
	body: ReactNode;
	confirmLabel: string;
	tone?: "primary" | "destructive";
	pending?: boolean;
	error?: string | null;
	/** May return a promise; the button stays guarded until it settles. */
	onConfirm: () => unknown;
	onCancel: () => void;
}

// Extracted from SerialDetailPage's inline confirm modal — same markup/tokens,
// generalized so any destructive/primary confirm flow can reuse it.
export default function ConfirmDialog({
	open,
	title,
	body,
	confirmLabel,
	tone = "primary",
	pending = false,
	error = null,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	// Synchronous re-entrancy guard — `pending` is whatever async state the
	// caller wires up (usually a mutation's isPending), which can lag a click
	// by a render or two. A fast double-click before that prop updates would
	// otherwise fire onConfirm twice. Reset whenever the caller's own pending
	// state clears (covers retry-after-error, where the dialog stays open) or
	// the dialog closes (covers the normal close-on-success flow).
	const isSubmittingRef = useRef(false);
	useEffect(() => {
		if (!pending) isSubmittingRef.current = false;
	}, [pending]);
	useEffect(() => {
		if (!open) isSubmittingRef.current = false;
	}, [open]);

	const dialogA11y = useDialogA11y<HTMLDivElement>(onCancel, open);

	if (!open) return null;

	const handleConfirmClick = () => {
		if (isSubmittingRef.current || pending) return;
		isSubmittingRef.current = true;
		// Also release when onConfirm settles: one that refuses (e.g. a too-short
		// reason) never makes `pending` go true, so the effect above would not
		// clear the guard and every later click would be ignored.
		void Promise.resolve(onConfirm()).finally(() => {
			isSubmittingRef.current = false;
		});
	};

	return (
		<div className="fixed inset-0 bg-overlay flex items-center justify-center z-50 p-4">
			<div
				{...dialogA11y}
				aria-label={title}
				className="bg-base border border-border rounded-xl p-6 max-w-sm w-full"
			>
				<h3 className="text-lg font-semibold text-text-primary mb-2">
					{title}
				</h3>
				<div className="text-sm text-text-tertiary mb-4">{body}</div>
				{error && <p className="text-sm text-error-text mb-3">{error}</p>}
				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-3 py-1.5 rounded-md border border-border text-sm text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirmClick}
						disabled={pending}
						className={`px-3 py-1.5 rounded-md text-sm font-medium text-on-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
							tone === "destructive"
								? "bg-error hover:enabled:bg-error-strong"
								: "bg-primary hover:enabled:bg-primary-hover"
						}`}
					>
						{pending ? "Working…" : confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
