import { useState } from "react";
import { AlertTriangle, X, Loader2 } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import ReasonField from "../ui/ReasonField";
import { useRejectQuoteMutation, useCancelQuoteMutation } from "../../hooks/useQuotes";
import { errorMessage } from "../../util/util";

interface QuoteReasonModalProps {
	/** Passed straight through to FullPopup's `isModalOpen` — stays mounted while
	 *  closed so FullPopup's 300ms close fade can play, matching DisputeModal and
	 *  every other FullPopup consumer in the app. Do not conditionally mount this
	 *  component instead. */
	isOpen: boolean;
	quoteId: string;
	/** Rejected means the client declined. Cancelled means we withdrew it — the
	 *  funnel counts both as lost, but they are different sales facts, so this
	 *  modal never collapses them into one action; the caller picks the mode. */
	mode: "reject" | "cancel";
	onClose: () => void;
}

/**
 * Reject and Cancel both capture a required reason before hitting their own
 * endpoint (`/quotes/:id/reject` vs `/quotes/:id/cancel`). This mirrors
 * DisputeModal's shape (same ReasonField, same header/footer chrome) so all
 * three "capture a reason" actions on the quote page read as one family.
 */
export default function QuoteReasonModal({ isOpen, quoteId, mode, onClose }: QuoteReasonModalProps) {
	const [reason, setReason] = useState("");

	const rejectMutation = useRejectQuoteMutation();
	const cancelMutation = useCancelQuoteMutation();
	const mutation = mode === "reject" ? rejectMutation : cancelMutation;

	// The shared helper reads the { error: { message } } envelope, where the
	// reject/cancel endpoints put a worded refusal, and falls back to a
	// friendly line for a network drop or an envelope-less 5xx.
	const errorText = mutation.error
		? errorMessage(mutation.error, "Something went wrong. Please try again.")
		: undefined;

	const reasonIsEmpty = reason.trim().length === 0;
	const submitDisabled = reasonIsEmpty || mutation.isPending;

	const title = mode === "reject" ? "Mark as Rejected" : "Cancel Quote";
	const placeholder =
		mode === "reject"
			? "Why did the client decline this quote?"
			: "Why is this quote being withdrawn?";

	const handleClose = () => {
		setReason("");
		// DW-68: without this a stale error banner from the last attempt is
		// pre-rendered on the next open. DisputeModal already does this.
		rejectMutation.reset();
		cancelMutation.reset();
		onClose();
	};

	const handleSubmit = () => {
		if (reasonIsEmpty) return;
		if (mode === "reject") {
			rejectMutation.mutate(
				{ id: quoteId, rejectionReason: reason.trim() },
				{ onSuccess: handleClose },
			);
		} else {
			cancelMutation.mutate(
				{ id: quoteId, reason: reason.trim() },
				{ onSuccess: handleClose },
			);
		}
	};

	const content = (
		<div className="flex flex-col">
			{/* Header */}
			<div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
				<div className="flex items-center gap-2">
					<AlertTriangle size={18} className="text-warning-text" />
					<h2 className="text-base font-semibold text-primary">{title}</h2>
				</div>
				<button
					onClick={handleClose}
					className="p-1.5 hover:bg-surface rounded-md transition-colors duration-150 ease-out text-text-tertiary hover:text-text-primary"
				>
					<X size={16} />
				</button>
			</div>

			{/* Body */}
			<div className="px-6 py-5 space-y-5 overflow-y-auto">
				<ReasonField value={reason} onChange={setReason} placeholder={placeholder} />

				{errorText && (
					<div className="flex items-center gap-2 p-3 bg-error/10 border border-error/20 rounded-md">
						<AlertTriangle size={14} className="text-error-text flex-shrink-0" />
						<p className="text-sm text-error-text">{errorText}</p>
					</div>
				)}
			</div>

			{/* Footer */}
			<div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-border-subtle">
				<button
					onClick={handleClose}
					disabled={mutation.isPending}
					className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-surface rounded-md transition-colors duration-150 ease-out disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					onClick={handleSubmit}
					disabled={submitDisabled}
					className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary-hover hover:bg-primary disabled:opacity-50 disabled:cursor-not-allowed text-on-primary rounded-md transition-colors duration-150 ease-out"
				>
					{mutation.isPending && <Loader2 size={14} className="animate-spin" />}
					{title}
				</button>
			</div>
		</div>
	);

	return <FullPopup content={content} isModalOpen={isOpen} onClose={handleClose} size="md" />;
}
